/**
 * In-harness web UI for agy: routes registered on ctx.webServer at /agy.
 * Serves a self-contained HTML dashboard with account management, OAuth login
 * via a popup, paste-blob import, and account verification.
 *
 * The OAuth callback is a webServer route on the same loopback origin, so the
 * firstparty/nativeapp consent can complete locally; remote hosts use the
 * paste-blob form instead.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AccountStore } from '../store/accounts.ts'
import type { AgySessionManager } from '../session.ts'
import { authorizeAntigravity } from '../oauth/authorize.ts'
import { exchangeAntigravity } from '../oauth/exchange.ts'
import { decodeCredentialBlob } from '../oauth/blob.ts'
import { importManySources, upsertImportedAccount } from '../cli/import.ts'
import { generateFingerprint, recordFingerprintVersion } from '../runtime/fingerprint.ts'
import { resolveAntigravityVersionBounded } from '../runtime/version.ts'
import { renderDashboardHtml, renderCallbackHtml } from './page.ts'

export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface AgyWebOptions {
  store: AccountStore
  sessions: AgySessionManager
  /** Base URL of the harness web server, e.g. http://127.0.0.1:3080 */
  baseUrl: string
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

export function createAgyWebRoutes(options: AgyWebOptions): WebRoute[] {
  const { store, sessions, baseUrl } = options

  // Authorizations issued by /auth-url, keyed by their raw state so the
  // callback can bind the exchange to the verifier we actually issued.
  const pendingAuth = new Map<string, { verifier: string; expiresAt: number }>()
  const PENDING_AUTH_TTL_MS = 10 * 60 * 1000
  const prunePendingAuth = (now = Date.now()) => {
    for (const [key, entry] of pendingAuth) {
      if (entry.expiresAt <= now) pendingAuth.delete(key)
    }
    while (pendingAuth.size > 100) {
      let oldestKey: string | null = null
      let oldestExpiry = Infinity
      for (const [key, entry] of pendingAuth) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt
          oldestKey = key
        }
      }
      if (oldestKey) pendingAuth.delete(oldestKey)
      else break
    }
  }

  const accountsList = async () => {
    const storage = await store.load()
    const now = Date.now()
    const list = []
    for (const [index, account] of storage.accounts.entries()) {
      const entry: Record<string, unknown> = {
        index,
        email: account.email ?? null,
        projectId: account.projectId ?? null,
        active: index === storage.activeIndex && account.enabled !== false,
        state: account.enabled === false ? 'disabled'
          : account.verificationRequired ? 'verification-required'
          : account.coolingDownUntil && account.coolingDownUntil > now ? 'cooling'
          : 'active',
        cooldownUntil: account.coolingDownUntil && account.coolingDownUntil > now ? new Date(account.coolingDownUntil).toISOString() : null,
        cooldownReason: account.cooldownReason ?? null,
        rateLimits: account.rateLimitResetTimes ?? null,
        fingerprint: account.fingerprint
          ? { userAgent: account.fingerprint.userAgent, deviceId: account.fingerprint.deviceId, createdAt: account.fingerprint.createdAt }
          : null,
        fingerprintHistory: (account.fingerprintHistory ?? []).length,
        quota: null as Record<string, unknown> | null,
      }
      list.push(entry)
    }
    // Best-effort per-account quota via fetchAvailableModels (fresh token).
    for (const entry of list) {
      const session = await sessions.getSession().catch(() => undefined)
      if (!session || session.index !== entry.index) continue
      try {
        const { fetchAvailableModels } = await import('../adapter/models.ts')
        const discovered = await fetchAvailableModels(session.auth.access, session.account.projectId)
        const models = Object.entries(discovered.models ?? {})
        if (models.length > 0) {
          const quotaRows = models
            .map(([id, m]) => ({
              id,
              remainingFraction: typeof m.quotaInfo?.remainingFraction === 'number'
                ? Math.max(0, Math.min(1, m.quotaInfo.remainingFraction))
                : null,
              resetTime: m.quotaInfo?.resetTime ?? null,
            }))
            .sort((a, b) => (a.remainingFraction ?? -1) - (b.remainingFraction ?? -1))
          entry.quota = {
            modelCount: models.length,
            models: quotaRows,
          }
        }
      } catch {
        // quota stays null
      }
    }
    return list
  }

  const handleAuthUrl = async (res: ServerResponse) => {
    const redirectUri = `${baseUrl}/agy/oauth-callback`
    const authorization = await authorizeAntigravity(redirectUri)
    prunePendingAuth()
    pendingAuth.set(authorization.state, {
      verifier: authorization.verifier,
      expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
    })
    sendJson(res, 200, { url: authorization.url })
  }

  const handleCallback = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', baseUrl)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderCallbackHtml({ ok: false, error: 'Missing code or state parameter', baseUrl }))
      return
    }
    const expected = pendingAuth.get(state)
    if (!expected) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderCallbackHtml({ ok: false, error: 'Unknown or expired authorization — please start a new login.', baseUrl }))
      return
    }
    // One-time use: consume the issued state regardless of the exchange result.
    pendingAuth.delete(state)
    const redirectUri = `${baseUrl}/agy/oauth-callback`
    const result = await exchangeAntigravity(code, state, redirectUri, expected.verifier)
    if (result.type === 'failed') {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderCallbackHtml({ ok: false, error: result.error, baseUrl }))
      return
    }
    await upsertImportedAccount(store, {
      accessToken: result.access,
      refreshToken: result.refresh.split('|')[0]!,
      tokenType: 'Bearer',
      expiresAt: new Date(result.expires).toISOString(),
      authMethod: 'oauth',
      email: result.email ?? null,
      projectId: result.projectId || null,
    }, { overwriteExisting: true })

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(renderCallbackHtml({ ok: true, email: result.email ?? null, baseUrl }))
  }

  const handleImport = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const kind = body.kind === 'blob' ? 'blob' : 'json'
      // Batch mode: `sources` is an array of strings (multi-line paste / bulk files);
      // single mode: `source` (backwards compatible).
      const sources: unknown[] = Array.isArray(body.sources)
        ? body.sources
        : body.source !== undefined ? [body.source] : []
      if (sources.length === 0) throw new Error('nothing to import')
      const result = await importManySources(
        sources.map((source) => ({ source, kind })),
        store,
        { overwriteExisting: true },
      )
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleExportAll = async (_req: IncomingMessage, res: ServerResponse) => {
    try {
      const storage = await store.load()
      const blobs: Array<{ index: number; blob: string }> = []
      for (let index = 0; index < storage.accounts.length; index++) {
        const result = await sessions.exportBlob(index)
        if (result.blob) blobs.push({ index, blob: result.blob })
      }
      sendJson(res, 200, { blobs })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleVerify = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const index = Number(body.index)
      const result = await sessions.verifyAccount(index)
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleHealth = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const indices = Array.isArray(body.indices)
        ? (body.indices as unknown[]).map((value) => Number(value))
        : undefined
      const results = await sessions.checkAccounts(indices)
      sendJson(res, 200, { results })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleDelete = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const index = Number(body.index)
      await store.mutate((storage) => {
        if (index < 0 || index >= storage.accounts.length) throw new Error('account not found')
        storage.accounts.splice(index, 1)
        if (storage.activeIndex >= storage.accounts.length) storage.activeIndex = 0
      })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleActivate = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const index = Number(body.index)
      await store.mutate((storage) => {
        if (index < 0 || index >= storage.accounts.length) throw new Error('account not found')
        storage.activeIndex = index
      })
      sendJson(res, 200, { ok: true, index })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleModels = async (_req: IncomingMessage, res: ServerResponse) => {
    const session = await sessions.getSession().catch(() => undefined)
    if (!session) {
      sendJson(res, 400, { error: 'No agy account configured — run `dsh-agy login` first.' })
      return
    }
    try {
      const { listAgyModels } = await import('../adapter/models.ts')
      const models = await listAgyModels(session.auth.access, session.account.projectId)
      sendJson(res, 200, { account: session.account.email ?? null, models: models.map((m) => ({
        id: m.id,
        name: m.name,
      })) })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleTest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const model = typeof body.model === 'string' ? body.model : ''
      if (!model) {
        sendJson(res, 400, { error: 'model is required' })
        return
      }
      const result = await sessions.testCall(model)
      sendJson(res, result.ok ? 200 : 400, result)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleExport = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const index = Number(body.index)
      const result = await sessions.exportBlob(index)
      if (result.error) {
        sendJson(res, 400, result)
        return
      }
      sendJson(res, 200, { blob: result.blob })
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleFingerprint = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const body = await readJson(req)
      const index = Number(body.index)
      const action = body.action === 'regenerate' ? 'regenerate' : 'show'
      const result = await store.mutate(async (storage) => {
        const account = storage.accounts[index]
        if (!account) throw new Error('account not found')
        if (action === 'regenerate') {
          const fresh = generateFingerprint(undefined, await resolveAntigravityVersionBounded())
          account.fingerprint = fresh
          account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, fresh, 'regenerated')
        }
        return {
          action,
          fingerprint: account.fingerprint
            ? { userAgent: account.fingerprint.userAgent, deviceId: account.fingerprint.deviceId, createdAt: account.fingerprint.createdAt }
            : null,
          history: account.fingerprintHistory?.length ?? 0,
        }
      })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  return [
    { kind: 'exact', path: '/agy', handler: (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(renderDashboardHtml())
        return
      }
      res.writeHead(405)
      res.end()
    } },
    { kind: 'exact', path: '/agy/oauth-callback', handler: handleCallback },
    { kind: 'exact', path: '/agy/api/accounts', handler: async (_req, res) => {
      sendJson(res, 200, { accounts: await accountsList() })
    } },
    { kind: 'exact', path: '/agy/api/auth-url', handler: async (_req, res) => { await handleAuthUrl(res) } },
    { kind: 'exact', path: '/agy/api/import', handler: handleImport },
    { kind: 'exact', path: '/agy/api/export-all', handler: handleExportAll },
    { kind: 'exact', path: '/agy/api/verify', handler: handleVerify },
    { kind: 'exact', path: '/agy/api/health', handler: handleHealth },
    { kind: 'exact', path: '/agy/api/delete', handler: handleDelete },
    { kind: 'exact', path: '/agy/api/activate', handler: handleActivate },
    { kind: 'exact', path: '/agy/api/models', handler: handleModels },
    { kind: 'exact', path: '/agy/api/test', handler: handleTest },
    { kind: 'exact', path: '/agy/api/export', handler: handleExport },
    { kind: 'exact', path: '/agy/api/fingerprint', handler: handleFingerprint },
  ]
}

export { decodeCredentialBlob }
