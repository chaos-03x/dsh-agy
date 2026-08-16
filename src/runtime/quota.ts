/**
 * Usage-aware account pool scheduling, aligned with oh-my-pi's
 * google-antigravity usage provider + ranking strategy (AuthStorage):
 *
 * - Backend quotas are counters scoped by model family (google/anthropic/openai);
 *   the requested model maps to one family via its id prefix.
 * - `fetchAvailableModels` quotaInfo entries are aggregated per family
 *   (most-pressured model wins the family's remaining fraction).
 * - Candidates rank by: unblocked first, hot windows last, measured usage before
 *   unmeasured, required-drain descending (headroom / hours-to-reset — "use it
 *   or lose it"), then used-fraction ascending. Exhausted families block the
 *   account until their real reset time.
 */

import type { DiscoveredModels } from '../adapter/models.ts'
import type { CachedQuota, ManagedAccount } from '../types.ts'
import { SOFT_QUOTA_THRESHOLD, computeSoftQuotaCacheTtlMs } from './rotation.ts'

export type ModelFamily = 'google' | 'anthropic' | 'openai'

/** Family bucket for model ids with no recognizable prefix (mirrors OMP's counter:unknown). */
export const FAMILY_UNKNOWN = 'unknown'

/** Mirrors AuthStorage.PRIMARY_WINDOW_HOT_FRACTION: near-exhausted windows rank last. */
export const PRIMARY_WINDOW_HOT_FRACTION = 0.85

const DAY_MS = 24 * 60 * 60 * 1000
/** Floor for remaining-time in drain-urgency scores (mirrors AuthStorage; a stale reset must not explode the score). */
const DRAIN_FLOOR_MS = 60_000

/** Map a model id to its backend quota counter family (OMP getAntigravityCounterKeyForModel). */
export function modelFamilyOf(modelId?: string): ModelFamily | undefined {
  if (!modelId) return undefined
  const id = modelId.toLowerCase()
  if (id.startsWith('claude-')) return 'anthropic'
  if (id.startsWith('gemini-') || id.startsWith('gemma-')) return 'google'
  if (id.startsWith('gpt-') || id.startsWith('openai/')) return 'openai'
  return undefined
}

/** Quota-cache key for a request: the model's family, or the unknown bucket. */
export function familyKeyOf(modelId?: string): string {
  return modelFamilyOf(modelId) ?? FAMILY_UNKNOWN
}

function earliestResetTime(a?: string, b?: string): string | undefined {
  if (!a) return b
  if (!b) return a
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (Number.isNaN(ta)) return b
  if (Number.isNaN(tb)) return a
  return ta <= tb ? a : b
}

/**
 * Aggregate a fetchAvailableModels response into per-family quota records:
 * the family's remaining fraction is its most-pressured model's, and the
 * reset time is the earliest across the family (the bottleneck resets first).
 */
export function ingestFamilyQuotas(discovered: DiscoveredModels): Record<string, CachedQuota> {
  const families = new Map<string, CachedQuota>()
  for (const [modelId, entry] of Object.entries(discovered.models ?? {})) {
    const remaining = entry.quotaInfo?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const key = familyKeyOf(modelId)
    const current = families.get(key)
    const resetTime = earliestResetTime(current?.resetTime, entry.quotaInfo?.resetTime)
    families.set(key, {
      remainingFraction: current ? Math.min(current.remainingFraction ?? 1, remaining) : remaining,
      ...(resetTime ? { resetTime } : {}),
      modelCount: (current?.modelCount ?? 0) + 1,
    })
  }
  return Object.fromEntries(families)
}

/** The quota record for one family, or the most-pressured family when the model is unknown. */
export function familyQuotaFor(account: ManagedAccount, family?: ModelFamily): CachedQuota | undefined {
  const cache = account.cachedQuota ?? {}
  if (family) return cache[family]
  let worst: CachedQuota | undefined
  for (const entry of Object.values(cache)) {
    if (typeof entry.remainingFraction !== 'number') continue
    if (!worst || entry.remainingFraction < (worst.remainingFraction ?? 1)) worst = entry
  }
  return worst
}

/** Whether the account's quota cache needs a refresh (missing, or past its health-based TTL). */
export function isQuotaStale(account: ManagedAccount, now = Date.now()): boolean {
  if (!account.cachedQuota || !account.cachedQuotaUpdatedAt) return true
  const mostPressured = familyQuotaFor(account)
  const ttl = computeSoftQuotaCacheTtlMs(mostPressured?.remainingFraction)
  return now - account.cachedQuotaUpdatedAt > ttl
}

/** Whether the requested family on this account is soft-quota-exhausted (below the pre-check threshold). */
export function isFamilyDrained(account: ManagedAccount, family?: ModelFamily, now = Date.now()): boolean {
  const quota = familyQuotaFor(account, family)
  if (!quota || typeof quota.remainingFraction !== 'number') return false
  if (quota.resetTime) {
    const reset = Date.parse(quota.resetTime)
    if (!Number.isNaN(reset) && reset <= now) return false
  }
  return quota.remainingFraction < SOFT_QUOTA_THRESHOLD
}

/**
 * Required drain rate: headroomFraction / remainingHours — how fast the
 * family's remaining quota must be consumed to avoid expiring unused at its
 * reset (mirrors AuthStorage.#computeWindowRequiredDrain with a daily window).
 */
export function requiredDrainFor(quota: CachedQuota | undefined, now = Date.now()): number {
  const remaining = quota?.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return 0
  // Headroom IS the remaining fraction (mirrors AuthStorage: headroom = 1 - used).
  const headroom = Math.min(Math.max(remaining, 0), 1)
  if (headroom <= 0) return 0
  let remainingMs = DAY_MS
  const resetTime = quota?.resetTime
  if (resetTime) {
    const resetAt = Date.parse(resetTime)
    if (!Number.isNaN(resetAt)) remainingMs = Math.min(remainingMs, Math.max(resetAt - now, 0))
  }
  const remainingHours = Math.max(remainingMs, DRAIN_FLOOR_MS) / (60 * 60 * 1000)
  return headroom / remainingHours
}

export interface PoolCandidate {
  account: ManagedAccount
  index: number
  /** Cooldown/limit wall blocking this account (null when usable). */
  blockedUntil: number | null
  /** Used fraction of the requested family's quota (measured accounts only). */
  usedFraction?: number
  requiredDrain: number
  hot: boolean
  measured: boolean
}

/** Candidate with its rotation-order position, used only while sorting. */
interface PoolCandidateWithOrder extends PoolCandidate {
  orderPos: number
}

function parseFutureResetMs(resetTime: string | undefined, now: number): number | undefined {
  if (!resetTime) return undefined
  const reset = Date.parse(resetTime)
  if (Number.isNaN(reset) || reset <= now) return undefined
  return reset
}

/**
 * Rank pool candidates for one request, mirroring AuthStorage's antigravity
 * ordering: unblocked first (earliest unblock time among blocked), hot windows
 * last, measured usage before unmeasured, required-drain descending, then
 * used-fraction ascending. Ties preserve the rotation order seeded from
 * `startIndex` so an unmeasured pool keeps the active-account bias.
 */
export function rankPoolCandidates(
  entries: ReadonlyArray<{ account: ManagedAccount; index: number }>,
  modelId: string | undefined,
  now = Date.now(),
  startIndex = 0,
): PoolCandidate[] {
  const family = modelFamilyOf(modelId)
  const clampedStart = entries.length === 0 ? 0 : Math.min(Math.max(startIndex, 0), entries.length - 1)
  const ordered = entries.length === 0 ? [] : [...entries.slice(clampedStart), ...entries.slice(0, clampedStart)]

  const candidates: PoolCandidateWithOrder[] = ordered.map(({ account, index }, orderPos) => {
    const quota = familyQuotaFor(account, family)
    const remaining = quota?.remainingFraction
    const used = typeof remaining === 'number' ? Math.min(Math.max(1 - remaining, 0), 1) : undefined

    let blockedUntil: number | null = null
    if (account.coolingDownUntil && account.coolingDownUntil > now) {
      blockedUntil = account.coolingDownUntil
    }
    const familyLimit = account.rateLimitResetTimes?.[familyKeyOf(modelId)]
    if (familyLimit !== undefined && familyLimit > now) {
      blockedUntil = blockedUntil === null ? familyLimit : Math.max(blockedUntil, familyLimit)
    }
    // A measured zero-remaining family with a future reset blocks the account
    // until the real reset (mirrors AuthStorage usage-limit blocking); drained
    // (low but non-zero) families are ranked, not blocked.
    if (blockedUntil === null && quota && typeof remaining === 'number' && remaining <= 0) {
      const resetMs = parseFutureResetMs(quota.resetTime, now)
      if (resetMs !== undefined) blockedUntil = resetMs
    }

    return {
      account,
      index,
      orderPos,
      blockedUntil,
      usedFraction: used,
      requiredDrain: requiredDrainFor(quota, now),
      hot: used !== undefined && used >= PRIMARY_WINDOW_HOT_FRACTION,
      measured: used !== undefined,
    }
  })

  candidates.sort((left, right) => {
    const leftBlocked = left.blockedUntil !== null
    const rightBlocked = right.blockedUntil !== null
    if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1
    if (leftBlocked && rightBlocked) return (left.blockedUntil ?? 0) - (right.blockedUntil ?? 0)
    if (left.hot !== right.hot) return left.hot ? 1 : -1
    if (left.measured !== right.measured) return left.measured ? -1 : 1
    const drain = right.requiredDrain - left.requiredDrain
    if (drain !== 0) return drain
    const usedDiff = (left.usedFraction ?? 0.5) - (right.usedFraction ?? 0.5)
    if (usedDiff !== 0) return usedDiff
    return left.orderPos - right.orderPos
  })

  return candidates.map(({ account, index, blockedUntil, usedFraction, requiredDrain, hot, measured }) => ({
    account, index, blockedUntil, usedFraction, requiredDrain, hot, measured,
  }))
}
