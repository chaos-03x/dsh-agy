/**
 * dsh-agy CLI: login / status / import / verify / logout.
 * Standalone bin — the dsh launcher has no plugin subcommand slot, and the
 * remote paste-blob flow must run on machines without a harness.
 */

import { Command } from 'commander'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { authorizeAntigravity } from '../oauth/authorize.ts'
import { exchangeAntigravity } from '../oauth/exchange.ts'
import { encodeCredentialBlob } from '../oauth/blob.ts'
import { AGY_DEFAULT_REDIRECT_URI } from '../oauth/constants.ts'
import { createAesGcmCodec, deriveKey, loadMasterKey, resolveDshHome, resolveMasterKeyCodec } from '../store/keyring.ts'
import type { SecretCodec } from '../store/keyring.ts'
import { JsonAccountStore, maskProxyUrl } from '../store/accounts.ts'
import { AgySessionManager } from '../session.ts'
import { isAgyDisabled } from '../runtime/risk.ts'
import { startCallbackServer, openBrowser } from './callback-server.ts'
import { importManySources, upsertImportedAccount } from './import.ts'
import { accountFetch, isProxyReachable, normalizeProxyUrl } from '../proxy.ts'

/** Package version, read from the shipped package.json — never hard-coded twice. */
const { version: PACKAGE_VERSION } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }

function createStore(options: { readOnly?: boolean } = {}): JsonAccountStore {
  const dshHome = resolveDshHome()
  let codec: SecretCodec
  if (options.readOnly) {
    // Read-only commands must never create the master key or the credentials
    // document: they would fail for no reason on a read-only HOME and write
    // files nobody asked for anywhere else.
    const masterKey = loadMasterKey(dshHome)
    if (!masterKey) {
      throw new Error('No agy account store found — run `dsh-agy login` first.')
    }
    codec = createAesGcmCodec(deriveKey(masterKey))
  } else {
    codec = resolveMasterKeyCodec(dshHome).codec
  }
  return new JsonAccountStore({ file: `${dshHome}/agy-accounts.json`, codec })
}

/** Read-only store with a friendly error when no credentials exist yet. */
function createReadOnlyStoreOrExit(): JsonAccountStore {
  try {
    return createStore({ readOnly: true })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function resolveProxyOption(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (!raw.trim()) return ''
  try {
    return normalizeProxyUrl(raw)
  } catch (error) {
    console.error(`Invalid proxy URL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

/** Remote/SSH sessions cannot reach a local browser; auto-select headless paste. */
function isRemoteSession(): boolean {
  return !!(process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY)
}

async function loginCommand(options: { headless: boolean; blob: boolean; port: number; project?: string; timeout?: string; proxy?: string }) {
  const proxyInput = resolveProxyOption(options.proxy)
  // proxy "" sentinel means clear; normalizeProxyUrl already handled
  const normalizedProxy = proxyInput === '' ? '' : proxyInput
  const store = createStore()
  const redirectUri = `http://localhost:${options.port}/oauth-callback`
  if (!options.headless && isRemoteSession()) {
    console.log('(SSH session detected — using headless paste flow; pass --headless explicitly to force)')
    options.headless = true
  }

  let callback: Awaited<ReturnType<typeof startCallbackServer>> | undefined
  if (!options.headless) {
    // Bind the loopback listener BEFORE the URL is shown: a local process
    // squatting on the fixed port could otherwise capture code+state (the
    // state carries the PKCE verifier) and steal the refresh token.
    callback = startCallbackServer({ port: options.port, timeoutMs: Number(options.timeout) || 300_000 })
    try {
      await callback.ready
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
  }

  const { url, verifier } = await authorizeAntigravity(redirectUri, options.project ?? '')
  console.log(`\nOpen this URL in a browser to authorize:\n\n  ${url}\n`)

  let code: string
  let state: string

  if (options.headless) {
    const pasted = await ask('After approving, paste the full redirected URL here: ')
    const parsed = new URL(pasted)
    code = parsed.searchParams.get('code') ?? ''
    state = parsed.searchParams.get('state') ?? ''
    if (!code || !state) {
      console.error('Error: pasted URL is missing code or state.')
      process.exit(1)
    }
  } else {
    const opened = await openBrowser(url)
    if (!opened) console.log('(Could not open a browser automatically — open the URL manually.)')
    let callbackResult: { code: string; state: string; url: string }
    try {
      callbackResult = await callback!.result
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    }
    code = callbackResult.code
    state = callbackResult.state
  }

  // Bind the exchange to the verifier we issued: a state from any other login
  // (pasted from another session, or fabricated) must be rejected.
  // Route the exchange over the proxy being bound: it targets Google (never the
  // loopback callback, which is forced direct), and leaving it unproxied would
  // leak the host's real IP at exactly the moment the user asked to isolate it.
  const result = await exchangeAntigravity(code, state, redirectUri, verifier, {
    ...(normalizedProxy ? { proxyUrl: normalizedProxy } : {}),
  })
  if (result.type === 'failed') {
    console.error(`Login failed: ${result.error}`)
    process.exit(1)
  }

  if (options.blob) {
    if (normalizedProxy !== undefined) {
      console.log('(Note: --proxy is ignored with --blob; proxy is only stored with the account)')
    }
    const blob = encodeCredentialBlob('agy', {
      access_token: result.access,
      refresh_token: result.refresh.split('|')[0],
      expires_in: Math.max(0, Math.round((result.expires - Date.now()) / 1000)),
    })
    console.log(`\nPaste this blob into the remote dashboard/CLI:\n\n${blob}\n`)
  } else {
    const proxyForUpsert = normalizedProxy !== undefined ? normalizedProxy : undefined
    const { account, created } = await upsertImportedAccount(store, {
      accessToken: result.access,
      refreshToken: result.refresh.split('|')[0]!,
      tokenType: 'Bearer',
      expiresAt: new Date(result.expires).toISOString(),
      authMethod: 'oauth',
      email: result.email ?? null,
      projectId: result.projectId || null,
      clientId: result.clientId || null,
    }, { overwriteExisting: true, ...(proxyForUpsert !== undefined ? { proxy: proxyForUpsert } : {}) })
    const masked = maskProxyUrl(account.proxy)
    console.log(`${created ? 'Added' : 'Updated'} account: ${account.email ?? '(no email)'} (project: ${result.projectId || 'default'})${masked ? ` proxy: ${masked}` : ''}`)
  }

  await callback?.close()
}

async function statusCommand() {
  const store = createReadOnlyStoreOrExit()
  const storage = await store.load()
  if (storage.accounts.length === 0) {
    console.log('No agy accounts. Run `dsh-agy login` first.')
    return
  }
  console.log(`\n${storage.accounts.length} account(s), active index ${storage.activeIndex}:\n`)
  const sessions = new AgySessionManager({ store })
  for (const [index, account] of storage.accounts.entries()) {
    const marker = index === storage.activeIndex ? '★' : ' '
    const state = account.enabled === false ? 'disabled'
      : account.verificationRequired ? 'verification-required'
      : account.coolingDownUntil && account.coolingDownUntil > Date.now() ? 'cooling'
      : 'active'
    const maskedProxy = maskProxyUrl(account.proxy)
    console.log(` ${marker} [${index}] ${account.email ?? '(no email)'} — ${state}${account.projectId ? ` (project: ${account.projectId})` : ''}${maskedProxy ? ` proxy: ${maskedProxy}` : ''}`)

    // Best-effort quota summary via fetchAvailableModels (fresh access token).
    const session = await (typeof sessions.getSessionForIndex === 'function'
      ? sessions.getSessionForIndex(index)
      : sessions.getSession()
    ).catch(() => undefined)
    if (session) {
      try {
        const { fetchAvailableModels } = await import('../adapter/models.ts')
        // Account-scoped: route through the account's proxy so a status check
        // never reveals the host's real IP for a proxied account.
        const timeoutMs = AgySessionManager.QUOTA_FETCH_TIMEOUT_MS ?? 3_000
        const discovered = await fetchAvailableModels(
          session.auth.access,
          session.account.projectId,
          (input, init) => {
            const timeout = AbortSignal.timeout(timeoutMs)
            const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
            return accountFetch({ proxyUrl: session.account.proxy })(input, { ...init, signal })
          },
        )
        const entries = Object.entries(discovered.models ?? {})
        if (entries.length > 0) {
          const withQuota = entries
            .map(([id, entry]) => ({ id, ...entry.quotaInfo }))
            .filter((e) => typeof e.remainingFraction === 'number')
            .sort((a, b) => (a.remainingFraction ?? 0) - (b.remainingFraction ?? 0))
          if (withQuota.length > 0) {
            const lowest = withQuota[0]!
            console.log(`       models: ${entries.length}, lowest quota: ${Math.round((lowest.remainingFraction ?? 0) * 100)}% (${lowest.id})${lowest.resetTime ? `, resets ${new Date(lowest.resetTime).toISOString()}` : ''}`)
          } else {
            console.log(`       models: ${entries.length} (no per-model quota reported)`)
          }
        }
      } catch (error) {
        console.log(`       quota: unavailable (${error instanceof Error ? error.message : String(error)})`)
      }
    }
  }
}

async function importCommand(options: { blob: boolean; files?: string[]; email?: string; overwrite: boolean; proxy?: string }) {
  const store = createStore()
  const proxyForUpsert = resolveProxyOption(options.proxy)
  let items: Array<{ source: unknown; kind: 'json' | 'blob' }>
  if (options.files && options.files.length > 0) {
    items = options.files.map((file) => {
      const raw = readFileSync(file, 'utf8')
      return { source: options.blob ? raw : (JSON.parse(raw) as unknown), kind: options.blob ? 'blob' : 'json' }
    })
  } else {
    const pasted = await ask('Paste the agy token JSON (or blob with --blob): ')
    items = [{ source: pasted, kind: options.blob ? 'blob' : 'json' }]
  }
  const importOpts: { email?: string; overwriteExisting?: boolean; proxy?: string } = {
    email: options.email,
    overwriteExisting: options.overwrite,
  }
  if (proxyForUpsert !== undefined) importOpts.proxy = proxyForUpsert
  const result = await importManySources(items, store, importOpts)
  console.log(`Imported ${result.imported}, replaced ${result.replaced}${result.errors.length > 0 ? `, ${result.errors.length} failed` : ''}`)
  for (const error of result.errors) console.log(`  ! ${error}`)
}

async function exportCommand(options: { index?: string; out?: string }) {
  const store = createReadOnlyStoreOrExit()
  const sessions = new AgySessionManager({ store })
  const storage = await store.load()
  const indices = options.index !== undefined
    ? [Number(options.index)]
    : storage.accounts.map((_, i) => i)

  let exported = 0
  for (const index of indices) {
    const account = storage.accounts[index]
    if (!account) {
      console.log(`[${index}] not found`)
      continue
    }
    const result = await sessions.exportBlob(index)
    if (!result.blob) {
      console.log(`[${index}] ${account.email ?? ''} — FAILED: ${result.error}`)
      continue
    }
    if (options.out) {
      const file = join(options.out, `dsh-agy-${index}.blob`)
      writeFileSync(file, result.blob + '\n')
      console.log(`[${index}] ${account.email ?? ''} — wrote ${file}`)
    } else {
      console.log(result.blob)
    }
    exported++
  }
  if (!options.out) console.log(`\n${exported} blob(s) exported — one line each, paste into a remote import`)
}

async function verifyCommand(options: { index?: string }) {
  const store = createReadOnlyStoreOrExit()
  const sessions = new AgySessionManager({ store })
  const storage = await store.load()
  const indices = options.index !== undefined
    ? [Number(options.index)]
    : storage.accounts.map((_, i) => i)

  for (const index of indices) {
    const account = storage.accounts[index]
    if (!account) {
      console.log(`[${index}] not found`)
      continue
    }
    const result = await sessions.verifyAccount(index)
    if (result.ok) {
      console.log(`[${index}] ${account.email ?? ''} — OK${result.email && result.email !== account.email ? ` (userinfo: ${result.email})` : ''}`)
    } else {
      console.log(`[${index}] ${account.email ?? ''} — FAILED: ${result.error}`)
    }
  }
}

async function healthCommand(options: { interval?: string; index?: string[] }) {
  const store = createReadOnlyStoreOrExit()
  const sessions = new AgySessionManager({
    store,
    onHealthReport: (results) => {
      for (const result of results) {
        if (result.ok) console.log(`[${result.index}] ${result.email ?? ''} — OK`)
        else console.log(`[${result.index}] ${result.email ?? ''} — FAILED: ${result.error}`)
      }
    },
  })
  const indices = options.index?.map((value) => Number(value))

  if (options.interval) {
    const intervalMs = Number(options.interval)
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      console.error('Error: --interval must be a positive number of milliseconds.')
      process.exit(1)
    }
    console.log(`Health probe every ${intervalMs}ms (Ctrl+C to stop).`)
    sessions.startHealthProbe(intervalMs, { unref: false })
    await new Promise<void>(() => {}) // keep the loop alive
    return
  }

  const results = await sessions.checkAccounts(indices)
  if (results.length === 0) console.log('No enabled accounts — run `dsh-agy login` first.')
}

async function logoutCommand(options: { index?: string; email?: string }) {
  const store = createReadOnlyStoreOrExit()
  await store.mutate((storage) => {
    const index = options.index !== undefined
      ? Number(options.index)
      : options.email
        ? storage.accounts.findIndex((a) => a.email?.toLowerCase() === options.email!.toLowerCase())
        : storage.activeIndex
    if (index < 0 || index >= storage.accounts.length) {
      throw new Error(`account not found (index ${index})`)
    }
    const [removed] = storage.accounts.splice(index, 1)
    if (storage.activeIndex >= storage.accounts.length) storage.activeIndex = 0
    console.log(`Removed account: ${removed?.email ?? `[${index}]`}`)
  })
}

async function proxySetCommand(options: { index: string; proxy: string }) {
  const idx = Number(options.index)
  if (!Number.isInteger(idx) || idx < 0) {
    console.error('Invalid --index (must be >= 0)')
    process.exit(1)
  }
  const raw = options.proxy ?? ''
  if (!raw.trim()) {
    console.error('Missing --proxy value')
    process.exit(1)
  }
  let normalized: string
  try {
    normalized = normalizeProxyUrl(raw)
  } catch (error) {
    console.error(`Invalid proxy URL: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  const store = createStore()
  await store.mutate((storage) => {
    const account = storage.accounts[idx]
    if (!account) throw new Error(`account not found (index ${idx})`)
    account.proxy = normalized
  })
  console.log(`[${idx}] proxy set to ${maskProxyUrl(normalized)}`)
}

async function proxyClearCommand(options: { index: string }) {
  const idx = Number(options.index)
  if (!Number.isInteger(idx) || idx < 0) {
    console.error('Invalid --index (must be >= 0)')
    process.exit(1)
  }
  const store = createStore()
  await store.mutate((storage) => {
    const account = storage.accounts[idx]
    if (!account) throw new Error(`account not found (index ${idx})`)
    delete (account as { proxy?: string }).proxy
  })
  console.log(`[${idx}] proxy cleared`)
}

async function proxyTestCommand(options: { index: string }) {
  const idx = Number(options.index)
  if (!Number.isInteger(idx) || idx < 0) {
    console.error('Invalid --index (must be >= 0)')
    process.exit(1)
  }
  const store = createReadOnlyStoreOrExit()
  const storage = await store.load()
  const account = storage.accounts[idx]
  if (!account) {
    console.error(`account not found (index ${idx})`)
    process.exit(1)
  }
  if (!account.proxy) {
    console.log(`[${idx}] no proxy configured`)
    return
  }
  const masked = maskProxyUrl(account.proxy)
  const reachable = await isProxyReachable(account.proxy)
  if (reachable) console.log(`[${idx}] ${masked} — ok`)
  else console.log(`[${idx}] ${masked} — proxy_unreachable`)
}

async function proxyListCommand() {
  const store = createReadOnlyStoreOrExit()
  const storage = await store.load()
  if (storage.accounts.length === 0) {
    console.log('No agy accounts.')
    return
  }
  for (const [index, account] of storage.accounts.entries()) {
    const masked = maskProxyUrl(account.proxy)
    console.log(` [${index}] ${account.email ?? '(no email)'} — ${masked ?? '(no proxy)'}`)
  }
}

export function createProgram(): Command {
  const program = new Command()
  program
    .name('dsh-agy')
    .description('Google Antigravity (agy) account management for DeepSeek Harness')
    .version(PACKAGE_VERSION)

  program.hook('preAction', () => {
    if (isAgyDisabled()) {
      console.error('dsh-agy is disabled (DSH_AGY_DISABLE=1).')
      process.exit(1)
    }
  })

  program
    .command('login')
    .description('OAuth login (browser, or headless paste)')
    .option('--headless', 'print the URL and wait for a pasted redirect URL', false)
    .option('--blob', 'print a paste-credential blob instead of storing the account', false)
    .option('--port <n>', 'loopback callback port', '51121')
    .option('--project <id>', 'bind the login to a specific project')
    .option('--timeout <ms>', 'callback timeout', '300000')
    .option('--proxy <url>', 'per-account proxy URL (http/https/socks5); empty to clear')
    .action(async (options) => {
      await loginCommand({ ...options, timeout: options.timeout })
    })

  program
    .command('status')
    .description('List accounts and their health')
    .action(async () => {
      await statusCommand()
    })

  program
    .command('import')
    .description('Import agy token files or paste credentials')
    .argument('[files...]', 'paths to agy auth.json token files (multiple allowed)')
    .option('--blob', 'the pasted value is a credential blob', false)
    .option('--email <email>', 'account email (skips userinfo verification)')
    .option('--overwrite', 'replace an existing account with the same email', false)
    .option('--proxy <url>', 'per-account proxy URL (http/https/socks5); empty to clear')
    .action(async (files: string[] | undefined, options: { blob: boolean; email?: string; overwrite: boolean; proxy?: string }) => {
      await importCommand({ ...options, files })
    })

  program
    .command('export')
    .description('Export account credentials as paste blobs')
    .option('--index <n>', 'export one account by index; default all')
    .option('--out <dir>', 'write one dsh-agy-<index>.blob file per account into this directory (default: print to stdout)')
    .action(async (options: { index?: string; out?: string }) => {
      await exportCommand(options)
    })

  program
    .command('verify')
    .description('Verify account credentials (refresh + userinfo)')
    .option('--index <n>', 'verify one account by index; default all')
    .action(async (options: { index?: string }) => {
      await verifyCommand(options)
    })

  program
    .command('health')
    .description('Check every enabled account (refresh + userinfo), optionally on an interval')
    .option('--interval <ms>', 'repeat on an interval instead of once')
    .option('--index <n...>', 'check only these accounts')
    .action(async (options: { interval?: string; index?: string[] }) => {
      await healthCommand(options)
    })

  program
    .command('logout')
    .description('Remove an account')
    .option('--index <n>', 'account index (default: active)')
    .option('--email <email>', 'account email')
    .action(async (options: { index?: string; email?: string }) => {
      await logoutCommand(options)
    })

  const proxy = program.command('proxy').description('Manage per-account proxies')
  proxy
    .command('set')
    .description('Set proxy for an account')
    .requiredOption('--index <n>', 'account index')
    .requiredOption('--proxy <url>', 'proxy URL (http/https/socks5)')
    .action(async (options: { index: string; proxy: string }) => {
      await proxySetCommand(options)
    })
  proxy
    .command('clear')
    .description('Clear proxy for an account')
    .requiredOption('--index <n>', 'account index')
    .action(async (options: { index: string }) => {
      await proxyClearCommand(options)
    })
  proxy
    .command('test')
    .description('Test proxy reachability for an account (TCP 2s fast-fail)')
    .requiredOption('--index <n>', 'account index')
    .action(async (options: { index: string }) => {
      await proxyTestCommand(options)
    })
  proxy
    .command('list')
    .description('List accounts with masked proxies')
    .action(async () => {
      await proxyListCommand()
    })

  return program
}

export { AGY_DEFAULT_REDIRECT_URI }
