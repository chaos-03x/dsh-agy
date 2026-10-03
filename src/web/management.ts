/**
 * agy management API: one method dispatcher shared by the RPC transport.
 *
 * Every method is a pure `(payload) => result` function so the transport stays
 * thin and the handlers stay testable without HTTP. Failures throw; the
 * transport converts a thrown error into the RPC failure envelope.
 *
 * This module owns the OAuth pending-authorization state because `auth.url`
 * issues it and the callback route consumes it — they must share one map, and
 * splitting them would let a verifier and its callback drift apart.
 */

import { authorizeAntigravity } from '../oauth/authorize.ts'
import { exchangeAntigravity } from '../oauth/exchange.ts'
import { importManySources, upsertImportedAccount } from '../cli/import.ts'
import { generateFingerprint, recordFingerprintVersion } from '../runtime/fingerprint.ts'
import { currentAgyVersion } from '../oauth/constants.ts'
import { maskProxyUrl } from '../store/accounts.ts'
import { accountFetch, isProxyReachable, normalizeProxyUrl, proxyUrlForLogs, withTotalTimeout } from '../proxy.ts'
import { AGY_PROVIDER } from '../adapter/models.ts'
import type { DiscoveredModelEntry } from '../adapter/models.ts'
import { clearExpiredState } from '../runtime/rotation.ts'
import { foldWindowBreakdown } from '../stats.ts'
import { THINKING_BUDGET_MAX, THINKING_BUDGET_MIN } from '../thinking-budget.ts'
import { CLAUDE_BUDGET_MAX, CLAUDE_BUDGET_MIN } from '../thinking-types.ts'
import { dayKey } from '../stats.ts'
import type { RecentActivity, UsageCounters, UsageSource } from '../stats.ts'
import type { AccountStore } from '../store/accounts.ts'
import type { AgySessionManager } from '../session.ts'
import type { ModelVisibility } from '../model-visibility.ts'
import type { UsageStats } from '../stats.ts'
import { UiPrefsStore } from '../ui-prefs.ts'
import type {
  AccountState,
  AccountUsageView,
  AccountView,
  AgyRpcMethod,
  ModelView,
  RangeBreakdown,
  StatsView,
  ThinkingBudgets,
} from '../rpc-contract.ts'

/** One pending OAuth authorization, keyed by its raw state. */
interface PendingAuth {
  verifier: string
  expiresAt: number
}

export interface AgyManagementOptions {
  store: AccountStore
  sessions: AgySessionManager
  stats: UsageStats
  /**
   * The persisted recent-activity ring (see `recent-store.ts`).
   *
   * A plain accessor rather than the store instance, matching `thinkingBudget`:
   * this module needs exactly one operation and cannot reach the rest.
   */
  recentRequests: () => RecentActivity[]
  modelVisibility: ModelVisibility
  uiPrefs?: UiPrefsStore
  /**
   * The global reasoning-level budget map (see `thinking-budget.ts`).
   *
   * A plain accessor pair rather than the store instance, so this module depends
   * only on the two operations it exposes and cannot reach the rest of the store.
   */
  thinkingBudget: {
    all: () => ThinkingBudgets
    set: (level: string, value: number | undefined) => ThinkingBudgets
    claude: () => number | undefined
    setClaude: (value: number | undefined) => number | undefined
    tiered: () => number | undefined
    setTiered: (value: number | undefined) => number | undefined
  }
  /**
   * The adapter's *unfiltered* model catalog.
   *
   * A function rather than the adapter itself so this module depends on the one
   * capability it needs. It must not be `llm.listModels()`, which already has
   * the hidden set applied — see the `model.list` handler.
   */
  listAllModels: () => Promise<readonly { id: string; name: string }[]>
  /**
   * Drop the adapter's cached model list.
   *
   * The cache is keyed to no account (see `AgyAdapter.invalidateModelCache`), so
   * the events that switch the account discovery rides must drop it explicitly —
   * `account.activate` is the one such event reachable from this surface.
   */
  invalidateModelCache: () => void
  /**
   * Harness web-server base URL, used to build the loopback OAuth redirect.
   * A function because the port in it is the one the server bound, known only
   * once it is listening — see `webBaseUrl` in `plugin.ts`.
   */
  baseUrl: () => string
  /**
   * Tell DSH the model catalog changed.
   *
   * The hidden-model list lives in agy's own file, so nothing in DSH emits a
   * change when it is written. The client refreshes the picker on
   * `llm/adapters-updated` alone, so without this a toggle would only take
   * effect after a page reload.
   */
  notifyModelsChanged: () => void
}

export interface AgyManagement {
  /** Dispatch one method; rejects with a legible message on failure. */
  call(method: string, payload: unknown): Promise<unknown>
  /** Consume an OAuth callback (the one endpoint that stays a real HTTP route). */
  handleCallback(params: URLSearchParams): Promise<{ ok: boolean; email?: string | null; error?: string }>
}

/** Fail one RPC with a message the UI can show verbatim. */
function fail(message: string): never {
  throw new Error(message)
}

function asIndex(payload: unknown): number {
  const index = Number((payload as { index?: unknown })?.index)
  if (!Number.isInteger(index) || index < 0) fail('invalid index')
  return index
}

/**
 * Flatten one account's ledger entry for transport.
 *
 * `models` is deliberately NOT carried: the per-model table that read it was
 * removed (the cumulative metric strip states the same figures better), and
 * sending fields no client reads is a wire surface with no consumer, which
 * reads as intentional to the next person and invites a stale assumption.
 * `lastUsedAt` DOES travel — the account row's activity fragment reads it.
 */
function toAccountUsageView(
  usage: { totals: UsageCounters; sources: Record<UsageSource, number>; lastUsedAt?: number } | undefined,
): AccountUsageView | null {
  if (usage === undefined) return null
  return {
    totals: usage.totals,
    sources: usage.sources,
    lastUsedAt: typeof usage.lastUsedAt === 'number' && Number.isFinite(usage.lastUsedAt)
      ? usage.lastUsedAt
      : null,
  }
}

export function createAgyManagement(options: AgyManagementOptions): AgyManagement {
  const { store, sessions, stats, recentRequests, modelVisibility, listAllModels, invalidateModelCache, baseUrl, notifyModelsChanged } = options
  const thinkingBudget = options.thinkingBudget
  const uiPrefs = options.uiPrefs ?? new UiPrefsStore()

  /** Authorizations issued by `auth.url`, keyed by raw state. */
  const pendingAuth = new Map<string, PendingAuth>()
  const PENDING_AUTH_TTL_MS = 10 * 60 * 1000

  const prunePendingAuth = (now = Date.now()): void => {
    for (const [key, entry] of pendingAuth) {
      if (entry.expiresAt <= now) pendingAuth.delete(key)
    }
    // Bound the map even under abuse: drop the soonest-to-expire entries.
    while (pendingAuth.size > 100) {
      let oldestKey: string | null = null
      let oldestExpiry = Infinity
      for (const [key, entry] of pendingAuth) {
        if (entry.expiresAt < oldestExpiry) {
          oldestExpiry = entry.expiresAt
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      pendingAuth.delete(oldestKey)
    }
  }

  const listAccounts = async (): Promise<AccountView[]> => {
    const storage = await store.load()
    const now = Date.now()
    // Expire stale cooldown state BEFORE rendering. `clearExpiredState` otherwise
    // only runs inside `pickAccount`, i.e. only when a request is actually made,
    // so a management read showed a reason for a window that had already lapsed —
    // the badge said "active" while the detail row still said "network-error",
    // contradicting itself on one screen. Purely in-memory here: the next real
    // mutation persists it, and a read must not write.
    for (const account of storage.accounts) clearExpiredState(account, now)
    const ledger = stats.snapshot()
    const rows: AccountView[] = []
    for (const [index, account] of storage.accounts.entries()) {
      const state: AccountState = account.enabled === false
        ? 'disabled'
        : account.verificationRequired === true
          ? 'verification-required'
          : account.coolingDownUntil !== undefined && account.coolingDownUntil > now
            ? 'cooling'
            : 'active'
      const key = account.email ?? account.id
      rows.push({
        index,
        email: account.email ?? null,
        projectId: account.projectId ?? null,
        active: index === storage.activeIndex && account.enabled !== false,
        state,
        // Disabled is terminal until a human acts (verify / re-import), so the
        // time is the actionable half: "minutes ago" makes an immediate verify
        // worth trying, "weeks ago" says re-login. Both disable writers persist
        // `verificationRequiredAt` in the same mutation as `enabled = false`,
        // and the parked-but-enabled path must NOT read as a disable time.
        disabledAt: account.enabled === false && account.verificationRequiredAt !== undefined
          ? new Date(account.verificationRequiredAt).toISOString()
          : null,
        cooldownUntil: account.coolingDownUntil !== undefined && account.coolingDownUntil > now
          ? new Date(account.coolingDownUntil).toISOString()
          : null,
        cooldownReason: account.cooldownReason ?? null,
        // Only while the window is live: `clearExpiredState` above already drops
        // both fields for an expired one, so this cannot outlive its reason.
        cooldownSetAt: account.cooldownSetAt === undefined
          ? null
          : new Date(account.cooldownSetAt).toISOString(),
        /**
         * Appeal link from an upstream verification challenge. Surfaced, never
         * followed automatically: only the account owner can complete it, and the
         * account returns to service on its own once the wall clears.
         */
        verificationUrl: account.verificationUrl ?? null,
        verificationRequired:
          account.verificationRequired === true && account.enabled !== false,
        rateLimits: account.rateLimitResetTimes ?? null,
        fingerprint: account.fingerprint
          ? {
            userAgent: account.fingerprint.userAgent,
            deviceId: account.fingerprint.deviceId,
            createdAt: account.fingerprint.createdAt,
          }
          : null,
        fingerprintHistory: (account.fingerprintHistory ?? []).length,
        proxy: account.proxy ? maskProxyUrl(account.proxy) : null,
        // Read from the cache the session manager already refreshes alongside the
        // per-model quota, so showing the windows costs no request. Null means
        // "never measured" and renders as an explicit placeholder rather than a
        // zero, which would read as an exhausted account.
        limits: account.cachedLimits?.groups ?? null,
        limitsUpdatedAt: account.cachedLimits?.updatedAt ?? null,
        // The burn rate arrives via `account.limits` (it exists only after the
        // sampling path has run twice); `account.list` stays probe-free.
        limitBurn: null,
        usage: key === undefined ? null : toAccountUsageView(ledger.accounts[key]),
      })
    }
    // Per-model quota is deliberately NOT fetched here (nor anywhere else): it
    // costs an upstream round trip, and embedding it in this reply once meant the
    // accounts list could not render until that probe finished — on a slow
    // network the panel showed "no accounts" behind a permanent spinner,
    // indistinguishable from data loss. The grouped 5h/weekly windows are the
    // surviving quota display, and they arrive via `account.limits`.
    return rows
  }

  /** Fold the ledger into the Usage tab's view. */
  const statsView = (): StatsView => {
    const doc = stats.snapshot()
    const now = Date.now()

    // Per-model totals across accounts: sum the same model id from every account.
    const byModel = new Map<string, UsageCounters>()
    for (const usage of Object.values(doc.accounts)) {
      for (const [model, counters] of Object.entries(usage.models)) {
        const current = byModel.get(model)
        if (current === undefined) {
          byModel.set(model, { ...counters })
        } else {
          for (const key of Object.keys(current) as Array<keyof UsageCounters>) {
            current[key] += counters[key]
          }
        }
      }
    }
    const allModels = [...byModel.entries()]
      .map(([model, counters]) => ({ model, counters }))
      .sort((a, b) => b.counters.requests - a.counters.requests)

    // Each range carries its OWN breakdown, so the tables follow the range
    // selection instead of showing all-time rows beneath range-scoped headline
    // figures (30 requests above a 164-request row, on one screen). The
    // all-time range reads the account maps directly, which hold every request
    // ever recorded rather than only the retained day window.
    const allAccounts = Object.entries(doc.accounts)
      .map(([account, usage]) => ({ account, counters: usage.totals }))
      .sort((a, b) => b.counters.requests - a.counters.requests)
    const breakdown = (days: number): RangeBreakdown => {
      const { totals, models, accounts } = foldWindowBreakdown(doc, days, now)
      return { counters: totals, models, accounts }
    }

    // Last 7 LOCAL calendar days, zeros filled: the trend table's job is to
    // show shape over time, and a gap day reads as data loss rather than idle.
    // Same local keying as the ledger's own buckets (dayKey).
    const daySeries = Array.from({ length: 7 }, (_, i) => {
      const key = dayKey(now - (6 - i) * 86_400_000)
      const bucket = doc.days[key]
      return {
        day: key,
        requests: bucket?.totals.requests ?? 0,
        failed: bucket?.totals.failed ?? 0,
        rateLimited: bucket?.totals.rateLimited ?? 0,
        rotations: bucket?.totals.rotations ?? 0,
      }
    })
    return {
      since: doc.totals.requests > 0 ? doc.since : null,
      all: { counters: doc.totals, models: allModels, accounts: allAccounts },
      today: breakdown(1),
      week: breakdown(7),
      month: breakdown(30),
      days: daySeries,
    }
  }

  const methods: Record<AgyRpcMethod, (payload: unknown) => Promise<unknown>> = {
    'account.list': async () => ({ accounts: await listAccounts() }),

    'pool.status': async () => ({ busy: await sessions.inFlightAccounts() }),

    'pool.recent': async () => ({ recent: recentRequests() }),

    'account.activate': async (payload) => {
      const index = asIndex(payload)
      await sessions.activateAccount(index)
      // The activated account may see a different catalog, and the model-list
      // cache is keyed to no account — drop it or the picker serves the
      // previous account's list until the TTL expires.
      invalidateModelCache()
      return { ok: true, index }
    },

    'account.delete': async (payload) => {
      const index = asIndex(payload)
      await store.mutate((storage) => {
        if (index >= storage.accounts.length) fail('account not found')
        storage.accounts.splice(index, 1)
        if (storage.activeIndex >= storage.accounts.length) storage.activeIndex = 0
      })
      return { ok: true }
    },

    'account.verify': async (payload) => sessions.verifyAccount(asIndex(payload)),

    'account.health': async (payload) => {
      const raw = (payload as { indices?: unknown })?.indices
      const indices = Array.isArray(raw) ? raw.map((value) => Number(value)) : undefined
      return { results: await sessions.checkAccounts(indices) }
    },

    /**
     * Refresh and return the 5h/weekly windows for every enabled account.
     *
     * A SEPARATE call rather than a field on `account.list`, because that reply
     * is deliberately probe-free (see the note above its return): folding an
     * upstream call into it made the whole accounts+usage view wait on the
     * network and show "no accounts" behind a spinner. Here the client renders
     * the list from `account.list` immediately and merges these in when they
     * arrive, so a slow probe costs a placeholder, not the page.
     *
     * Server-side this is TTL-gated, so the upstream call happens at most once
     * per window rather than once per view. `force` bypasses that gate for an
     * EXPLICIT refresh — without it the toolbar's Refresh button could not
     * deliver "the latest numbers now", which is the only reason to click it
     * while the snapshot is still inside its TTL.
     */
    'account.limits': async (payload) => {
      const force = (payload as { force?: unknown } | undefined)?.force === true
      const storage = await store.load()
      // Best-effort: a failed refresh leaves whatever was cached, so this reply
      // is always the current best knowledge rather than an error. The OUTCOME
      // is still reported, because "probed and failed" and "was still fresh"
      // both leave the numbers identical and the user needs to know which.
      const result = await sessions
        .refreshLimits(storage, { force })
        .catch(() => ({ measured: [], failed: [], skipped: 0 }))
      const fresh = await store.load()
      // Burn rates ride the same reply (the sampling path runs inside
      // refreshLimits); a join failure degrades to null rates, not an error.
      const burn = await sessions.limitBurnRates().catch(() => [])
      const burnByIndex = new Map(burn.map((entry) => [entry.index, entry.perHour]))
      return {
        limits: fresh.accounts.map((account, index) => ({
          index,
          groups: account.cachedLimits?.groups ?? null,
          updatedAt: account.cachedLimits?.updatedAt ?? null,
          burn: burnByIndex.get(index) ?? null,
        })),
        measured: result.measured.length,
        failed: result.failed.length,
        skipped: result.skipped,
      }
    },

    'account.test': async (payload) => {
      const model = (payload as { model?: unknown })?.model
      if (typeof model !== 'string' || model === '') fail('model is required')
      // The account row the user clicked. Optional so a caller that only wants
      // "test whatever the pool picks" still works, but a row click always
      // supplies it — otherwise the probe silently ran on the affinity account
      // and reported its result as this account's.
      const rawIndex = (payload as { index?: unknown })?.index
      return sessions.testCall(model, {
        ...(rawIndex === undefined ? {} : { accountIndex: asIndex(payload) }),
      })
    },

    'account.export': async (payload) => sessions.exportBlob(asIndex(payload)),

    'account.exportAll': async () => {
      const storage = await store.load()
      const blobs: Array<{ index: number; blob: string }> = []
      for (let index = 0; index < storage.accounts.length; index++) {
        const result = await sessions.exportBlob(index)
        if (result.blob !== undefined) blobs.push({ index, blob: result.blob })
      }
      return { blobs }
    },

    'account.import': async (payload) => {
      const body = payload as { kind?: unknown; sources?: unknown } | undefined
      const kind = body?.kind === 'blob' ? 'blob' : 'json'
      const sources = Array.isArray(body?.sources) ? body.sources : []
      if (sources.length === 0) fail('nothing to import')
      const result = await importManySources(
        sources.map((source) => ({ source, kind })),
        store,
        { overwriteExisting: true },
      )
      // Per-source failures are part of the result, not a thrown error: a batch
      // where 2 of 5 sources were malformed is a partial success, and the caller
      // must be able to say which ones failed.
      return {
        imported: result.imported,
        replaced: result.replaced,
        errors: result.errors.map((error) => String(error)),
      }
    },

    'account.fingerprint': async (payload) => {
      const index = asIndex(payload)
      const action = (payload as { action?: unknown })?.action === 'regenerate' ? 'regenerate' : 'show'
      return store.mutate(async (storage) => {
        const account = storage.accounts[index]
        if (!account) fail('account not found')
        if (action === 'regenerate') {
          // Same version source as first-use creation: the published value the
          // resolver maintains, never a per-call network probe whose result the
          // pool-randomizing default would silently discard anyway.
          const fresh = generateFingerprint(undefined, currentAgyVersion())
          account.fingerprint = fresh
          account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, fresh, 'regenerated')
        }
        return {
          action,
          fingerprint: account.fingerprint
            ? {
              userAgent: account.fingerprint.userAgent,
              deviceId: account.fingerprint.deviceId,
              createdAt: account.fingerprint.createdAt,
            }
            : null,
          history: account.fingerprintHistory?.length ?? 0,
        }
      })
    },

    'account.proxy': async (payload) => {
      const index = asIndex(payload)
      const raw = (payload as { proxy?: unknown })?.proxy
      const proxy = typeof raw === 'string' ? raw : ''
      if (proxy.trim() === '') {
        await store.mutate((storage) => {
          const account = storage.accounts[index]
          if (!account) fail('account not found')
          delete account.proxy
        })
        return { ok: true as const, proxy: null, proxyMasked: null, rawLogs: null }
      }
      let normalized: string
      try {
        normalized = normalizeProxyUrl(proxy)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
      await store.mutate((storage) => {
        const account = storage.accounts[index]
        if (!account) fail('account not found')
        account.proxy = normalized
      })
      return {
        ok: true as const,
        proxy: maskProxyUrl(normalized),
        proxyMasked: maskProxyUrl(normalized),
        rawLogs: proxyUrlForLogs(normalized),
      }
    },

    'account.proxyTest': async (payload) => {
      const body = payload as { index?: unknown; proxy?: unknown } | undefined
      const hasExplicit = typeof body?.proxy === 'string' && body.proxy.trim() !== ''
      let target: string
      if (hasExplicit) {
        try {
          target = normalizeProxyUrl(body.proxy as string)
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error))
        }
      } else {
        const index = asIndex(payload)
        const storage = await store.load()
        const account = storage.accounts[index]
        if (!account) fail('account not found')
        if (!account.proxy) fail('no proxy configured for this account')
        target = account.proxy
      }
      // Masked for display only; the raw URL never leaves this function.
      const masked = maskProxyUrl(target) ?? proxyUrlForLogs(target)
      try {
        const ok = await isProxyReachable(target, 2000)
        return ok ? { ok, masked } : { ok, masked, error: `proxy unreachable: ${masked}` }
      } catch (error) {
        return { ok: false, masked, error: error instanceof Error ? error.message : String(error) }
      }
    },

    'auth.url': async () => {
      const authorization = await authorizeAntigravity(`${baseUrl()}/agy/oauth-callback`)
      prunePendingAuth()
      pendingAuth.set(authorization.state, {
        verifier: authorization.verifier,
        expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
      })
      return { url: authorization.url }
    },

    'model.list': async () => {
      const session = await sessions.getSession().catch(() => undefined)
      if (session === undefined) fail('No agy account configured — run `dsh-agy login` first.')
      // The adapter's unfiltered catalog: reading the filtered `listModels()`
      // would hide a disabled model from this very list, leaving no switch to
      // turn it back on.
      const models = await listAllModels()
      const hidden = modelVisibility.disabledFor(AGY_PROVIDER)
      const rows: ModelView[] = models.map((model) => ({
        id: model.id,
        name: model.name,
        disabled: hidden.has(model.id),
      }))
      return { account: session.account.email ?? null, models: rows }
    },

    'model.setDisabled': async (payload) => {
      const body = payload as { modelId?: unknown; disabled?: unknown } | undefined
      const modelId = body?.modelId
      if (typeof modelId !== 'string' || modelId === '') fail('modelId is required')
      const disabled = body?.disabled === true
      modelVisibility.setDisabled(AGY_PROVIDER, modelId, disabled)
      // Push the change to every open client so the picker updates live.
      notifyModelsChanged()
      return { modelId, disabled }
    },

    'thinking.get': async () => ({
      budgets: thinkingBudget.all(),
      min: THINKING_BUDGET_MIN,
      max: THINKING_BUDGET_MAX,
      tieredBudget: thinkingBudget.tiered() ?? null,
      claudeBudget: thinkingBudget.claude() ?? null,
      claudeMin: CLAUDE_BUDGET_MIN,
      claudeMax: CLAUDE_BUDGET_MAX,
    }),

    'thinking.setTiered': async (payload) => {
      const body = payload as { budget?: unknown } | undefined
      const raw = body?.budget
      if (raw !== undefined && raw !== null && typeof raw !== 'number') fail('budget must be a number')
      try {
        const value = thinkingBudget.setTiered(raw === undefined || raw === null ? undefined : raw)
        return { tieredBudget: value ?? null }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    },

    'thinking.setClaude': async (payload) => {
      const body = payload as { budget?: unknown } | undefined
      const raw = body?.budget
      if (raw !== undefined && raw !== null && typeof raw !== 'number') fail('budget must be a number')
      try {
        const value = thinkingBudget.setClaude(raw === undefined || raw === null ? undefined : raw)
        return { claudeBudget: value ?? null }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    },

    'thinking.set': async (payload) => {
      const body = payload as { level?: unknown; budget?: unknown } | undefined
      const level = body?.level
      if (typeof level !== 'string' || level === '') fail('level is required')
      // `undefined` and explicit null BOTH clear the entry: the field means "let
      // upstream choose", and a JSON null is how a cleared input arrives.
      const raw = body?.budget
      if (raw !== undefined && raw !== null && typeof raw !== 'number') fail('budget must be a number')
      const value = raw === undefined || raw === null ? undefined : raw
      try {
        const budgets = thinkingBudget.set(level, value)
        return { budgets }
      } catch (error) {
        // Surface the range/name violation as a caller-correctable message
        // rather than an unlabelled RPC failure.
        fail(error instanceof Error ? error.message : String(error))
      }
    },

    'stats.get': async () => statsView(),

    'ui.prefs.get': async () => uiPrefs.get(),

    'ui.prefs.set': async (payload) => {
      const body = payload as { conversationBadge?: unknown } | undefined
      if (body?.conversationBadge !== undefined && typeof body.conversationBadge !== 'boolean') {
        fail('conversationBadge must be a boolean')
      }
      return uiPrefs.set({
        conversationBadge: body?.conversationBadge as boolean | undefined,
      })
    },
  }

  return {
    async call(method, payload) {
      const handler = methods[method as AgyRpcMethod]
      if (handler === undefined) fail(`unknown method: ${method}`)
      return handler(payload)
    },

    async handleCallback(params) {
      const code = params.get('code')
      const state = params.get('state')
      if (!code || !state) return { ok: false, error: 'Missing code or state parameter' }
      const expected = pendingAuth.get(state)
      if (expected === undefined) {
        return { ok: false, error: 'Unknown or expired authorization — please start a new login.' }
      }
      // One-time use: consume the issued state regardless of the exchange result.
      pendingAuth.delete(state)
      const redirectUri = `${baseUrl()}/agy/oauth-callback`
      const result = await exchangeAntigravity(code, state, redirectUri, expected.verifier)
      if (result.type === 'failed') return { ok: false, error: result.error }
      await upsertImportedAccount(store, {
        accessToken: result.access,
        refreshToken: result.refresh.split('|')[0]!,
        tokenType: 'Bearer',
        expiresAt: new Date(result.expires).toISOString(),
        authMethod: 'oauth',
        email: result.email ?? null,
        projectId: result.projectId || null,
        clientId: result.clientId || null,
      }, { overwriteExisting: true })
      return { ok: true, email: result.email ?? null }
    },
  }
}
