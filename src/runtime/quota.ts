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
import { QUOTA_WINDOWS } from '../types.ts'
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
 *
 * Window-aware as of #56: a bucket id resolves a family only when the window it
 * describes is one `CachedQuota` can hold AND the id agrees with the token (see
 * `agreedWindowKind`). The prefix and the window were two independent decisions
 * once, and an unrecognized window still claimed a family.
 */
export function familiesForBucketId(bucketId: string, window?: string): ModelFamily[] {
  const id = bucketId.toLowerCase()
  const families: ModelFamily[] = []
  if (id.startsWith('gemini-')) families.push('google')
  else if (id.startsWith('3p-') || id.startsWith('third_party-')) families.push('anthropic', 'openai')
  else if (id.startsWith('claude-')) families.push('anthropic')
  else if (id.startsWith('gpt-') || id.startsWith('openai-')) families.push('openai')
  if (families.length === 0) return []
  // Window-aware (see `agreedWindowKind`): a bucket whose window the cache cannot
  // hold — or whose id disagrees with the token — resolves NO family. The prefix
  // alone is not enough, because the field the reading lands in is chosen from
  // the token, and an unagreed pair files a weekly fraction as a 5-hour one.
  //
  // `window` is the parsed `QuotaWindow.window` when the caller has it; the
  // bucket id's own token is the fallback, so the one-argument form is safe too.
  const declared = window === undefined ? advertisedWindowOf(id) : window.toLowerCase()
  if (declared === undefined || agreedWindowKind(id, declared) === undefined) return []
  return families
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
  // There was a fourth branch here, keyed on a `3p`/`third` substring and guarded
  // by `families.length === 0`. That guard was already false whenever the label
  // named gemini/google (the first line pushes `google`), so the branch could only
  // ever fire for a label naming a third-party group WITHOUT naming its members —
  // exactly the case where it cannot be identified. Guessing a family blocks
  // healthy accounts, and `3p-` is resolved reliably from the BUCKET ID by
  // `familiesForBucketId`, so the branch is gone rather than re-keyed.
  return families
}

/**
 * Which of the two tracked windows an upstream token names, or `undefined` for a
 * token `CachedQuota` has no field for (`daily`, `monthly`).
 *
 * Read from `QUOTA_WINDOWS` (`types.ts`), the SAME table `adapter/quota-summary`
 * orders windows by. These were two independent tables once, and the gap between
 * them was a real defect: `daily` was orderable in the parser but unknown here, so
 * the group materialized an empty record that overwrote a live measurement. One
 * table makes that drift structurally impossible rather than merely tested for.
 *
 * Lookup is exact on the measured vocabulary (`5h`, `weekly`). A variant spelling
 * therefore classifies as unknown — which is safe, because the guard in
 * `ingestQuotaGroups` then skips the record rather than emptying it, and the
 * per-model probe still supplies the 5-hour reading.
 */
function windowKind(window: string): 'rolling' | 'weekly' | undefined {
  return QUOTA_WINDOWS[window.toLowerCase()]?.kind
}

/** The window token a bucket id advertises, when it ends with one upstream names. */
function advertisedWindowOf(bucketId: string): string | undefined {
  const id = bucketId.toLowerCase()
  const token = id.slice(id.lastIndexOf('-') + 1)
  return QUOTA_WINDOWS[token] ? token : undefined
}

/**
 * The field a window belongs in, decided from an AGREED (id, token) pair — or
 * `undefined` when the pair cannot be agreed.
 *
 * The family used to come from the bucket id's prefix while the field came from
 * the window token, as two independent decisions nothing checked against each
 * other. A bucket whose window the cache cannot hold still claimed the family,
 * and its reading was then filed by whichever field the TOKEN named. `gemini-weekly`
 * declaring `5h` is the shape that puts a multi-day weekly fraction into
 * `remainingFraction` (the 5-hour field), where `isFamilyDrained` and
 * `parseFutureResetMs` block the account for days on a window they misread.
 *
 * Refusing an unagreed pair is deliberately the strict option: the permissive
 * mapping is exactly the coupling that let two window vocabularies drift into
 * destroying a measurement. A bucket id that advertises no recognizable token is
 * held to the declared one alone, so a rename does not silently disable the cache.
 */
function agreedWindowKind(bucketId: string, window: string): 'rolling' | 'weekly' | undefined {
  const declared = window.toLowerCase()
  const kind = windowKind(declared)
  if (kind === undefined) return undefined
  const advertised = advertisedWindowOf(bucketId)
  if (advertised !== undefined && advertised !== declared) return undefined
  return kind
}

/** The families one group belongs to: its bucket ids first, its label second. */
export function familiesForGroup(group: QuotaGroup): ModelFamily[] {
  const families: ModelFamily[] = []
  const add = (family: ModelFamily) => {
    if (!families.includes(family)) families.push(family)
  }
  for (const window of group.windows) {
    for (const family of familiesForBucketId(window.bucketId, window.window)) add(family)
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
 * Two groups can land on one family (upstream may split `3p` later), so the
 * family record keeps the MOST pressured reading of each window across those
 * groups (`Math.min` below) rather than letting the last group win — the same
 * rule the per-model merge uses.
 *
 * WITHIN one group the rule is deliberately different: `??=` keeps upstream's
 * FIRST bucket of each window, because a group is upstream's own 5h + weekly
 * pair and a duplicate would otherwise depend on upstream's ordering. "Most
 * pressured" therefore applies to two GROUPS landing on one family, not to two
 * buckets inside one group.
 */
export function ingestQuotaGroups(groups: QuotaGroup[]): Record<string, CachedQuota> {
  const families = new Map<string, CachedQuota>()
  for (const group of groups) {
    const keys = familiesForGroup(group)
    if (keys.length === 0) continue
    let rolling: QuotaWindow | undefined
    let weekly: QuotaWindow | undefined
    for (const window of group.windows) {
      // The AGREED pair, not the token alone: a mismatched bucket must write no
      // field even when the group's label resolved a family (see agreedWindowKind).
      const kind = agreedWindowKind(window.bucketId, window.window)
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
      // A group whose only windows are a kind this cache cannot hold (`daily`,
      // `monthly`) would otherwise materialize an EMPTY record and replace a real
      // reading another group already wrote for this family.
      //
      // `daily`/`monthly` are RANKED by the shared `QUOTA_WINDOWS` table (so the
      // parser still display-sorts them) but carry no `kind`, which is what makes
      // them unholdable here. One table means the parser cannot know a window the
      // scheduler does not — the earlier two-table drift is structurally gone.
      if (record.remainingFraction === undefined && record.weeklyFraction === undefined && !current) {
        continue
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
      // Carry the weekly reading forward and NOTHING else — never the 5-hour
      // fields. It is the one field the per-model probe cannot supply, so its
      // absence means "this probe did not ask", not "the weekly budget is empty".
      //
      // `current` is absent when the family came from NEITHER source: either the
      // model probe does not cover it at all (a Gemini-only pool never reports
      // anthropic/openai) or its request failed, and `fetchQuotaSummary` answers a
      // failure with `[]` rather than throwing, so "no groups" and "endpoint down"
      // are the SAME input here. Dropping the record in that state erases a spent
      // week: `isFamilyDrained` flips true -> false and `rankPoolCandidates` loses
      // the weekly `blockedUntil`, putting an exhausted account straight back into
      // rotation. Hence the carry even with no `current`.
      //
      // A resurrected record cannot manufacture a block, because both consumers
      // ignore a window whose reset has already passed (`resetInPast` /
      // `parseFutureResetMs`) and the weekly value keeps its own reset moment.
      // The 5-hour fields get no such protection: `requiredDrainFor` has no reset
      // guard and clamps an elapsed reset to `DRAIN_FLOOR_MS`, so carrying a dead
      // 5-hour reading forward scores MAXIMUM drain urgency (24 vs 0.1 for an
      // identical live reading) and wins the ranking outright. That is why only
      // the weekly window travels.
      if (prev.weeklyFraction === undefined) continue
      // A fresh summary reading always wins; the carry only fills a gap.
      if (current?.weeklyFraction !== undefined) continue
      families.set(key, {
        ...current,
        weeklyFraction: prev.weeklyFraction,
        ...(current?.weeklyResetTime === undefined && prev.weeklyResetTime !== undefined
          ? { weeklyResetTime: prev.weeklyResetTime }
          : {}),
      })
    }
  }
  return Object.fromEntries(families)
}

/**
 * The lowest fraction a record reports across its LIVE windows — its overall
 * pressure.
 *
 * A window whose reset has already passed describes a window that no longer
 * exists, so it does not count — the same rule `isQuotaStale` applies when it
 * sizes the TTL from the selected record. Scoring a dead window would let one
 * family's expired weekly reading win the selection and represent the account,
 * masking another family's live pressure (issue #69: a dead weekly at 0.004
 * beat a live 0.2 and stretched the refresh TTL from 5 to 15 minutes).
 *
 * `undefined` means the record carries no usable LIVE reading at all, which is
 * deliberately different from a measured zero: only a real number can size a
 * refresh interval.
 */
function pressureScore(entry: CachedQuota, now: number): number | undefined {
  const fractions: number[] = []
  if (typeof entry.remainingFraction === 'number' && Number.isFinite(entry.remainingFraction)
    && !resetInPast(entry.resetTime, now)) {
    fractions.push(entry.remainingFraction)
  }
  if (typeof entry.weeklyFraction === 'number' && Number.isFinite(entry.weeklyFraction)
    && !resetInPast(entry.weeklyResetTime, now)) {
    fractions.push(entry.weeklyFraction)
  }
  return fractions.length === 0 ? undefined : Math.min(...fractions)
}

/**
 * The quota record for one family, or the most-pressured family when the model
 * is unknown.
 *
 * "Most pressured" compares BOTH windows and reports the record whose LOWEST
 * window is the lowest of all of them. That matters because `isQuotaStale` sizes
 * the refresh TTL from whichever record this returns: a family at 0.9 / weekly
 * 0.004 is more pressured than one at 0.2, and comparing the 5-hour fraction
 * alone picked the 0.2 record — so the weekly-driven 60s TTL was never applied
 * to the family actually being requested and a spent week was discovered late.
 *
 * A record carrying ONLY a weekly reading participates for the same reason: #48
 * produces that shape legitimately (the anthropic/openai entries of a
 * Gemini-only pool), and the old `typeof entry.remainingFraction !== 'number'`
 * guard skipped it outright, leaving the week invisible to TTL sizing.
 *
 * Selection considers LIVE windows only (`pressureScore` drops a window whose
 * reset has passed) — but the with-family path returns the record as-is either
 * way, because its consumers guard each window individually.
 *
 * @param account - the account whose cache to read.
 * @param family - the exact family's record; omit to select the most pressured.
 * @param now - current time (Unix ms), which decides whether a window is live.
 */
export function familyQuotaFor(account: ManagedAccount, family?: ModelFamily, now = Date.now()): CachedQuota | undefined {
  const cache = account.cachedQuota ?? {}
  if (family) return cache[family]
  let worst: CachedQuota | undefined
  let worstScore: number | undefined
  for (const entry of Object.values(cache)) {
    const score = pressureScore(entry, now)
    if (score === undefined) continue
    if (worstScore === undefined || score < worstScore) {
      worst = entry
      worstScore = score
    }
  }
  return worst
}

/** Whether the account's quota cache needs a refresh (missing, or past its health-based TTL). */
export function isQuotaStale(account: ManagedAccount, now = Date.now()): boolean {
  if (!account.cachedQuota || !account.cachedQuotaUpdatedAt) return true
  const mostPressured = familyQuotaFor(account, undefined, now)
  // A window whose reset has already passed describes a window that no longer
  // exists, so it must not drive the refresh INTERVAL either. A carried weekly
  // value kept returning the 60s TTL long after its reset, which re-probed both
  // endpoints every minute for as long as the summary endpoint stayed down — the
  // same reason `isFamilyDrained` ignores an expired window when it decides the
  // account is usable. Both fractions are guarded, since the 5-hour reading can
  // be carried forward by the same rule.
  const rolling = resetInPast(mostPressured?.resetTime, now) ? undefined : mostPressured?.remainingFraction
  const weekly = resetInPast(mostPressured?.weeklyResetTime, now) ? undefined : mostPressured?.weeklyFraction
  const ttl = computeSoftQuotaCacheTtlMs(rolling, weekly)
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
  const quota = familyQuotaFor(account, family, now)
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
 *
 * DELIBERATELY FIVE-HOUR ONLY, and this is a decision rather than an omission.
 * The weekly window influences `blockedUntil` and `hot` instead of the ranking
 * ORDER, because a week is not a spend-by deadline: the `DAY_MS` clamp below
 * caps the horizon at 24h, so a weekly reset ~5 days out would report ~24h of
 * urgency for a budget that cannot be spent faster to any benefit — and every
 * family would then be ranked by a number that no longer distinguishes them.
 * Making this weekly-aware therefore means replacing that clamp with a horizon
 * the weekly window can actually express, not adding a second fraction to the
 * numerator.
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
 * Whether the requested family on this account is effectively quota-exhausted
 * for account STEERING (affinity pins, the active-account preference): an
 * explicit quota-exhausted cooldown in force, a spent 5-hour window
 * (`remainingFraction <= 0` with a future reset), or a weekly window at or
 * below `WEEKLY_QUOTA_THRESHOLD` — a spent week refills in days, so its rule
 * mirrors `isFamilyDrained`'s weekly branch rather than the block wall.
 *
 * Deliberately a DIFFERENT predicate from the one in `pickAccount`'s `!picked`
 * branch, which applies a strict zero to BOTH windows to mirror
 * `rankPoolCandidates`' block wall when classifying `AgyPoolBlockedError`; and
 * deliberately NARROWER than `isFamilyDrained`'s 5-hour rule
 * (`SOFT_QUOTA_THRESHOLD`): account prioritization holds a chosen account
 * until it is actually spent, not until ranking would prefer another one.
 */
export function isFamilyQuotaExhausted(account: ManagedAccount, family?: ModelFamily, now = Date.now()): boolean {
  if (account.cooldownReason === 'quota-exhausted' && (account.coolingDownUntil ?? 0) > now) {
    return true
  }
  const quota = familyQuotaFor(account, family)
  if (!quota) return false
  const spent = (fraction: number | undefined, resetTime: string | undefined, threshold = 0): boolean => {
    if (typeof fraction !== 'number' || fraction > threshold || !resetTime) return false
    const resetMs = parseFutureResetMs(resetTime, now)
    return resetMs !== undefined && resetMs > now
  }
  return spent(quota.remainingFraction, quota.resetTime, 0)
    || spent(quota.weeklyFraction, quota.weeklyResetTime, WEEKLY_QUOTA_THRESHOLD)
}

/**
 * One normalized window reading for the cooldown-lift check: a fraction and the
 * moment it resets. Both cache shapes project onto it — a `CachedQuota` record
 * splits into its 5-hour and weekly halves, and one `QuotaWindow` bucket IS one
 * reading (its `window` token only labels which half it is).
 */
export interface QuotaWindowReading {
  fraction: number | null | undefined
  resetTime: string | null | undefined
}

/**
 * Whether ANY measured window is SPENT — a zero fraction whose reset is still
 * ahead, exactly the block wall `rankPoolCandidates` applies. Elapsed resets and
 * unmeasured windows describe nothing and never count.
 */
export function measuredQuotaSpent(
  readings: ReadonlyArray<QuotaWindowReading>,
  now = Date.now(),
): boolean {
  return readings.some((reading) =>
    typeof reading.fraction === 'number'
    && reading.fraction <= 0
    && parseFutureResetMs(reading.resetTime ?? undefined, now) !== undefined)
}

/** Flatten a family quota cache into one reading per window. */
export function cachedQuotaReadings(quotas: Record<string, CachedQuota>): QuotaWindowReading[] {
  return Object.values(quotas).flatMap((entry) => [
    { fraction: entry.remainingFraction, resetTime: entry.resetTime },
    { fraction: entry.weeklyFraction, resetTime: entry.weeklyResetTime },
  ])
}

/** Flatten grouped display windows into one reading per bucket. */
export function limitGroupReadings(groups: ReadonlyArray<QuotaGroup>): QuotaWindowReading[] {
  return groups.flatMap((group) => group.windows.map((window) => ({
    fraction: window.remainingFraction,
    resetTime: window.resetTime,
  })))
}

/**
 * Whether a `quota-exhausted` park on this account is CONTRADICTED by a newer
 * measurement: the park is still in force, the measurement completed after the
 * park was set (an older snapshot cannot clear a newer park), and no measured
 * window is spent. The 429 that set the park may have been a burst whose body
 * merely said "quota" — a wording the classifier reads as exhausted daily quota
 * and parks the account for up to a day — and the newer measurement is the only
 * evidence that outlives it.
 */
export function quotaCooldownContradicted(
  account: Pick<ManagedAccount, 'cooldownReason' | 'coolingDownUntil' | 'cooldownSetAt'>,
  readings: ReadonlyArray<QuotaWindowReading>,
  measuredAt: number,
  now = Date.now(),
): boolean {
  if (account.cooldownReason !== 'quota-exhausted') return false
  if ((account.coolingDownUntil ?? 0) <= now) return false
  if ((account.cooldownSetAt ?? 0) >= measuredAt) return false
  return !measuredQuotaSpent(readings, now)
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
    const quota = familyQuotaFor(account, family, now)
    // A window whose reset has already passed describes a window that no longer
    // exists — the same rule the block decision below applies through
    // `parseFutureResetMs`. Without this guard a carried-forward weekly reading
    // (kept until the next successful probe) made the candidate `hot` for
    // `PRIMARY_WINDOW_HOT_FRACTION` on a window that had already refilled.
    const live5h = quota !== undefined && !resetInPast(quota.resetTime, now)
    const liveWeekly = quota !== undefined && !resetInPast(quota.weeklyResetTime, now)
    const remaining = live5h ? quota.remainingFraction : undefined
    const used = typeof remaining === 'number' ? Math.min(Math.max(1 - remaining, 0), 1) : undefined
    const weeklyRemaining = liveWeekly ? quota.weeklyFraction : undefined
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
