/**
 * Account session manager: the shared runtime glue between the store, the
 * OAuth refresh path, rotation/fingerprint logic, and the adapter. Used by the
 * in-harness plugin shell, the CLI, and the web routes.
 */

import type { AgyAccountSession } from './adapter/adapter.ts'
import type { AccountStorageV4, FailureKind, ManagedAccount, OAuthAuthDetails } from './types.ts'
import { refreshAccessToken } from './oauth/refresh.ts'
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from './oauth/auth.ts'
import type { AccountStore } from './store/accounts.ts'
import {
  clearExpiredState,
  decideRotation,
  isCoolingDown,
  pickNextAccountIndex,
  recordRateLimit,
} from './runtime/rotation.ts'
import {
  familyKeyOf,
  ingestFamilyQuotas,
  isFamilyDrained,
  isQuotaStale,
  modelFamilyOf,
  rankPoolCandidates,
} from './runtime/quota.ts'
import {
  DEFAULT_FINGERPRINT_DATA,
  generateFingerprint,
  getRandomizedHeaders,
  getStableHeaders,
  recordFingerprintVersion,
  updateFingerprintVersion,
} from './runtime/fingerprint.ts'
import { deriveAntigravitySessionId } from './runtime/identity.ts'
import { fingerprintMode } from './runtime/risk.ts'
import { peekCachedAntigravityVersion, resolveAntigravityVersionBounded } from './runtime/version.ts'
import { proxiedFetch } from './proxy.ts'
import type { Fingerprint } from './types.ts'

export interface SessionManagerOptions {
  store: AccountStore
  /** Called after rotation changes the active index (for logging/UI). */
  onRotate?: (fromIndex: number, toIndex: number, reason: FailureKind) => void
  /** Called after a health check finishes (batch probe results). */
  onHealthReport?: (results: AccountHealthResult[]) => void
}

/** One account's health check result (refresh + userinfo). */
export interface AccountHealthResult {
  index: number
  email?: string
  ok: boolean
  error?: string
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

/**
 * Resolve the impersonation headers for one request from the account's
 * persistent fingerprint (stable identity). The fallback randomizes per
 * request in `dynamic` mode and pins one identity in `stable` mode.
 */
export function impersonationHeadersFor(account: ManagedAccount): AgyAccountSession['impersonation'] {
  const fingerprint = account.fingerprint
  if (fingerprint) {
    return {
      'User-Agent': fingerprint.userAgent,
      'X-Goog-Api-Client': fingerprint.apiClient,
      'Client-Metadata': JSON.stringify(fingerprint.clientMetadata),
    }
  }
  const headers = fingerprintMode() === 'stable'
    ? getStableHeaders(DEFAULT_FINGERPRINT_DATA)
    : getRandomizedHeaders(DEFAULT_FINGERPRINT_DATA)
  return {
    'User-Agent': headers['User-Agent'],
    'X-Goog-Api-Client': headers['X-Goog-Api-Client'],
    'Client-Metadata': headers['Client-Metadata'],
  }
}

export class AgySessionManager {
  private readonly store: AccountStore
  private readonly onRotate: SessionManagerOptions['onRotate']
  private readonly onHealthReport: SessionManagerOptions['onHealthReport']
  private readonly tokenCache = new Map<string, TokenCacheEntry>()
  /** In-flight refresh promises keyed by account: concurrent requests share one refresh. */
  private readonly refreshInFlight = new Map<string, Promise<OAuthAuthDetails | undefined>>()
  /** In-flight quota fetches keyed by account: concurrent selections share one fetchAvailableModels call. */
  private readonly quotaRefreshInFlight = new Map<string, Promise<void>>()
  private readonly failureCounts = new Map<string, number>()
  /** Accounts whose request-time project discovery already failed (no retry per request). */
  private readonly projectRetryFailed = new Set<string>()

  /** Bound for one quota poll so selection never stalls on a hung endpoint. */
  private static readonly QUOTA_FETCH_TIMEOUT_MS = 3_000
  /** Refresh the token this far ahead of expiry so a request never blocks on the token endpoint. */
  private static readonly REFRESH_SKEW_MS = 2 * 60 * 1000

  /**
   * Session affinity (time-window approximation): DSH exposes no conversation
   * id, so instead of pinning per session we reuse the last-used account while
   * it is fresh. Keeps upstream prefix caching and sessionId continuity across
   * the turns of one conversation (OmniRoute pins by session for the same
   * reason). Cleared on rotate so a failure re-picks from activeIndex.
   */
  private lastUsed: { index: number; at: number } | null = null

  constructor(options: SessionManagerOptions) {
    this.store = options.store
    this.onRotate = options.onRotate
    this.onHealthReport = options.onHealthReport
  }

  private accountKey(account: ManagedAccount): string {
    return account.email ?? `idx-${account.refresh}`
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
      const result = await refreshAccessToken({ access: cached?.access ?? '', expires: cached?.expires ?? 0, refresh: account.refresh })
      if (result.type === 'success') {
        this.tokenCache.set(key, { access: result.auth.access, expires: result.auth.expires })
        return result.auth
      }
      if (result.type === 'revoked') {
        // Account credentials are dead — mark it disabled; the next failure path
        // will surface the message.
        this.tokenCache.delete(key)
        return undefined
      }
      // Transient failure: the cached token (when present) remains servable.
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
   * Refresh stale per-account quota caches (family-scoped, health-based TTL).
   * Failures leave the account unmeasured: ranking treats it as a fallback
   * instead of blocking selection on a hung endpoint.
   */
  private async refreshQuotaCache(storage: AccountStorageV4): Promise<void> {
    const now = Date.now()
    const stale = storage.accounts.filter((account) => account.enabled !== false && isQuotaStale(account, now))
    if (stale.length === 0) return

    await Promise.all(stale.map(async (account) => {
      const key = this.accountKey(account)
      if (this.quotaRefreshInFlight.has(key)) return this.quotaRefreshInFlight.get(key)
      const refresh = (async () => {
        try {
          const auth = await this.accessTokenFor(account)
          if (!auth) return
          const { fetchAvailableModels } = await import('./adapter/models.ts')
          const boundedFetch: typeof fetch = (input, init) => {
            const timeout = AbortSignal.timeout(AgySessionManager.QUOTA_FETCH_TIMEOUT_MS)
            const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
            return fetch(input, { ...init, signal })
          }
          const discovered = await fetchAvailableModels(auth.access, account.projectId, boundedFetch)
          const quotas = ingestFamilyQuotas(discovered)
          const updatedAt = Date.now()
          await this.store.mutate((s) => {
            const target = s.accounts.find((candidate) => this.accountKey(candidate) === key)
            if (target) {
              if (Object.keys(quotas).length > 0) target.cachedQuota = quotas
              target.cachedQuotaUpdatedAt = updatedAt
            }
          })
        } catch {
          // quota stays unmeasured — ranking falls back to rotation order
        }
      })()
      this.quotaRefreshInFlight.set(key, refresh)
      try {
        await refresh
      } finally {
        this.quotaRefreshInFlight.delete(key)
      }
    }))
  }

  /**
   * Pick the account for one request: the affinity pin wins while it is fresh,
   * healthy, and not drained for the requested model; otherwise the pool is
   * ranked by family-scoped usage (OMP-aligned) and the best candidate wins.
   */
  private async pickAccount(storage: AccountStorageV4, model?: string): Promise<{ account: ManagedAccount; index: number } | undefined> {
    const now = Date.now()
    for (const account of storage.accounts) clearExpiredState(account, now)

    const family = modelFamilyOf(model)
    // Session affinity (time-window approximation): reuse the last-used account
    // while it is fresh and healthy, so one conversation stays on one account
    // (upstream prefix cache + sessionId continuity). A drained family or a
    // cooldown breaks the pin and re-ranks, mirroring OMP's pinned-until-unusable.
    if (this.lastUsed && now - this.lastUsed.at < SESSION_AFFINITY_WINDOW_MS) {
      const last = storage.accounts[this.lastUsed.index]
      if (last && last.enabled !== false && !isCoolingDown(last, now) && !isFamilyDrained(last, family)) {
        return { account: last, index: this.lastUsed.index }
      }
    }

    const eligible = storage.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => account.enabled !== false)
    if (eligible.length === 0) return undefined
    if (eligible.length === 1) return eligible[0]

    const [picked] = rankPoolCandidates(eligible, model, now, storage.activeIndex)
    if (!picked) return eligible[0]
    if (picked.index !== storage.activeIndex) {
      storage.activeIndex = picked.index
      await this.store.save(storage)
    }
    return { account: picked.account, index: picked.index }
  }

  /**
   * Adapter hook: resolve the active session (refresh if needed), healing a
   * missing projectId at request time — the OAuth-time loadCodeAssist may have
   * transiently failed even when the Google account owns a Cloud Code project
   * (mirrors OmniRoute's ensureAntigravityProjectAssigned + persistence).
   * @param model - requested model id; drives family-scoped quota ranking.
   */
  async getSession(model?: string): Promise<AgyAccountSession | undefined> {
    const initial = await this.store.load()
    await this.refreshQuotaCache(initial)
    // The quota refresh persists through the store; re-read so the ranking
    // below sees the fresh cache it just wrote.
    const storage = await this.store.load()
    const picked = await this.pickAccount(storage, model)
    if (!picked) return undefined

    const auth = await this.accessTokenFor(picked.account)
    if (!auth) return undefined

    const key = this.accountKey(picked.account)
    if (!picked.account.projectId && !this.projectRetryFailed.has(key)) {
      try {
        const { loadCodeAssist } = await import('./oauth/exchange.ts')
        const { projectId } = await loadCodeAssist(auth.access)
        if (projectId) {
          await this.store.mutate((s) => {
            const account = s.accounts[picked.index]
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

    this.lastUsed = { index: picked.index, at: Date.now() }
    return {
      auth,
      account: picked.account,
      index: picked.index,
      impersonation: impersonationHeadersFor(picked.account),
    }
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
    },
  ): Promise<void> {
    const storage = await this.store.load()
    const account = storage.accounts[session.index]
    if (!account) return

    const key = this.accountKey(account)
    const consecutive = (this.failureCounts.get(key) ?? 0) + 1
    this.failureCounts.set(key, consecutive)

    const decision = decideRotation(kind, account, consecutive, info?.retryAfterMs, info?.rateLimitCategory, info?.resetTime)

    if (kind === 'rate-limit' && info?.resetTime) {
      // Family-scoped bookkeeping of the real reset (display + ranking wall).
      recordRateLimit(account, familyKeyOf(info?.model), Date.parse(info.resetTime) || Date.now() + 60_000)
    }

    if (decision.action === 'revoke') {
      this.tokenCache.delete(key)
      this.failureCounts.delete(key)
      await this.store.save(storage)
      return
    }

    // Fingerprint lifecycle: create on first rate-limit, regenerate after
    // repeated failures (bounded by history inside recordFingerprintVersion).
    // UA versions come from the version resolver (bounded, cached 6h) so
    // fingerprints never pin a stale Antigravity client version. The `stable`
    // risk mode pins one identity per account: create once, never regenerate.
    if (kind === 'rate-limit') {
      if (!account.fingerprint) {
        account.fingerprint = generateFingerprint(undefined, await resolveAntigravityVersionBounded())
        account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, account.fingerprint, 'initial')
      } else {
        // In-place UA refresh from the cached version (no network on this path).
        const cached = peekCachedAntigravityVersion()
        if (cached) updateFingerprintVersion(account.fingerprint, cached)
        if (fingerprintMode() !== 'stable' && consecutive >= 2) {
          const fresh = generateFingerprint(undefined, await resolveAntigravityVersionBounded())
          account.fingerprintHistory = recordFingerprintVersion(account.fingerprintHistory, fresh, 'regenerated')
          account.fingerprint = fresh
        }
      }
    }

    if (decision.action === 'rotate') {
      const nextIndex = pickNextAccountIndex(storage.accounts, session.index)
      if (nextIndex !== session.index) {
        storage.activeIndex = nextIndex
        this.onRotate?.(session.index, nextIndex, kind)
      }
      // The pinned account failed — drop the affinity so the pool re-balances.
      this.lastUsed = null
    }

    await this.store.save(storage)
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
   */
  async testCall(model: string, prompt = 'Reply with exactly: OK', maxTokens = 1024): Promise<{ ok: boolean; text?: string; error?: string }> {
    const session = await this.getSession()
    if (!session) return { ok: false, error: 'No agy account configured — run `dsh-agy login` first.' }
    try {
      const { toAgyRequestBody } = await import('./adapter/translate.ts')
      const { fetchAgyFirstOk } = await import('./oauth/constants.ts')
      const { parseAgySse } = await import('./adapter/parse.ts')
      const body = toAgyRequestBody(
        {
          provider: 'agy',
          model,
          messages: [{ id: 'test-1', role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens,
        } as never,
        { projectId: session.account.projectId, sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined },
      )
      const headers = {
        authorization: `Bearer ${session.auth.access}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...session.impersonation,
      }
      const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` }
      }
      if (!response.body) return { ok: false, error: 'no response body' }
      const text: string[] = []
      for await (const chunk of parseAgySse(response.body)) {
        if (chunk.type === 'text-delta') text.push(chunk.text)
      }
      return { ok: text.length > 0, text: text.join(''), error: text.length > 0 ? undefined : 'empty response' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Export one account as a paste-credential blob (for migration to another host). */
  async exportBlob(index: number): Promise<{ blob?: string; error?: string }> {
    const storage = await this.store.load()
    const account = storage.accounts[index]
    if (!account) return { error: 'account not found' }
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
  }

  /** Probe one account: refresh + userinfo; a live credential re-enables the account. */
  private async probeAccount(index: number, account: ManagedAccount): Promise<{ ok: boolean; email?: string; error?: string }> {
    const auth = await this.accessTokenFor(account)
    if (!auth) return { ok: false, error: 'refresh failed (revoked?)' }
    try {
      const response = await proxiedFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { Authorization: `Bearer ${auth.access}` },
      })
      if (!response.ok) return { ok: false, error: `userinfo ${response.status}` }
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
      return { ok: true, email: info.email }
    } catch (error) {
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
