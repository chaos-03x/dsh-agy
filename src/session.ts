/**
 * Account session manager: the shared runtime glue between the store, the
 * OAuth refresh path, rotation/fingerprint logic, and the adapter. Used by the
 * in-harness plugin shell, the CLI, and the web routes.
 */

import { AgyAuthError, AgyPoolBlockedError } from './types.ts'
import type { AccountStorageV4, AgyAccountSession, CachedQuota, FailureKind, ManagedAccount, OAuthAuthDetails, QuotaGroup } from './types.ts'
import { refreshAccessToken } from './oauth/refresh.ts'
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from './oauth/auth.ts'
import type { AccountStore } from './store/accounts.ts'
import {
  IN_FLIGHT_STALE_MS,
  MAX_IN_FLIGHT_PER_ACCOUNT,
  MAX_RATE_LIMIT_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
  clearExpiredState,
  decideRotation,
  isCoolingDown,
  isFamilyRateLimited,
  parseFutureResetMs,
  pickNextAccountIndex,
  recordRateLimit,
} from './runtime/rotation.ts'
import {
  familyKeyOf,
  familyQuotaFor,
  ingestFamilyQuotas,
  isFamilyDrained,
  isLimitsStale,
  isQuotaStale,
  modelFamilyOf,
  rankPoolCandidates,
} from './runtime/quota.ts'
import {
  generateFingerprint,
  getFingerprintData,
  getStableHeaders,
  recordFingerprintVersion,
  updateFingerprintVersion,
} from './runtime/fingerprint.ts'
import { deriveAntigravitySessionId, generateAntigravityRequestId } from './runtime/identity.ts'
import { fingerprintMode } from './runtime/risk.ts'
import { peekCachedAntigravityVersion, resolveAntigravityVersionBounded } from './runtime/version.ts'
import { currentAgyVersion } from './oauth/constants.ts'
import { accountFetch, isProxyUnreachableError, probeFetch, proxiedFetch } from './proxy.ts'
import { describeFetchError } from './runtime/classify.ts'
import type { Fingerprint } from './types.ts'

export interface SessionManagerOptions {
  store: AccountStore
  /** Called after rotation changes the active index (for logging/UI). */
  onRotate?: (fromIndex: number, toIndex: number, reason: FailureKind) => void
  /** Called after a health check finishes (batch probe results). */
  onHealthReport?: (results: AccountHealthResult[]) => void
  /**
   * Receives one usage record per account-scoped upstream call made outside the
   * chat path (verification, test calls, CLI invocations).
   *
   * This is the half of the ledger DSH structurally cannot supply: those calls
   * consume upstream quota without ever producing a session event, so agy is
   * the only party that can count them. Chat generations are recorded by the
   * adapter, which sees their token usage.
   */
  recordUsage?: (record: UsageRecord) => void
}

/** A usage record emitted by the session manager's non-chat call paths. */
export interface UsageRecord {
  account?: string
  model?: string
  source: 'chat' | 'cli' | 'verify' | 'test'
  ok: boolean
  rateLimited?: boolean
  /** Token usage, when the call parsed an upstream stream. */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  latencyMs?: number
  ttftMs?: number
  /**
   * A pool-level event (a rotation) rather than a request of its own.
   * The adapter has already recorded the request that failed, so this must
   * move only the pool counters or the request would be counted twice.
   */
  poolEvent?: boolean
  /** Marks a rotation in a pool event. */
  rotated?: boolean
}

/** One account's health check result (refresh + userinfo). */
export interface AccountHealthResult {
  index: number
  email?: string
  ok: boolean
  error?: string
}

/**
 * What one 5h/weekly window refresh actually did.
 *
 * Exists so an EXPLICIT refresh can report its outcome. The three lists are
 * separate because they read identically on screen otherwise: "nothing was due
 * (TTL)" and "every probe failed" both leave the displayed numbers untouched,
 * so a caller that cannot tell them apart cannot say anything truthful.
 */
export interface LimitsRefreshResult {
  /** Account keys whose windows were measured and written. */
  measured: string[]
  /** Account keys whose probe was attempted and failed. */
  failed: string[]
  /** Accounts not probed because their snapshot was still fresh. */
  skipped: number
}

/**
 * Session affinity window: reuse the last-used account for new requests within
 * this window (proxy for one DSH conversation, which exposes no id). After the
 * window or on failure the pool re-balances.
 */
export const SESSION_AFFINITY_WINDOW_MS = 10 * 60 * 1000

interface TokenCacheEntry {
  access: string
  expires: number
}

interface QuotaRefreshResult {
  key: string
  quotas: Record<string, CachedQuota>
  updatedAt: number
}

/**
 * Resolve the impersonation headers for one request from the account's
 * persistent fingerprint (stable identity).
 *
 * The fallback below is only reachable when an account has no stored identity —
 * normal operation creates one on first use (see `getSession`). It is therefore
 * deliberately DETERMINISTIC rather than randomized: a per-request platform or
 * version would make one account appear to be several different machines, which
 * is the anomaly this identity exists to avoid. It reads
 * {@link getFingerprintData} so a `$DSH_HOME/agy-fingerprint-data.json` override
 * still applies on this path.
 */
export function impersonationHeadersFor(account: ManagedAccount): AgyAccountSession['impersonation'] {
  const fingerprint = account.fingerprint
  if (fingerprint) {
    return {
      'User-Agent': fingerprint.userAgent,
      'X-Goog-Api-Client': fingerprint.apiClient,
      clientMetadata: fingerprint.clientMetadata,
    }
  }
  return getStableHeaders(getFingerprintData(), currentAgyVersion())
}

export class AgySessionManager {
  private readonly store: AccountStore
  private readonly onRotate: SessionManagerOptions['onRotate']
  private readonly onHealthReport: SessionManagerOptions['onHealthReport']
  private readonly recordUsageOption: SessionManagerOptions['recordUsage']
  private readonly tokenCache = new Map<string, TokenCacheEntry>()
  /** In-flight refresh promises keyed by account: concurrent requests share one refresh. */
  private readonly refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>()
  /** In-flight quota fetches keyed by account: concurrent selections share one fetchAvailableModels call. */
  private readonly quotaRefreshInFlight = new Map<string, Promise<QuotaRefreshResult | null>>()
  private readonly failureCounts = new Map<string, number>()
  /** Accounts whose request-time project discovery already failed (no retry per request). */
  private readonly projectRetryFailed = new Set<string>()

  /** Bound for one quota poll so selection never stalls on a hung endpoint. */
  private static readonly QUOTA_FETCH_TIMEOUT_MS = 3_000
  /** Refresh the token this far ahead of expiry so a request never blocks on the token endpoint. */
  private static readonly REFRESH_SKEW_MS = 2 * 60 * 1000

  /**
   * Per-conversation account affinity: the account one conversation is pinned
   * to, so its turns stay together (upstream prefix cache + `sessionId`
   * continuity) instead of re-ranking per request.
   *
   * Keyed by the conversation — `GenerateOptions.sessionId`, which the DSH agent
   * loop stamps — rather than by a single "last used" slot. That slot was a
   * stand-in for a conversation id the code assumed DSH did not expose, and with
   * two concurrent conversations the second overwrote the first's pin, so both
   * drifted across the pool independently of which account they started on.
   * Entries expire after {@link SESSION_AFFINITY_WINDOW_MS}.
   */
  private readonly affinity = new Map<string, { key: string; at: number }>()

  /** Bound on tracked conversations; least-recently-pinned entries are evicted. */
  private static readonly MAX_AFFINITY_ENTRIES = 64

  /** Bucket for callers with no session identity (standalone CLI, one-shots). */
  private static readonly ANONYMOUS_CONVERSATION = '\u0000anonymous'

  /**
   * In-flight upstream requests per account, so selection can spread concurrent
   * fan-out across the pool instead of stacking every stream on one account.
   *
   * Deliberately a PREFERENCE, not a hard gate: when every eligible account is at
   * the cap, selection proceeds with the best-ranked one rather than waiting.
   * Blocking would need a reliable release on every path (including an abandoned
   * stream) and a bounded wait to avoid deadlock, and a leaked counter would then
   * stall real requests — a worse failure than the burst it prevents. The
   * documented limitation is therefore: this spreads load across a multi-account
   * pool, and cannot throttle a single-account one.
   */
  private readonly inFlight = new Map<string, { count: number; at: number }>()

  /** In-flight count for one account, discarding a leaked entry past its TTL. */
  private inFlightCount(accountKey: string, now: number): number {
    const entry = this.inFlight.get(accountKey)
    if (entry === undefined) return 0
    if (now - entry.at > IN_FLIGHT_STALE_MS) {
      this.inFlight.delete(accountKey)
      return 0
    }
    return entry.count
  }

  /** Record that one upstream request for this account has started. */
  noteRequestStarted(account: ManagedAccount): void {
    const key = this.accountKey(account)
    const now = Date.now()
    this.inFlight.set(key, { count: this.inFlightCount(key, now) + 1, at: now })
  }

  /** Record that one upstream request for this account has settled, on any path. */
  noteRequestSettled(account: ManagedAccount): void {
    const key = this.accountKey(account)
    const now = Date.now()
    const count = this.inFlightCount(key, now)
    if (count <= 1) this.inFlight.delete(key)
    else this.inFlight.set(key, { count: count - 1, at: now })
  }

  /** The map key for a conversation; anonymous callers share one bucket. */
  private conversationKeyFor(conversationKey?: string): string {
    const trimmed = conversationKey?.trim()
    return trimmed && trimmed.length > 0 ? trimmed : AgySessionManager.ANONYMOUS_CONVERSATION
  }

  /** Drop expired pins and keep the map bounded. */
  private pruneAffinity(now: number): void {
    for (const [conversation, pin] of this.affinity) {
      if (now - pin.at >= SESSION_AFFINITY_WINDOW_MS) this.affinity.delete(conversation)
    }
    while (this.affinity.size > AgySessionManager.MAX_AFFINITY_ENTRIES) {
      const oldest = this.affinity.keys().next()
      if (oldest.done) break
      this.affinity.delete(oldest.value)
    }
  }

  /** The account key this conversation is pinned to, when the pin is still fresh. */
  private affinityFor(conversationKey: string | undefined, now: number): string | null {
    const pin = this.affinity.get(this.conversationKeyFor(conversationKey))
    if (!pin || now - pin.at >= SESSION_AFFINITY_WINDOW_MS) return null
    return pin.key
  }

  /** Pin one conversation to one account. Re-inserts so eviction stays LRU. */
  private setAffinity(conversationKey: string | undefined, accountKey: string, now: number): void {
    const conversation = this.conversationKeyFor(conversationKey)
    this.affinity.delete(conversation)
    this.affinity.set(conversation, { key: accountKey, at: now })
    this.pruneAffinity(now)
  }

  /**
   * Drop every pin pointing at one account.
   *
   * A rotation or a skip means the account just proved unusable for the
   * conversation that was pinned to it; other conversations pinned elsewhere keep
   * their pins, which the single-slot version could not express.
   */
  private clearAffinityForAccount(accountKey: string): void {
    for (const [conversation, pin] of this.affinity) {
      if (pin.key === accountKey) this.affinity.delete(conversation)
    }
  }

  constructor(options: SessionManagerOptions) {
    this.store = options.store
    this.onRotate = options.onRotate
    this.onHealthReport = options.onHealthReport
    this.recordUsageOption = options.recordUsage
  }

  /** Emit one non-chat usage record; a ledger failure never breaks the call. */
  private emitUsage(record: UsageRecord): void {
    try {
      this.recordUsageOption?.(record)
    } catch {
      // Swallowed by design: statistics are diagnostics.
    }
  }

  private accountKey(account: ManagedAccount): string {
    return account.id ?? account.email ?? `idx-${account.refresh}`
  }

  /**
   * Refresh the account's access token (single-flight per account). A transient
   * refresh failure keeps the cached token in place (retain-last-good): the old
   * token stays valid until its own expiry and a later request retries the
   * refresh. Only `invalid_grant` drops the cache.
   */
  private refreshToken(key: string, account: ManagedAccount, cached?: TokenCacheEntry): Promise<OAuthAuthDetails | undefined> {
    const inFlight = this.refreshInFlight.get(key)
    if (inFlight) return inFlight

    const refreshing = (async (): Promise<OAuthAuthDetails | undefined> => {
      const result = await refreshAccessToken(
        { access: cached?.access ?? '', expires: cached?.expires ?? 0, refresh: account.refresh },
        { clientId: account.clientId, proxyUrl: account.proxy },
      )
      if (result.type === 'success') {
        if (!account.clientId && result.clientId) {
          await this.store.mutate((s) => {
            const target = s.accounts.find((candidate) => this.accountKey(candidate) === key)
            if (!target) throw new Error(`Account ${key} not found during clientId migration`)
            target.clientId = result.clientId
          })
          account.clientId = result.clientId
        }
        // Cache token strictly AFTER disk persistence has succeeded
        this.tokenCache.set(key, { access: result.auth.access, expires: result.auth.expires })
        return result.auth
      }
      if (result.type === 'failed') {
        if (cached && !accessTokenExpired({ access: cached.access, expires: cached.expires, refresh: account.refresh })) {
          return { access: cached.access, expires: cached.expires, refresh: account.refresh }
        }
        // Only an explicit per-account proxy may be judged proxy-unreachable.
        // Without one a bare ECONNRESET is a transient network error, and
        // reporting it as proxy_unreachable made a healthy single account look
        // like a dead proxy (issue #29).
        if (account.proxy && isProxyUnreachableError(result.error)) {
          throw new AgyAuthError('transport', 'proxy_unreachable', { cause: result.error })
        }
        const kind = result.error.status === 429
          ? 'rate-limit'
          : result.error.status === 0 || result.error.status === 408 || result.error.status >= 500
            ? 'transport'
            : 'invalid-credential'
        throw new AgyAuthError(kind, describeFetchError(result.error), { cause: result.error })
      }
      if (result.type === 'revoked') {
        // Account credentials are dead — mark it disabled and verificationRequired in the store
        this.tokenCache.delete(key)
        await this.store.mutate((s) => {
          const target = s.accounts.find((candidate) => this.accountKey(candidate) === key)
          if (target) {
            target.enabled = false
            target.verificationRequired = true
            target.verificationRequiredAt = Date.now()
            target.verificationRequiredReason = 'auth-failure'
          }
        })
        account.enabled = false
        account.verificationRequired = true
        account.verificationRequiredAt = Date.now()
        account.verificationRequiredReason = 'auth-failure'
        return undefined
      }
      return undefined
    })()
    this.refreshInFlight.set(key, refreshing)
    refreshing.then(
      () => this.refreshInFlight.delete(key),
      () => this.refreshInFlight.delete(key),
    )
    return refreshing
  }

  /** Resolve a usable access token for the account, pre-emptively refreshing near expiry. */
  private async accessTokenFor(account: ManagedAccount): Promise<OAuthAuthDetails | undefined> {
    const key = this.accountKey(account)
    const cached = this.tokenCache.get(key)
    const now = Date.now()
    if (cached && !accessTokenExpired({ access: cached.access, expires: cached.expires, refresh: account.refresh })) {
      // Pre-emptive refresh within the skew: serve the still-valid token and
      // refresh in the background (OMP-style refresh skew).
      if (cached.expires <= now + AgySessionManager.REFRESH_SKEW_MS) {
        void this.refreshToken(key, account, cached)
      }
      return { access: cached.access, expires: cached.expires, refresh: account.refresh }
    }
    return this.refreshToken(key, account, cached)
  }

  /**
   * Refresh the display-only 5h/weekly windows for every enabled account.
   *
   * SEPARATE from `refreshQuotaCache`, and deliberately so. That method writes
   * `cachedQuota`, which feeds the scheduling path: `rankPoolCandidates` turns a
   * measured `remainingFraction <= 0` into a `blockedUntil`, so measuring a
   * pool's quota can BLOCK an account. That is safe only with a fallback, which
   * is why `getSession` gates it on `eligible.length > 1` — and that gate is also
   * why a solo account never had `cachedLimits` populated and the limits card
   * showed "not measured yet" forever.
   *
   * Dropping the gate instead would have been a real outage, not a display fix:
   * a solo account whose family is measured at 0 gets `AgyPoolBlockedError` with
   * no other account to serve the request (verified). So the windows are fetched
   * here WITHOUT writing `cachedQuota`, which makes them safe to measure for a
   * pool of any size — a solo account included.
   *
   * Cost is bounded by the same TTL the scheduling path uses, so this runs at
   * most once per window rather than per request.
   *
   * KNOWN LIMITATION (deliberate, not overlooked): a FAILED probe writes no
   * marker, so "probe failed" and "never probed" are indistinguishable and
   * `isLimitsStale` reports stale again on the next call. The practical effect is
   * that an account whose endpoint never returns groups is re-probed each time
   * the accounts page is opened, with no backoff. Acceptable today — the call is
   * display-only, TTL-bounded, and triggered by opening a tab rather than by a
   * poll — so no negative-TTL field is added yet. Revisit if the trigger becomes
   * frequent or the pool grows enough that the extra calls matter.
   *
   * @param storage - the loaded storage document, overlaid in memory on success.
   * @param options - `force` re-probes inside the TTL.
   * @returns which accounts were measured, so a caller that asked for a refresh
   *   can REPORT it. Without this a forced refresh that failed was completely
   *   silent: no cache write, no `updatedAt` change, nothing on screen — the
   *   same "clicked it, saw a flicker" defect as an unread RPC verdict.
   */
  async refreshLimits(
    storage: AccountStorageV4,
    options: { force?: boolean } = {},
  ): Promise<LimitsRefreshResult> {
    const now = Date.now()
    // A separate staleness rule: `isQuotaStale` is driven by the SCHEDULING
    // cache, which a solo account never fills, so reusing it would report
    // "stale" on every call and re-probe continuously. `force` bypasses it for
    // an explicit user request, which is the only thing that may spend an
    // upstream call inside the TTL.
    const candidates = storage.accounts.filter((account) => account.enabled !== false)
    const targets = options.force === true
      ? candidates
      : candidates.filter((account) => isLimitsStale(account, now))
    if (targets.length === 0) {
      return { measured: [], failed: [], skipped: candidates.length }
    }

    const probes = await Promise.all(targets.map(async (account) => {
      const key = this.accountKey(account)
      try {
        const auth = await this.accessTokenFor(account)
        if (!auth) return { key, ok: false as const }
        const { fetchQuotaSummary } = await import('./adapter/quota-summary.ts')
        const routed = accountFetch({ proxyUrl: account.proxy })
        const bounded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const timeout = AbortSignal.timeout(AgySessionManager.QUOTA_FETCH_TIMEOUT_MS)
          const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
          return routed(input, { ...init, signal })
        }
        const groups = await fetchQuotaSummary(auth.access, account.projectId, bounded)
        if (groups.length === 0) return { key, ok: false as const }
        return { key, ok: true as const, groups, updatedAt: Date.now() }
      } catch {
        // Best-effort: a failed probe leaves the previous windows in place.
        return { key, ok: false as const }
      }
    }))

    const updates = probes.filter((probe): probe is
      { key: string, ok: true, groups: QuotaGroup[], updatedAt: number } => probe.ok)
    const failed = probes.filter((probe) => !probe.ok).map((probe) => probe.key)
    // Report the skip count so a caller can distinguish "nothing was due" from
    // "everything failed" — the two read identically on screen otherwise.
    // Counted over the same eligible set the early return uses, so a disabled
    // account never inflates it into a phantom "still fresh".
    const result: LimitsRefreshResult = {
      measured: updates.map((update) => update.key),
      failed,
      skipped: candidates.length - targets.length,
    }
    if (updates.length === 0) return result

    for (const update of updates) {
      const target = storage.accounts.find((candidate) => this.accountKey(candidate) === update.key)
      // Only `cachedLimits` — never `cachedQuota`, which is what keeps this
      // incapable of blocking an account.
      if (target) target.cachedLimits = { groups: update.groups, updatedAt: update.updatedAt }
    }
    try {
      await this.store.mutate((s) => {
        for (const update of updates) {
          const target = s.accounts.find((candidate) => this.accountKey(candidate) === update.key)
          if (target) target.cachedLimits = { groups: update.groups, updatedAt: update.updatedAt }
        }
      })
    } catch {
      // A derived display cache; a failed write degrades gracefully.
    }
    return result
  }

  /**
   * Refresh stale per-account quota caches (family-scoped, health-based TTL).
   * Failures leave the account unmeasured: ranking treats it as a fallback
   * instead of blocking selection on a hung endpoint.
   */
  private async refreshQuotaCache(storage: AccountStorageV4): Promise<void> {
    const now = Date.now()
    const stale = storage.accounts.filter((account) => account.enabled !== false && isQuotaStale(account, now))
    if (stale.length === 0) return

    const results = await Promise.all(stale.map(async (account) => {
      const key = this.accountKey(account)
      if (this.quotaRefreshInFlight.has(key)) return this.quotaRefreshInFlight.get(key)
      const refresh = (async () => {
        try {
          const auth = await this.accessTokenFor(account)
          if (!auth) return null
          const { fetchAvailableModels } = await import('./adapter/models.ts')
          const { fetchQuotaSummary } = await import('./adapter/quota-summary.ts')
          const routed = accountFetch({ proxyUrl: account.proxy })
          // ONE timeout per probe, both bounded by the same budget the model
          // probe already used; the account's proxy is honoured on both, or the
          // summary call would egress direct and leak the account's real IP.
          const bounded: typeof fetch = (input, init) => {
            const timeout = AbortSignal.timeout(AgySessionManager.QUOTA_FETCH_TIMEOUT_MS)
            const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
            return routed(input, { ...init, signal })
          }
          // The weekly window comes ONLY from the summary endpoint, so it is read
          // HERE (the scheduling path) and never in `refreshLimits`: that one is
          // display-only, and a display refresh must not reach `cachedQuota`,
          // which decides blocking.
          const [discovered, groups] = await Promise.all([
            fetchAvailableModels(auth.access, account.projectId, bounded),
            fetchQuotaSummary(auth.access, account.projectId, bounded),
          ])
          const quotas = ingestFamilyQuotas(discovered, groups, account.cachedQuota)
          return { key, quotas, updatedAt: Date.now() }
        } catch {
          return null
        }
      })()
      this.quotaRefreshInFlight.set(key, refresh)
      try {
        return await refresh
      } finally {
        this.quotaRefreshInFlight.delete(key)
      }
    }))

    const updates = results.filter((r): r is { key: string; quotas: Record<string, CachedQuota>; updatedAt: number } => Boolean(r && Object.keys(r.quotas).length > 0))
    if (updates.length > 0) {
      for (const update of updates) {
        const target = storage.accounts.find((candidate) => this.accountKey(candidate) === update.key)
        if (target) {
          target.cachedQuota = update.quotas
          target.cachedQuotaUpdatedAt = update.updatedAt
        }
      }
      try {
        await this.store.mutate((s) => {
          for (const update of updates) {
            const target = s.accounts.find((candidate) => this.accountKey(candidate) === update.key)
            if (target) {
              target.cachedQuota = update.quotas
              target.cachedQuotaUpdatedAt = update.updatedAt
            }
          }
        })
      } catch {
        // Quota is a derived cache — a failed write degrades gracefully without
        // failing the active request (next refresh cycle re-ingests).
      }
    }
  }

  /**
   * Pick the account for one request: the affinity pin wins while it is fresh,
   * healthy, and not drained for the requested model; otherwise the pool is
   * ranked by family-scoped usage (OMP-aligned) and the best candidate wins.
   */
  private async pickAccount(
    storage: AccountStorageV4,
    model?: string,
    conversationKey?: string,
  ): Promise<{ account: ManagedAccount; index: number } | undefined> {
    const now = Date.now()
    for (const account of storage.accounts) clearExpiredState(account, now)

    const family = modelFamilyOf(model)
    const familyKey = familyKeyOf(model)
    // Conversation affinity: reuse the account this conversation is already
    // pinned to while it is fresh and healthy, so one conversation stays on one
    // account. A drained family or a cooldown breaks the pin and re-ranks,
    // mirroring OMP's pinned-until-unusable.
    const pinnedKey = this.affinityFor(conversationKey, now)
    if (pinnedKey !== null) {
      const lastIndex = storage.accounts.findIndex((a) => this.accountKey(a) === pinnedKey)
      if (lastIndex !== -1) {
        const last = storage.accounts[lastIndex]!
        if (
          last.enabled !== false &&
          !isCoolingDown(last, now) &&
          !isFamilyRateLimited(last, familyKey, now) &&
          !isFamilyDrained(last, family, now)
        ) {
          return { account: last, index: lastIndex }
        }
      }
    }
    const eligible = storage.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => account.enabled !== false)
    if (eligible.length === 0) return undefined

    const ranked = rankPoolCandidates(eligible, model, now, storage.activeIndex)
    // Prefer an account with in-flight headroom so concurrent conversations
    // spread across the pool; fall back to plain ranking when every candidate is
    // saturated (see `inFlight` for why this is a preference, not a gate).
    const picked =
      ranked.find((candidate) =>
        candidate.blockedUntil === null
        && this.inFlightCount(this.accountKey(candidate.account), now) < MAX_IN_FLIGHT_PER_ACCOUNT)
      ?? ranked.find((candidate) => candidate.blockedUntil === null)
    if (!picked) {
      const quotaExhausted = (account: ManagedAccount): boolean => {
        if (account.cooldownReason === 'quota-exhausted' && (account.coolingDownUntil ?? 0) > now) return true
        const quota = familyQuotaFor(account, family)
        if ((quota?.remainingFraction ?? 1) > 0 || !quota?.resetTime) return false
        const resetAt = Date.parse(quota.resetTime)
        return !Number.isNaN(resetAt) && resetAt > now
      }
      const retryable = ranked.filter((candidate) => !quotaExhausted(candidate.account))
      const blocked = retryable.length > 0 ? retryable : ranked
      const blockedUntil = Math.min(...blocked.map((candidate) => candidate.blockedUntil ?? now))
      throw new AgyPoolBlockedError(retryable.length > 0 ? 'retryable' : 'quota-exhausted', blockedUntil)
    }
    if (picked.index !== storage.activeIndex) {
      storage.activeIndex = picked.index
      await this.store.mutate((s) => {
        s.activeIndex = picked.index
      })
    }
    return { account: picked.account, index: picked.index }
  }
  /**
   * Adapter hook: resolve the active session (refresh if needed), healing a
   * missing projectId at request time — the OAuth-time loadCodeAssist may have
   * transiently failed even when the Google account owns a Cloud Code project
   * (mirrors OmniRoute's ensureAntigravityProjectAssigned + persistence).
   * @param model - requested model id; drives family-scoped quota ranking.
   * @param accountIndex - resolve this exact account instead of ranking the pool.
   *   Used by the management "Test call" action, where testing a different
   *   account than the one the user clicked would report a result for the wrong
   *   account. Deliberately does NOT update the affinity pin: a one-shot test
   *   must not steer the next real conversation onto the account it probed.
   * @param conversationKey - the conversation's identity (`GenerateOptions.sessionId`),
   *   which scopes account affinity. Concurrent conversations therefore hold
   *   independent pins. Omitted by callers with no conversation (CLI, probes),
   *   which share one anonymous bucket.
   */
  async getSession(
    model?: string,
    accountIndex?: number,
    conversationKey?: string,
  ): Promise<AgyAccountSession | undefined> {
    let storage = await this.store.load()
    if (accountIndex !== undefined) {
      // Fail loudly rather than silently falling back to the pool: a test that
      // reports on an account it was not asked about is worse than an error.
      const account = storage.accounts[accountIndex]
      if (!account) throw new Error(`account #${accountIndex} not found`)
      if (account.enabled === false) throw new Error(`account #${accountIndex} is disabled`)
    }
    const maxAttempts = accountIndex === undefined
      ? storage.accounts.filter((account) => account.enabled !== false).length
      : 1
    let proxyUnreachableCount = 0
    /**
     * Last transport failure seen on a *proxyless* account. Such an account is
     * skipped (another enabled account may be healthy) without writing a
     * cooldown: a cooldown would surface as AgyPoolBlockedError — i.e. RATE_LIMIT
     * for a plain network error — and would block a solo pool outright. It is
     * remembered so the request still reports its real cause rather than
     * degrading into "no account configured" when every account fails this way.
     */
    let lastTransportError: unknown

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const eligible = storage.accounts.filter((account) => account.enabled !== false)
      if (accountIndex === undefined && eligible.length > 1) {
        await this.refreshQuotaCache(storage)
        // In-memory overlay on storage already took place in refreshQuotaCache.
      }
      const picked = accountIndex === undefined
        ? await this.pickAccount(storage, model, conversationKey)
        : (() => {
          const account = storage.accounts[accountIndex]
          if (!account) throw new Error(`account #${accountIndex} not found`)
          if (account.enabled === false) throw new Error(`account #${accountIndex} is disabled`)
          return { account, index: accountIndex }
        })()
      if (!picked) return undefined
      let auth: OAuthAuthDetails | undefined
      try {
        auth = await this.accessTokenFor(picked.account)
      } catch (error) {
        if (Boolean(picked.account.proxy) && isProxyUnreachableError(error)) {
          // Fail-closed for per-account proxy: skip this account for this request
          // without a cooldown (the proxy may recover; a cooldown would also hide
          // the real cause and block a solo proxied pool).
          proxyUnreachableCount++
          // A pinned caller asked about ONE account: falling over to a different
          // one would answer a question nobody asked, and mutating the pool
          // cursor for a diagnostic probe would be a side effect the user did
          // not request. Surface the failure instead.
          if (accountIndex !== undefined) throw error
          storage = await this.skipAccount(storage, picked.account)
          continue
        }
        // Otherwise the same socket codes describe the connection, not a proxy
        // (issue #29): fall over to the next enabled account, remembering the
        // failure in case none of them succeeds.
        lastTransportError = error
        if (accountIndex !== undefined) throw error
        storage = await this.skipAccount(storage, picked.account)
        continue
      }
      if (!auth) {
        // The selected credential was revoked and disabled by accessTokenFor.
        if (accountIndex !== undefined) {
          throw new Error(`account #${accountIndex} credential is no longer valid — run \`dsh-agy login\``)
        }
        // Re-read and select another enabled account within this same request.
        this.clearAffinityForAccount(this.accountKey(picked.account))
        storage = await this.store.load()
        continue
      }

      const key = this.accountKey(picked.account)
      if (!picked.account.projectId && !this.projectRetryFailed.has(key)) {
        try {
          const { loadCodeAssist } = await import('./oauth/exchange.ts')
          const { projectId } = await loadCodeAssist(auth.access, { proxyUrl: picked.account.proxy })
          if (projectId) {
            await this.store.mutate((s) => {
              const account = s.accounts.find((candidate) => this.accountKey(candidate) === key)
              if (account) {
                account.projectId = projectId
                // Keep the packed refresh string in sync.
                const parts = parseRefreshParts(account.refresh)
                account.refresh = formatRefreshParts({
                  refreshToken: parts.refreshToken,
                  projectId,
                  managedProjectId: parts.managedProjectId,
                })
              }
            })
            picked.account.projectId = projectId
          } else {
            this.projectRetryFailed.add(key)
          }
        } catch {
          this.projectRetryFailed.add(key)
        }
      }

      // Create the account's device identity on first USE, not on first
      // rate-limit. Platform, version and SDK-client are chosen once here and
      // frozen, so one account presents one coherent device for its whole life.
      //
      // Previously the identity did not exist until the account's first 429, and
      // the pre-fingerprint fallback re-picked a platform per request — so a
      // single account's consecutive calls claimed `windows/amd64` and then
      // `darwin/arm64`. An OS that changes between two requests of one session is
      // a stronger anomaly than a stale version, and it was present on the most
      // common path (every fresh account, until it happened to hit a limit).
      if (!picked.account.fingerprint) {
        const fingerprint = generateFingerprint(undefined, currentAgyVersion())
        const history = recordFingerprintVersion(picked.account.fingerprintHistory, fingerprint, 'initial')
        await this.store.mutate((s) => {
          const account = s.accounts.find((candidate) => this.accountKey(candidate) === key)
          // Re-check under the lock: a concurrent request may have created one.
          if (account && !account.fingerprint) {
            account.fingerprint = fingerprint
            account.fingerprintHistory = history
          }
        })
        picked.account.fingerprint = fingerprint
        picked.account.fingerprintHistory = history
      }

      // A pinned (test) call must not touch the affinity pin: probing an account
      // is not "using" it, and pinning would steer the next real conversation.
      if (accountIndex === undefined) this.setAffinity(conversationKey, key, Date.now())
      return {
        auth,
        account: picked.account,
        index: picked.index,
        impersonation: impersonationHeadersFor(picked.account),
      }
    }

    if (proxyUnreachableCount === maxAttempts && maxAttempts > 0) {
      throw new AgyAuthError('transport', 'proxy_unreachable')
    }
    // Every account failed for a non-proxy reason: surface the real cause rather
    // than `undefined`, which the adapter would report as NO_CREDENTIAL
    // ("no account configured") — misleading, and wrong for a transient blip.
    if (lastTransportError !== undefined) throw lastTransportError
    return undefined
  }

  /**
   * Drop the session pin and move the pool cursor off an account that just
   * failed, so the next `pickAccount` in this same request tries another one.
   * State on the account itself is deliberately left untouched (no cooldown).
   */
  private async skipAccount(storage: AccountStorageV4, account: ManagedAccount): Promise<AccountStorageV4> {
    this.clearAffinityForAccount(this.accountKey(account))
    const key = this.accountKey(account)
    const deadIndex = storage.accounts.findIndex((candidate) => this.accountKey(candidate) === key)
    if (deadIndex !== -1) {
      const next = pickNextAccountIndex(storage.accounts, deadIndex, Date.now())
      if (next !== storage.activeIndex) {
        storage.activeIndex = next
        await this.store.mutate((s) => { s.activeIndex = next }).catch(() => {})
      }
    }
    return this.store.load()
  }

  /** Adapter hook: apply rotation decisions and fingerprint regeneration. */
  async reportFailure(
    kind: FailureKind,
    session: AgyAccountSession,
    info?: {
      retryAfterMs?: number
      status?: number
      rateLimitCategory?: import('./runtime/classify.ts').RateLimitCategory
      /** Server-reported absolute reset time; drives precise cooldowns. */
      resetTime?: string
      /** Requested model id; drives family-scoped rate-limit bookkeeping. */
      model?: string
      /** Appeal link from a `verification-required` body; surfaced to the user. */
      verificationUrl?: string
    },
  ): Promise<void> {
    if (!session?.account) return
    const key = this.accountKey(session.account)
    const consecutive = (this.failureCounts.get(key) ?? 0) + 1
    this.failureCounts.set(key, consecutive)
    let nextIndexToRotate: number | null = null
    const fpCachedVersion = kind === 'rate-limit' ? peekCachedAntigravityVersion() : null
    // The version a newly generated fingerprint advertises. Cache first (no I/O),
    // then a bounded live resolve, then `currentAgyVersion()` (the resolved version
    // or the pinned fallback) — and never `generateFingerprint`'s own default,
    // which picks a RANDOM entry from `versionPool`: whatever is chosen here is
    // frozen into the account's identity for its lifetime, so a cold start with an
    // unreachable feed could otherwise advertise a two-minor-old client forever.
    // The probe rides the FAILING account's egress: the feeds belong to no account,
    // but the request still egresses the host, and the boot-time probe already
    // routes this way (see `probeFetch`).
    const fpResolvedVersion = kind === 'rate-limit'
      ? (fpCachedVersion ?? (await resolveAntigravityVersionBounded(750, probeFetch(session.account.proxy))) ?? currentAgyVersion())
      : currentAgyVersion()

    await this.store.mutate((storage) => {
      const account = storage.accounts.find((a) => this.accountKey(a) === key)
      if (!account) return

      const decision = decideRotation(kind, account, consecutive, info?.retryAfterMs, info?.rateLimitCategory, info?.resetTime)

      // Keep the appeal link beside the challenge state so a user can act on it.
      // Only overwritten when the upstream actually supplied one, so a later
      // challenge without a URL does not erase a previously captured link.
      if (kind === 'verification-required' && info?.verificationUrl) {
        account.verificationUrl = info.verificationUrl
      }

      if (kind === 'rate-limit' && info?.rateLimitCategory !== 'soft_rate_limit') {
        // Family-scoped bookkeeping of the real reset (display + ranking wall).
        // Soft rate limits are transient bursts handled via immediate retry — do not block the family.
        const familyKey = familyKeyOf(info?.model)
        const resetMs = parseFutureResetMs(info?.resetTime, Date.now()) ??
          (Date.now() + Math.min(info?.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS))
        recordRateLimit(account, familyKey, resetMs)
      }

      if (decision.action === 'revoke') {
        this.tokenCache.delete(key)
        this.failureCounts.delete(key)
        return
      }

      // Fingerprint lifecycle: create on first rate-limit, regenerate after
      // repeated failures (bounded by history inside recordFingerprintVersion).
      // UA versions come from the version resolver (bounded, cached 6h) so
      // fingerprints never pin a stale Antigravity client version. The `stable`
      // risk mode pins one identity per account: create once, never regenerate.
      //
      // KNOWN DEFECT (recorded, deliberately not changed): this block is gated
      // on `kind === 'rate-limit'`, so the identity is rebuilt exactly when
      // quota runs out — and NEVER on `verification-required`, i.e. not when
      // upstream actually gates the account. The coupling is inverted with
      // respect to intent. Two further reasons the rebuild is weaker than it
      // looks: `consecutive` is counted per accountKey while the failing account
      // has just been rotated away (so reaching 2 requires it to be picked
      // again first), and of the five `Fingerprint` fields only `userAgent` and
      // `apiClient` ever reach a request header (`buildRequestHeaders`;
      // `deviceId`/`sessionToken` are never sent, `clientMetadata` only rides
      // the control-plane calls). So a "new identity" re-rolls two header
      // values, one of them a UA shape no artifact confirms. Fixing the gate
      // alone would not make the mechanism load-bearing — decide what identity
      // is actually transmitted before widening it.
      if (kind === 'rate-limit' && info?.rateLimitCategory !== 'soft_rate_limit') {
        if (!account.fingerprint) {
          account.fingerprint = generateFingerprint(undefined, fpResolvedVersion)
          account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, account.fingerprint, 'initial')
        } else {
          if (fpCachedVersion) updateFingerprintVersion(account.fingerprint, fpCachedVersion)
          if (fingerprintMode() !== 'stable' && consecutive >= 2) {
            const fresh = generateFingerprint(undefined, fpResolvedVersion)
            account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, fresh, 'regenerated')
            account.fingerprint = fresh
          }
        }
      }

      if (decision.action === 'rotate') {
        const currentIndex = storage.accounts.findIndex((a) => this.accountKey(a) === key)
        const familyKey = familyKeyOf(info?.model)
        const nextIndex = pickNextAccountIndex(storage.accounts, currentIndex >= 0 ? currentIndex : storage.activeIndex, Date.now(), familyKey)
        if (nextIndex !== storage.activeIndex) {
          storage.activeIndex = nextIndex
          nextIndexToRotate = nextIndex
        }
        // Only conversations pinned to the failed account are freed; a pin on
        // another account was never this failure's business.
        this.clearAffinityForAccount(key)
      }
    })

    if (nextIndexToRotate !== null) {
      this.onRotate?.(session.index, nextIndexToRotate, kind)
      // Counted as a pool event, not a request: the adapter already recorded
      // the request that failed, and counting it again here would inflate it.
      this.emitUsage({
        ...(session.account.email === undefined && session.account.id === undefined
          ? {}
          : { account: session.account.email ?? session.account.id }),
        source: 'chat',
        ok: false,
        rotated: true,
        poolEvent: true,
      })
    }
  }
  /** Adapter hook: reset the failure counter after a clean completion. */
  async markSuccess(session: AgyAccountSession): Promise<void> {
    const account = session.account
    const key = this.accountKey(account)
    this.failureCounts.delete(key)
  }

  /**
   * Test call: one short streaming request against the live backend.
   * Returns the collected text or a structured error message.
   * @param model - model id to exercise.
   * @param options - probe overrides.
   *   - `prompt` / `maxTokens`: the request shape (defaults to a one-token reply).
   *   - `accountIndex`: test this exact account instead of letting the pool rank
   *     one. The management UI exposes "Test call" per account row, so without
   *     this the probe ran on whichever account affinity picked, and its result
   *     was both returned and recorded against that other account.
   */
  async testCall(
    model: string,
    options: { prompt?: string; maxTokens?: number; accountIndex?: number } = {},
  ): Promise<{ ok: boolean; text?: string; error?: string }> {
    const prompt = options.prompt ?? 'Reply with exactly: OK'
    const maxTokens = options.maxTokens ?? 1024
    // Session resolution happens OUTSIDE the recorded region: a rejected pin
    // ("account #9 not found") or a refresh failure means no upstream model call
    // was made, and counting it as a request would inflate a ledger whose whole
    // purpose is to reflect what actually consumed quota. The exception is a
    // refresh that reached the token endpoint — that is still recorded below,
    // because it did touch the account's identity.
    const startedAt = Date.now()
    let session: AgyAccountSession | undefined
    try {
      session = await this.getSession(model, options.accountIndex)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (!session) return { ok: false, error: 'No agy account configured — run `dsh-agy login` first.' }
    try {
      const account = session.account.email ?? session.account.id
      const { toAgyRequestBody } = await import('./adapter/translate.ts')
      const { fetchAgyFirstOk } = await import('./oauth/constants.ts')
      const { parseAgySse } = await import('./adapter/parse.ts')
      // Same id in the body and the header, exactly as the generation path does:
      // a diagnostic request should not carry a shape the real one never sends.
      const requestId = generateAntigravityRequestId()
      const body = toAgyRequestBody(
        {
          provider: 'agy',
          model,
          messages: [{ id: 'test-1', role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens,
        } as never,
        {
          projectId: session.account.projectId,
          sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined,
          requestId,
        },
      )
      const headers = {
        authorization: `Bearer ${session.auth.access}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'User-Agent': session.impersonation['User-Agent'],
        'X-Goog-Api-Client': session.impersonation['X-Goog-Api-Client'],
      }
      const routing = { proxyUrl: session.account.proxy, streaming: true }
      const response = await fetchAgyFirstOk(
        '/v1internal:streamGenerateContent?alt=sse',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        accountFetch(routing),
        routing,
      )
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        this.emitUsage({ account, model, source: 'test', ok: false, latencyMs: Date.now() - startedAt })
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
      }
      if (!response.body) {
        this.emitUsage({ account, model, source: 'test', ok: false, latencyMs: Date.now() - startedAt })
        return { ok: false, error: 'no response body' }
      }
      const text: string[] = []
      let usage: UsageRecord['usage']
      let ttftMs: number | undefined
      for await (const chunk of parseAgySse(response.body)) {
        if (chunk.type === 'usage') {
          usage = {
            input: chunk.usage.inputTokens,
            output: chunk.usage.outputTokens,
            cacheRead: chunk.usage.cacheReadTokens ?? 0,
            cacheWrite: chunk.usage.cacheWriteTokens ?? 0,
          }
        } else if (chunk.type === 'text-delta') {
          if (ttftMs === undefined) ttftMs = Date.now() - startedAt
          text.push(chunk.text)
        }
      }
      const ok = text.length > 0
      this.emitUsage({
        account, model, source: 'test', ok,
        ...(usage === undefined ? {} : { usage }),
        ...(ttftMs === undefined ? {} : { ttftMs }),
        latencyMs: Date.now() - startedAt,
      })
      return { ok, text: text.join(''), error: ok ? undefined : 'empty response' }
    } catch (error) {
      this.emitUsage({ source: 'test', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Export one account as a paste-credential blob (for migration to another host). */
  async exportBlob(index: number): Promise<{ blob?: string; error?: string }> {
    const storage = await this.store.load()
    const account = storage.accounts[index]
    if (!account) return { error: 'account not found' }
    try {
      const auth = await this.accessTokenFor(account)
      if (!auth) return { error: 'refresh failed (revoked?)' }
      const { encodeCredentialBlob } = await import('./oauth/blob.ts')
      const parts = parseRefreshParts(account.refresh)
      return {
        blob: encodeCredentialBlob('agy', {
          access_token: auth.access,
          refresh_token: parts.refreshToken,
          expires_in: Math.max(0, Math.round((auth.expires - Date.now()) / 1000)),
        }),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Probe one account: refresh + userinfo; a live credential re-enables the account. */
  private async probeAccount(index: number, account: ManagedAccount): Promise<{ ok: boolean; email?: string; error?: string }> {
    const startedAt = Date.now()
    const key = account.email ?? account.id
    try {
      const auth = await this.accessTokenFor(account)
      if (!auth) {
        this.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
        return { ok: false, error: 'refresh failed (revoked?)' }
      }
      const response = await proxiedFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { Authorization: `Bearer ${auth.access}` },
      }, account.proxy ? { proxyUrl: account.proxy } : undefined)
      if (!response.ok) {
        this.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
        return { ok: false, error: `userinfo ${response.status}` }
      }
      const info = (await response.json()) as { email?: string }
      // Credentials are live again — clear any auth-failure disable so the
      // account re-enters rotation without a manual re-import.
      await this.store.mutate((s) => {
        const target = s.accounts[index]
        if (target) {
          target.enabled = true
          target.verificationRequired = false
          target.verificationRequiredAt = undefined
          target.verificationRequiredReason = undefined
          target.verificationUrl = undefined
        }
      })
      // No model tokens are billed by a userinfo probe, but the call is a real
      // account-scoped request and belongs in the ledger as such.
      this.emitUsage({ account: info.email ?? key, source: 'verify', ok: true, latencyMs: Date.now() - startedAt })
      return { ok: true, email: info.email }
    } catch (error) {
      this.emitUsage({ account: key, source: 'verify', ok: false, latencyMs: Date.now() - startedAt })
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** CLI/web helper: verify an account's credentials (refresh + userinfo). */
  async verifyAccount(index: number): Promise<{ ok: boolean; email?: string; error?: string }> {
    const storage = await this.store.load()
    const account = storage.accounts[index]
    if (!account) return { ok: false, error: 'account not found' }
    return this.probeAccount(index, account)
  }

  /**
   * Batch health check over all enabled accounts (or the given indices):
   * refresh + userinfo per account, live credentials re-enable the account.
   * Reports results through onHealthReport when a listener is registered.
   */
  async checkAccounts(indices?: number[]): Promise<AccountHealthResult[]> {
    const storage = await this.store.load()
    const targets = indices !== undefined
      ? indices.filter((index) => storage.accounts[index])
      : storage.accounts.map((_, index) => index).filter((index) => storage.accounts[index]!.enabled !== false)

    const results: AccountHealthResult[] = await Promise.all(targets.map(async (index) => {
      const probed = await this.probeAccount(index, storage.accounts[index]!)
      return { index, ...probed }
    }))
    this.onHealthReport?.(results)
    return results
  }

  /**
   * Start a background health probe on an interval (disposable stop handle).
   * The timer is unref'd unless told otherwise so harness processes can still
   * exit; the CLI loop mode passes `unref: false`.
   */
  startHealthProbe(intervalMs: number, options: { unref?: boolean } = {}): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
    const timer = setInterval(() => {
      void this.checkAccounts().catch(() => {})
    }, intervalMs)
    if (options.unref !== false) timer.unref?.()
    return () => clearInterval(timer)
  }
}

export type { Fingerprint }
