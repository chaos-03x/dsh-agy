/**
 * Shared runtime construction for the in-harness plugin entries: master-key
 * codec resolution (credentials seam first, credentials document fallback),
 * account store, session manager, and adapter. Used by the main plugin
 * (adapter registration) and the web plugin (route registration) so both
 * entries operate on the same store.
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AgyAdapter } from './adapter/adapter.ts'
import type { AgyAttachmentStore } from './adapter/adapter.ts'
import { AGY_PROVIDER } from './adapter/models.ts'
import { ModelVisibility } from './model-visibility.ts'
import { MultimodalConfigStore } from './multimodal-config.ts'
import { ThinkingBudgetStore } from './thinking-budget.ts'
import { UsageStats } from './stats.ts'
import { RecentActivityStore } from './recent-store.ts'
import { probeFetch, proxiedFetch } from './proxy.ts'
import { pickProbeProxyUrl } from './runtime/rotation.ts'
import { resolveAntigravityVersion } from './runtime/version.ts'
import type { FetchLike } from './runtime/version.ts'
import { AgySessionManager } from './session.ts'
import { JsonAccountStore } from './store/accounts.ts'
import type { AccountStore } from './store/accounts.ts'
import {
  MASTER_KEY_REF,
  createAesGcmCodec,
  deriveKey,
  loadMasterKey,
  persistMasterKey,
  resolveDshHome,
  resolveMasterKeyCodec,
} from './store/keyring.ts'
import type { SecretCodec } from './store/keyring.ts'
import { migrateToAgyDir } from './store/paths.ts'

export interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

function codecFrom(masterKey: string): SecretCodec {
  return createAesGcmCodec(deriveKey(masterKey))
}

/** Resolve or create the master key, preferring the credentials seam when available. */
export async function resolveCodec(ctx: Context): Promise<{ codec: SecretCodec; created: boolean }> {
  const dshHome = resolveDshHome()
  const credentials = ctx.get('credentials') as CredentialsSeam | undefined

  if (credentials) {
    const resolved = await credentials.resolve(MASTER_KEY_REF)
    if (resolved) return { codec: codecFrom(resolved.value), created: false }
    const fileKey = loadMasterKey(dshHome)
    if (fileKey) return { codec: codecFrom(fileKey), created: false }
    const fresh = randomBytes(32).toString('hex')
    try {
      await credentials.set(MASTER_KEY_REF, fresh)
      return { codec: codecFrom(fresh), created: true }
    } catch {
      // Read-only shadowing: persist to the credentials document directly.
      persistMasterKey(dshHome, fresh)
      return { codec: codecFrom(fresh), created: true }
    }
  }

  return resolveMasterKeyCodec(dshHome)
}

/**
 * Fire-and-forget version warm-up so fingerprint generation inside the
 * rate-limit path never waits on a cold feed.
 *
 * Routed through `pickProbeProxyUrl`: the release feeds are not account-scoped,
 * but the host IP is exactly what a per-account-proxy user asked to hide, and a
 * bare `proxiedFetch` sends this boot-time request directly. Never throws — an
 * unreadable store or a dead feed must not be the reason plugin boot fails.
 */
async function warmVersionCache(store: AccountStore): Promise<void> {
  let fetchImpl: FetchLike = proxiedFetch
  try {
    const storage = await store.load()
    const proxyUrl = pickProbeProxyUrl(storage.accounts, storage.activeIndex)
    fetchImpl = probeFetch(proxyUrl)
  } catch {
    // Fall through to the env/direct route.
  }
  await resolveAntigravityVersion(fetchImpl).catch(() => {})
}

/** The runtime one plugin entry uses: store, sessions, adapter, and the caches. */
export interface AgyRuntime {
  store: AccountStore
  sessions: AgySessionManager
  adapter: AgyAdapter
  stats: UsageStats
  recentStore: RecentActivityStore
  modelVisibility: ModelVisibility
  thinkingBudget: ThinkingBudgetStore
  multimodalConfig: MultimodalConfigStore
}

/**
 * The process-wide runtime promise, shared by both entry points.
 *
 * Splitting it was a real defect, not a stylistic one: the ledger FILE merges
 * across instances, so counters looked fine, but every in-memory surface is
 * per instance — the web entry's ring and in-flight map could never see the
 * main plugin's chat traffic (same process, two rings), and `account.activate`
 * cleared affinity pins on the WRONG session manager while the serving one
 * kept its stale pin. Both entries call this in one process; one memo here is
 * what makes that "shared runtime" claim true. Separate profiles are separate
 * processes, so the memo never bridges compositions.
 */
let sharedRuntime: Promise<AgyRuntime> | undefined

/** Build (once per process) and return the runtime both entries share. */
export async function createAgyRuntime(ctx: Context): Promise<AgyRuntime> {
  if (sharedRuntime === undefined) {
    sharedRuntime = buildAgyRuntime(ctx).catch((error) => {
      // A failed build must not poison every later activation: drop the memo
      // so the next entry (or a retried apply) builds fresh.
      sharedRuntime = undefined
      throw error
    })
  }
  return sharedRuntime
}

/** Test-only: drop the process memo so a test builds an isolated runtime. */
export function _resetAgyRuntimeForTest(): void {
  sharedRuntime = undefined
}

async function buildAgyRuntime(ctx: Context): Promise<AgyRuntime> {
  const { codec } = await resolveCodec(ctx)
  const dshHome = resolveDshHome()
  // Data files live in `$DSH_HOME/agy/`; the constructor-side migrations below
  // each move their own legacy file once. One warn here covers the skew case
  // for the whole runtime: every store's result is checked, and the message is
  // the same shape, so callers see ONE diagnosis instead of five.
  const accountsMigrated = migrateToAgyDir('agy-accounts.json', dshHome)
  if (accountsMigrated.skew) {
    ctx.logger.warn(
      '[dsh-agy] legacy data file detected next to the agy folder — an older dsh-agy '
      + 'process may still be writing the pre-0.5 layout; its writes will not be seen '
      + 'until every dsh surface is restarted',
    )
  }
  const store = new JsonAccountStore({ file: accountsMigrated.file, codec })
  void warmVersionCache(store)
  // The persisted recent-activity ring, built FIRST so it seeds from disk
  // before any record can arrive and `pool.recent` shows the other processes'
  // history immediately. Same soft-fail reporting contract as the ledger.
  const recentStore = new RecentActivityStore({
    onFlushError: (error) => {
      ctx.logger.warn(
        `[dsh-agy] recent-activity file could not be written (${recentStore.path}): `
        + `${error instanceof Error ? error.message : String(error)} — entries are buffered and will retry`,
      )
    },
  })
  // The ledger reports the first failure of a run, once. Without it a ledger
  // that cannot be written (read-only $DSH_HOME, ENOSPC) simply stops counting
  // with nothing anywhere to explain why — the failure mode this whole
  // soft-fail design otherwise hides.
  const stats = new UsageStats({
    // The ring's persistence half: every captured record is handed to the
    // store (write-behind there, still I/O-free here).
    persistRecent: (entry) => { recentStore.capture(entry) },
    onFlushError: (error) => {
      ctx.logger.warn(
        `[dsh-agy] usage ledger could not be written (${stats.path}): `
        + `${error instanceof Error ? error.message : String(error)} — counts are buffered and will retry`,
      )
    },
  })
  const modelVisibility = new ModelVisibility()
  const thinkingBudget = new ThinkingBudgetStore()
  const multimodalConfig = new MultimodalConfigStore()
  // The adapter's model-list cache is keyed to no account (see
  // `AgyAdapter.invalidateModelCache`), so every event that can switch the
  // account discovery rides must drop it. The adapter does not exist yet when
  // the session manager is constructed, hence the late-bound reference.
  let invalidateModelCache: () => void = () => {}
  const sessions = new AgySessionManager({
    store,
    recordUsage: (record) => { stats.record(record) },
    onRotate: () => { invalidateModelCache() },
  })
  // Optional background health probe (DSH_AGY_HEALTH_INTERVAL_MS), off by default.
  const healthIntervalMs = Number(process.env.DSH_AGY_HEALTH_INTERVAL_MS ?? 0)
  if (Number.isFinite(healthIntervalMs) && healthIntervalMs > 0) {
    sessions.startHealthProbe(healthIntervalMs)
  }
  const adapter = new AgyAdapter({
    getSession: (model, conversationKey) => sessions.getSession(model, undefined, conversationKey),
    reportFailure: (kind, session, info) => sessions.reportFailure(kind, session, info),
    markSuccess: (session) => sessions.markSuccess(session),
    resolveAttachments: () => ctx.get('attachments') as AgyAttachmentStore | undefined,
    noteRequestStarted: (account) => sessions.noteRequestStarted(account),
    noteRequestSettled: (account) => sessions.noteRequestSettled(account),
    modelVisibility,
    thinkingBudgetFor: (level) => thinkingBudget.budgetFor(level),
    claudeBudgetFor: () => thinkingBudget.claudeBudget(),
    tieredBudgetFor: () => thinkingBudget.tieredBudget(),
    maxInlineBytes: () => multimodalConfig.maxInlineBytes(),
    recordUsage: (record) => { stats.record({ ...record, source: 'chat' }) },
  })
  invalidateModelCache = () => { adapter.invalidateModelCache() }
  // Warm up the model list in the background so the first model/effort selection
  // in DSH has zero latency and shows no loading spinner.
  void adapter.listAllModels().catch(() => {})
  // Persist the ledger and the recent ring on normal termination. `exit`
  // covers both a graceful shutdown and the CLI's explicit `process.exit`
  // calls.
  //
  // Deliberately NO signal handlers: installing a SIGINT/SIGTERM listener
  // replaces Node's default terminate behavior, so it must flush and then
  // re-raise or Ctrl-C stops working — a real bug for the sake of at most one
  // throttle window (5s) of counts on an interrupted process. The timer in
  // UsageStats/RecentActivityStore already bounds that loss, and these are
  // diagnostics.
  process.once('exit', () => {
    stats.flushSync()
    recentStore.flushSync()
  })
  return { store, sessions, adapter, stats, recentStore, modelVisibility, thinkingBudget, multimodalConfig }
}

export { AGY_PROVIDER }
