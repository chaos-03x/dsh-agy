/**
 * Rotation state machine: decides retry / cool / rotate / revoke for one failed
 * attempt, with tiered backoff and soft-quota pre-checks.
 */

import type { CachedQuota, FailureKind, ManagedAccount, RotationAction } from '../types.ts'
import type { RateLimitCategory } from './classify.ts'

export const BACKOFF_TIERS_MS = [5_000, 10_000, 20_000, 30_000, 60_000] as const

/** Below this remaining fraction the account is treated as soft-quota-exhausted. */
export const SOFT_QUOTA_THRESHOLD = 0.15

/**
 * The WEEKLY window's exhaustion threshold, and deliberately NOT
 * `SOFT_QUOTA_THRESHOLD`.
 *
 * The two numbers answer the same question — "how much work is left in this
 * window?" — about windows of very different lengths, so they only look
 * inconsistent when read side by side:
 *
 *   15% of a 5-hour window is ~45 minutes of runway.
 *   1%  of a 7-day window  is ~1.7 hours of runway.
 *
 * The weekly bar is the stricter one where it matters, because being wrong is
 * asymmetric: a drained 5-hour window refills within five hours, while a drained
 * weekly window parks the account for DAYS. Treating an account as drained a
 * little early costs one rotation; treating it as usable too late costs the user
 * a failed request with no healthy fallback.
 *
 * Do not "unify" these two constants without re-deriving both runways above.
 */
export const WEEKLY_QUOTA_THRESHOLD = 0.01

/**
 * Concurrent upstream requests one account may carry before selection prefers
 * another. A real Antigravity window serves one conversation at a time, so
 * several simultaneous streams from one account is a shape the official client
 * does not produce. The cap is generous on purpose: it should only bite under
 * genuine fan-out (many parallel conversations), not on ordinary tool loops.
 */
export const MAX_IN_FLIGHT_PER_ACCOUNT = 3

/**
 * In-flight accounting older than this is treated as leaked and discarded.
 *
 * The counter is released by the adapter's `finally`, which runs on completion,
 * error, and early consumer termination alike — but a process killed mid-request
 * cannot release anything, and a stuck counter would permanently deprioritize an
 * account. The sweep bounds that to one TTL.
 */
export const IN_FLIGHT_STALE_MS = 10 * 60 * 1000

function backoffFor(consecutiveFailures: number, maxJitterMs = 1_000): number {
  const index = Math.min(Math.max(consecutiveFailures, 0), BACKOFF_TIERS_MS.length - 1)
  const base = BACKOFF_TIERS_MS[index] ?? BACKOFF_TIERS_MS[BACKOFF_TIERS_MS.length - 1]!
  return base + Math.floor(Math.random() * maxJitterMs)
}

/** Whether the account is currently in a cooldown window. */
export function isCoolingDown(account: ManagedAccount, now = Date.now()): boolean {
  return (account.coolingDownUntil ?? 0) > now
}

/** Whether the requested model family on this account is rate-limited. */
export function isFamilyRateLimited(account: ManagedAccount, family: string | undefined, now = Date.now()): boolean {
  if (!family) return false
  const resetAt = account.rateLimitResetTimes?.[family]
  return typeof resetAt === 'number' && resetAt > now
}

/**
 * Proxy for a pool-level probe that belongs to no single account (the version
 * feeds): the account that would serve the next request, else the first usable
 * one.
 *
 * These feeds are not account-scoped, but the host's IP is what a user who
 * configured per-account proxies asked to hide, and a probe on the env/direct
 * route leaks it at boot. `undefined` means "no account route" — no accounts, or
 * no usable one — and the caller then uses the env/direct route, which is also
 * where an unproxied account's traffic goes anyway.
 *
 * Deliberately not model-aware: the probe runs once at boot, before any model is
 * requested.
 */
export function pickProbeProxyUrl(
  accounts: ManagedAccount[],
  activeIndex: number,
  now = Date.now(),
): string | undefined {
  const usable = (account: ManagedAccount | undefined): boolean =>
    account !== undefined && account.enabled !== false && !isCoolingDown(account, now)
  const active = accounts[activeIndex]
  if (usable(active)) return active!.proxy
  return accounts.find((account) => usable(account))?.proxy
}

/** Record a rate-limit reset for one model key, retaining the latest reset time. */
export function recordRateLimit(account: ManagedAccount, modelKey: string, resetAtMs: number): void {
  const current = account.rateLimitResetTimes?.[modelKey] ?? 0
  account.rateLimitResetTimes = {
    ...(account.rateLimitResetTimes ?? {}),
    [modelKey]: Math.max(current, resetAtMs),
  }
}

/** Clear expired rate limits and cooldowns in place. */
export function clearExpiredState(account: ManagedAccount, now = Date.now()): void {
  if (account.rateLimitResetTimes) {
    const fresh = Object.fromEntries(
      Object.entries(account.rateLimitResetTimes).filter(([, reset]) => reset > now),
    )
    account.rateLimitResetTimes = Object.keys(fresh).length > 0 ? fresh : undefined
  }
  if (account.coolingDownUntil && account.coolingDownUntil <= now) {
    account.coolingDownUntil = undefined
    account.cooldownReason = undefined
    // The age is only meaningful while the window it describes is live; leaving
    // it behind would let a stale timestamp pair with a future cooldown.
    account.cooldownSetAt = undefined
  }
}

/** 24h cooldown for a fully exhausted daily quota (single-account: stop hitting the wall). */
export const FULL_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000
/** 5min cooldown for per-minute rate limits. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000
/** Cap for a server-reported reset time on per-minute limits (guards against bogus far-future values). */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000

/**
 * How long a verification challenge parks an account before the pool tries it
 * again. Deliberately short and timed rather than permanent: the credential is
 * intact, the wall is upstream's, and it can clear on its own — so the account
 * returns to service without the user doing anything, while still not being
 * hammered in the meantime.
 */
export const VERIFICATION_COOLDOWN_MS = 15 * 60 * 1000

/** Absolute server-reported reset in ms when it lies in the future, else undefined. */
export function parseFutureResetMs(resetTime: string | undefined, now = Date.now()): number | undefined {
  if (!resetTime) return undefined
  const reset = Date.parse(resetTime)
  if (Number.isNaN(reset) || reset <= now) return undefined
  return reset
}

/**
 * Decide what to do after one failed attempt.
 * @param kind - classified failure kind.
 * @param category - 429 sub-category when kind is rate-limit.
 * @param account - the account that failed (mutated with cooldown/rate-limit state).
 * @param consecutiveFailures - consecutive failures on this account.
 * @param retryAfterMs - server-provided retry delay when present.
 * @param resetTime - server-provided absolute reset time; cooldowns use it (capped) instead of fixed windows.
 */
export function decideRotation(
  kind: FailureKind,
  account: ManagedAccount,
  consecutiveFailures: number,
  retryAfterMs?: number,
  category: RateLimitCategory = 'unknown',
  resetTime?: string,
): RotationAction {
  const now = Date.now()
  const backoffMs = backoffFor(consecutiveFailures)

  switch (kind) {
    case 'rate-limit': {
      if (category === 'soft_rate_limit') {
        // Transient burst: retry the same account almost immediately.
        return { action: 'retry', backoffMs: Math.min(retryAfterMs ?? backoffMs, 3000) }
      }
      if (category === 'quota_exhausted') {
        // Daily/plan quota gone: cool until the real reset when the backend
        // reported one (capped at 24h), else the fixed daily window.
        const resetMs = parseFutureResetMs(resetTime, now)
        const cooldownMs = resetMs !== undefined
          ? Math.min(resetMs - now, FULL_QUOTA_COOLDOWN_MS)
          : FULL_QUOTA_COOLDOWN_MS
        account.coolingDownUntil = now + Math.max(cooldownMs, 60_000)
        account.cooldownReason = 'quota-exhausted'
        account.cooldownSetAt = now
        return { action: 'cool', backoffMs: Math.max(cooldownMs, 60_000) }
      }
      // Per-minute rate limit: prefer the server's real reset (capped), then
      // Retry-After, then the fixed short window. The family-scoped reset is
      // recorded in account.rateLimitResetTimes, so other model families on
      // this account stay unblocked (AuthStorage-aligned).
      const resetMs = parseFutureResetMs(resetTime, now)
      const cooldownMs = resetMs !== undefined
        ? Math.min(resetMs - now, MAX_RATE_LIMIT_COOLDOWN_MS)
        : (retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS)
      return { action: 'rotate', backoffMs: Math.max(cooldownMs, 1000) }
    }
    case 'auth-failure': {
      // Terminal: account credentials are dead; never auto-recover.
      //
      // One `invalid_grant` is enough, and that is a decision: the code means the
      // refresh token no longer works, and rotating/re-probing a dead credential
      // only burns requests. Another implementation demands repeated
      // confirmation, but it has more failure modes to tell apart (its own
      // decrypt path, a swappable OAuth app); here a false positive costs one
      // `dsh-agy verify`, which re-enables the account on success.
      account.verificationRequired = true
      account.verificationRequiredAt = now
      account.verificationRequiredReason = 'auth-failure'
      account.enabled = false
      return { action: 'revoke' }
    }
    case 'verification-required': {
      // Recoverable, and NOT a credential failure: the upstream is asking the
      // account owner to verify. Park the account for a timed window instead of
      // disabling it, so recovery needs no human action once the wall clears,
      // and keep the challenge state (plus the appeal URL, written by the caller)
      // so the UI can tell the user what happened.
      account.coolingDownUntil = now + VERIFICATION_COOLDOWN_MS
      account.cooldownReason = 'validation-required'
      account.cooldownSetAt = now
      account.verificationRequired = true
      account.verificationRequiredAt = now
      account.verificationRequiredReason = 'validation-required'
      return { action: 'cool', backoffMs: VERIFICATION_COOLDOWN_MS }
    }
    case 'network-error': {
      account.coolingDownUntil = now + backoffMs
      account.cooldownReason = 'network-error'
      account.cooldownSetAt = now
      return { action: 'rotate', backoffMs }
    }
    case 'project-error': {
      account.coolingDownUntil = now + backoffMs
      account.cooldownReason = 'project-error'
      account.cooldownSetAt = now
      return { action: 'cool', backoffMs }
    }
    case 'request-error': {
      // Request-construction error (e.g. generic 400): permanent, retrying
      // resends the same broken payload. No cooldown, no rotation, no revoke —
      // the adapter surfaces it as a terminal UPSTREAM error.
      return { action: 'noop' }
    }
    case 'transient': {
      return { action: 'retry', backoffMs }
    }
    case 'proxy-unreachable': {
      // Per-account proxy dead: fail-closed, skip this account for this request only.
      // Do NOT write coolingDownUntil / rateLimitResetTimes — next request may retry.
      return { action: 'rotate', backoffMs: Math.min(backoffMs, 1000) }
    }
  }
}

/**
 * Pick the next account index for rotation (round-robin across enabled,
 * non-cooling accounts; falls back to the active one when all are cooling).
 */
export function pickNextAccountIndex(
  accounts: ManagedAccount[],
  currentIndex: number,
  now = Date.now(),
  modelOrFamily?: string,
): number {
  if (accounts.length <= 1) return currentIndex
  const enabled = accounts.map((a, i) => ({ account: a, index: i }))
    .filter(({ account, index }) => {
      if (index === currentIndex || account.enabled === false) return false
      if (isCoolingDown(account, now)) return false
      if (modelOrFamily && isFamilyRateLimited(account, modelOrFamily, now)) return false
      return true
    })
  if (enabled.length === 0) return currentIndex
  // Round-robin: first candidate after current index, else first eligible.
  const after = enabled.find((e) => e.index > currentIndex)
  return (after ?? enabled[0]!)!.index
}

/**
 * Build the soft-quota cache TTL: short when low, long when healthy.
 *
 * Driven by the MOST pressured of the two windows, because they drain on
 * different clocks: an account sitting at 90% of its 5-hour bucket but 2% of its
 * week still has to be re-measured on the short interval, or a weekly exhaustion
 * is discovered only when a request fails.
 *
 * `weeklyFraction` is the optional SECOND parameter, so the two fractions sit
 * adjacent and `now` moved to third. No caller passes a timestamp.
 */
export function computeSoftQuotaCacheTtlMs(
  remainingFraction: number | undefined,
  weeklyFraction?: number,
  now = Date.now(),
): number {
  if (typeof remainingFraction === 'number' && remainingFraction < SOFT_QUOTA_THRESHOLD) return 60 * 1000
  if (typeof weeklyFraction === 'number' && weeklyFraction <= WEEKLY_QUOTA_THRESHOLD) return 60 * 1000
  if (typeof remainingFraction !== 'number' && typeof weeklyFraction !== 'number') return 10 * 60 * 1000
  if (typeof remainingFraction === 'number' && remainingFraction < 0.5) return 5 * 60 * 1000
  if (typeof weeklyFraction === 'number' && weeklyFraction < 0.2) return 5 * 60 * 1000
  return 15 * 60 * 1000
}

export type { CachedQuota }
