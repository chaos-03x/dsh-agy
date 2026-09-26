/**
 * Usage-aware account pool scheduling, aligned with oh-my-pi's
 * google-antigravity usage provider + ranking strategy (AuthStorage):
 *
 * - Backend quotas are counters scoped by model family (google/anthropic/openai);
 *   the requested model maps to one family via its id prefix.
 * - `fetchAvailableModels` quotaInfo entries are aggregated per family
 *   (most-pressured model wins the family's remaining fraction). That endpoint
 *   reports the rolling 5-hour counter and nothing else.
 * - `retrieveUserQuotaSummary` supplies the WINDOW dimension the other one lacks:
 *   it is the only source of the weekly reading, and its groups are mapped onto
 *   the same family keys by their bucket ids.
 * - BOTH windows gate selection. An exhausted weekly budget is invisible in the
 *   5-hour counter, so an account can look healthy on every probe and still be
 *   unable to serve a single request.
 * - Candidates rank by: unblocked first, hot windows last, measured usage before
 *   unmeasured, required-drain descending (headroom / hours-to-reset — "use it
 *   or lose it"), then used-fraction ascending. Exhausted families block the
 *   account until their real reset time.
 */

import type { DiscoveredModels } from '../adapter/models.ts'
import type { CachedQuota, ManagedAccount, QuotaGroup, QuotaWindow } from '../types.ts'
import {
  SOFT_QUOTA_THRESHOLD,
  WEEKLY_QUOTA_THRESHOLD,
  computeSoftQuotaCacheTtlMs,
} from './rotation.ts'

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
 * The families a quota group's WINDOW BUCKET ID belongs to.
 *
 * `retrieveUserQuotaSummary` labels its buckets with upstream's own counters —
 * measured ids are `gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly` — which
 * is the same taxonomy `modelFamilyOf` mirrors. Reading the bucket id is
 * therefore a machine-readable lookup rather than a guess at a human label.
 *
 * `3p-` maps to TWO families on purpose, and that is not a shortcut: upstream
 * counts Claude and GPT under one third-party counter, so the weekly budget
 * belongs to both. No model-id prefix rule can recover that split, which is why
 * the mapping lives here rather than in `modelFamilyOf`.
 */
export function familiesForBucketId(bucketId: string): ModelFamily[] {
  const id = bucketId.toLowerCase()
  if (id.startsWith('gemini-')) return ['google']
  if (id.startsWith('3p-') || id.startsWith('third_party-')) return ['anthropic', 'openai']
  if (id.startsWith('claude-')) return ['anthropic']
  if (id.startsWith('gpt-') || id.startsWith('openai-')) return ['openai']
  return []
}

/**
 * The families a group's LABEL covers, consulted only when no bucket id was
 * recognizable.
 *
 * Upstream's groups are its own taxonomy, not ours, and the measured labels are
 * `Gemini Models` and `Claude and GPT models` — the second spans two families,
 * so this is a 1-to-N mapping. It is a FALLBACK, not the primary rule: matching
 * words in a display string is the fragile half, and it survives only so that a
 * bucket id upstream renames still lands somewhere sensible.
 *
 * A label naming nothing we recognize maps to NO family deliberately.
 * Attributing an unknown group's budget to `google` would block healthy
 * accounts; leaving it unmapped only means that family stays unmeasured, which
 * is exactly the state before this function existed.
 */
export function familiesForGroupName(name: string): ModelFamily[] {
  const label = name.toLowerCase()
  const families: ModelFamily[] = []
  if (label.includes('gemini') || label.includes('google')) families.push('google')
  const claude = label.includes('claude')
  const gpt = label.includes('gpt')
  if (claude && gpt) families.push('anthropic', 'openai')
  else if (claude) families.push('anthropic')
  else if (gpt) families.push('openai')
  else if (families.length === 0 && (label.includes('3p') || label.includes('third'))) {
    families.push('anthropic', 'openai')
  }
  return families
}

/** Which of the two tracked windows an upstream window token names. */
function windowKind(window: string): 'rolling' | 'weekly' | undefined {
  const token = window.toLowerCase()
  if (token.includes('5h')) return 'rolling'
  if (token.includes('weekly') || token.includes('week') || token.includes('7d')) return 'weekly'
  return undefined
}

/** The families one group belongs to: its bucket ids first, its label second. */
export function familiesForGroup(group: QuotaGroup): ModelFamily[] {
  const families: ModelFamily[] = []
  const add = (family: ModelFamily) => {
    if (!families.includes(family)) families.push(family)
  }
  for (const window of group.windows) {
    for (const family of familiesForBucketId(window.bucketId)) add(family)
  }
  if (families.length === 0) {
    for (const family of familiesForGroupName(group.name)) add(family)
  }
  return families
}

/**
 * Aggregate the grouped `retrieveUserQuotaSummary` windows into per-family
 * records — the ONLY source of the weekly window.
 *
 * `fetchAvailableModels` cannot supply it: its `quotaInfo` carries exactly
 * `remainingFraction` and `resetTime`, with no window field at all, which is why
 * a weekly limit used to be invisible to rotation.
 *
 * Two groups can land on one family (upstream may split `3p` later), so each
 * window keeps the MOST pressured reading rather than letting the last group
 * win — the same rule the per-model merge below uses.
 */
export function ingestQuotaGroups(groups: QuotaGroup[]): Record<string, CachedQuota> {
  const families = new Map<string, CachedQuota>()
  for (const group of groups) {
    const keys = familiesForGroup(group)
    if (keys.length === 0) continue
    let rolling: QuotaWindow | undefined
    let weekly: QuotaWindow | undefined
    for (const window of group.windows) {
      const kind = windowKind(window.window)
      if (kind === 'rolling') rolling ??= window
      else if (kind === 'weekly') weekly ??= window
    }
    for (const key of keys) {
      const current = families.get(key)
      const record: CachedQuota = { ...current }
      if (typeof rolling?.remainingFraction === 'number') {
        record.remainingFraction = current?.remainingFraction === undefined
          ? rolling.remainingFraction
          : Math.min(current.remainingFraction, rolling.remainingFraction)
        const resetTime = earliestResetTime(current?.resetTime, rolling.resetTime ?? undefined)
        if (resetTime) record.resetTime = resetTime
      }
      if (typeof weekly?.remainingFraction === 'number') {
        record.weeklyFraction = current?.weeklyFraction === undefined
          ? weekly.remainingFraction
          : Math.min(current.weeklyFraction, weekly.remainingFraction)
        const weeklyResetTime = earliestResetTime(current?.weeklyResetTime, weekly.resetTime ?? undefined)
        if (weeklyResetTime) record.weeklyResetTime = weeklyResetTime
      }
      families.set(key, record)
    }
  }
  return Object.fromEntries(families)
}

/**
 * Aggregate a `fetchAvailableModels` response, and when available the grouped
 * `retrieveUserQuotaSummary` windows, into per-family quota records.
 *
 * The two sources describe the same counters from different angles, so they are
 * merged rather than kept apart:
 *   - per MODEL `quotaInfo.remainingFraction` is the rolling 5-hour counter, and
 *     the family takes its most-pressured model (the bottleneck resets first);
 *   - per GROUP summary windows add the weekly budget, which has no per-model
 *     representation at all.
 *
 * `previous` is the account's existing cache, and it exists so a probe that
 * reports only one of the two windows cannot ERASE the other. The measured
 * reason: `fetchQuotaSummary` returns `[]` instead of throwing, so without the
 * carry-forward one timing-out endpoint would drop a known-drained weekly window
 * and put an exhausted account straight back into rotation.
 *
 * Carrying that value is safe next to a fresh 5-hour reading because it keeps its
 * own `weeklyResetTime`: once that moment passes, `isFamilyDrained` and
 * `parseFutureResetMs` both ignore the reading, so a stale weekly cannot outlive
 * the window it describes.
 */
export function ingestFamilyQuotas(
  discovered: DiscoveredModels,
  groups?: QuotaGroup[] | null,
  previous?: Record<string, CachedQuota> | null,
): Record<string, CachedQuota> {
  const families = new Map<string, CachedQuota>()
  if (groups && groups.length > 0) {
    for (const [key, quota] of Object.entries(ingestQuotaGroups(groups))) {
      families.set(key, { ...quota })
    }
  }
  for (const [modelId, entry] of Object.entries(discovered.models ?? {})) {
    const remaining = entry.quotaInfo?.remainingFraction
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
    const key = familyKeyOf(modelId)
    const current = families.get(key)
    const resetTime = earliestResetTime(current?.resetTime, entry.quotaInfo?.resetTime)
    families.set(key, {
      ...current,
      remainingFraction: current?.remainingFraction === undefined
        ? remaining
        : Math.min(current.remainingFraction, remaining),
      ...(resetTime ? { resetTime } : {}),
      modelCount: (current?.modelCount ?? 0) + 1,
    })
  }
  if (previous) {
    for (const [key, prev] of Object.entries(previous)) {
      const current = families.get(key)
      if (!current) continue
      // Carry the weekly reading forward only. It is the one field the per-model
      // probe cannot supply, so its absence means "this probe did not ask", not
      // "the weekly budget is empty". A family absent from BOTH sources is left
      // out on purpose: upstream treats an unreported family as unmeasured, and
      // resurrecting the whole record would keep a stale 5-hour fraction alive.
      if (current.weeklyFraction === undefined && prev.weeklyFraction !== undefined) {
        families.set(key, {
          ...current,
          weeklyFraction: prev.weeklyFraction,
          ...(current.weeklyResetTime === undefined && prev.weeklyResetTime !== undefined
            ? { weeklyResetTime: prev.weeklyResetTime }
            : {}),
        })
      }
    }
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
  const ttl = computeSoftQuotaCacheTtlMs(mostPressured?.remainingFraction, mostPressured?.weeklyFraction)
  return now - account.cachedQuotaUpdatedAt > ttl
}

/** How long a measured 5h/weekly window snapshot stays fresh. */
export const LIMITS_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Whether the display-only windows need a refresh.
 *
 * A SEPARATE rule from `isQuotaStale` on purpose: that one keys off
 * `cachedQuota`/`cachedQuotaUpdatedAt`, which the scheduling path fills and a
 * SOLO account never does (the pool gate skips it). Reusing it here would report
 * "stale" on every single call for a solo account and re-probe the endpoint
 * continuously — the exact case this feature exists to serve.
 *
 * A fixed TTL is also the honest choice: the windows come from their own
 * endpoint, so there is no `remainingFraction` on hand to scale the interval by
 * without reading the very data being validated.
 *
 * @param account - the account to test.
 * @param now - current time (Unix ms).
 */
export function isLimitsStale(account: ManagedAccount, now = Date.now()): boolean {
  const updatedAt = account.cachedLimits?.updatedAt
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return true
  return now - updatedAt > LIMITS_CACHE_TTL_MS
}

/** Whether a reset moment has already passed. An absent or malformed one has not. */
function resetInPast(resetTime: string | undefined, now: number): boolean {
  if (!resetTime) return false
  const reset = Date.parse(resetTime)
  return !Number.isNaN(reset) && reset <= now
}

/**
 * Whether the requested family on this account is soft-quota-exhausted.
 *
 * BOTH windows are checked, because they refill on different clocks. The 5-hour
 * bucket can be nearly empty while the weekly budget is untouched, and the
 * reverse — a spent weekly budget stays spent across four 5-hour refills. Before
 * this, only the 5-hour reading was consulted, so an account whose week was over
 * kept being selected until a real request failed.
 *
 * A window whose reset has already passed is IGNORED rather than read: its
 * fraction describes a window that no longer exists, so the account stays
 * selectable until the next measurement replaces the stale value.
 */
export function isFamilyDrained(account: ManagedAccount, family?: ModelFamily, now = Date.now()): boolean {
  const quota = familyQuotaFor(account, family)
  if (!quota) return false
  if (
    typeof quota.remainingFraction === 'number'
    && !resetInPast(quota.resetTime, now)
    && quota.remainingFraction < SOFT_QUOTA_THRESHOLD
  ) {
    return true
  }
  if (
    typeof quota.weeklyFraction === 'number'
    && !resetInPast(quota.weeklyResetTime, now)
    && quota.weeklyFraction <= WEEKLY_QUOTA_THRESHOLD
  ) {
    return true
  }
  return false
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
  const activePos = entries.findIndex((e) => e.index === startIndex)
  const clampedStart = activePos >= 0 ? activePos : 0
  const ordered = entries.length === 0 ? [] : [...entries.slice(clampedStart), ...entries.slice(0, clampedStart)]
  const candidates: PoolCandidateWithOrder[] = ordered.map(({ account, index }, orderPos) => {
    const quota = familyQuotaFor(account, family)
    const remaining = quota?.remainingFraction
    const used = typeof remaining === 'number' ? Math.min(Math.max(1 - remaining, 0), 1) : undefined
    const weeklyRemaining = quota?.weeklyFraction
    const weeklyUsed = typeof weeklyRemaining === 'number'
      ? Math.min(Math.max(1 - weeklyRemaining, 0), 1)
      : undefined

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
    //
    // Both windows are consulted and the LATER reset wins: an account with a
    // spent 5-hour bucket and a spent week must wait for the week, not for the
    // bucket that refills in an hour.
    if (blockedUntil === null && quota) {
      const resetMs = typeof remaining === 'number' && remaining <= 0
        ? parseFutureResetMs(quota.resetTime, now)
        : undefined
      if (resetMs !== undefined) blockedUntil = resetMs
      const weeklyResetMs = typeof weeklyRemaining === 'number' && weeklyRemaining <= 0
        ? parseFutureResetMs(quota.weeklyResetTime, now)
        : undefined
      if (weeklyResetMs !== undefined) {
        blockedUntil = blockedUntil === null ? weeklyResetMs : Math.max(blockedUntil, weeklyResetMs)
      }
    }

    return {
      account,
      index,
      orderPos,
      blockedUntil,
      usedFraction: used,
      requiredDrain: requiredDrainFor(quota, now),
      hot: (used !== undefined && used >= PRIMARY_WINDOW_HOT_FRACTION)
        || (weeklyUsed !== undefined && weeklyUsed >= PRIMARY_WINDOW_HOT_FRACTION),
      measured: used !== undefined || weeklyUsed !== undefined,
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
