/**
 * Pure quota view layer, shared by the conversation-header badge
 * (`quota-badge.ts`) and the Settings section's own limits card.
 *
 * No React, no fetch, no DOM: every figure and every word is computed here from
 * data handed in, with `now` always injected, so `tests/quota-view.test.ts` can
 * pin the badge's arithmetic without a browser.
 *
 * Nothing in this module restates an upstream fact:
 *
 * - the window vocabulary and its order come from `QUOTA_WINDOWS`
 *   (`../types.ts`), the one table the adapter and the scheduler also read;
 * - the drain thresholds are IMPORTED from `../runtime/rotation.ts`, so the
 *   badge ranks windows by the same numbers the pool rotates on;
 * - "the reset has passed" is `parseFutureResetMs`, the predicate the pool
 *   itself applies (`isFamilyDrained`, `rankPoolCandidates`);
 * - every visible word comes from the `agy` dictionary (`locales.ts`).
 *
 * A window with no reported fraction is "unknown" and renders as an em dash —
 * never as 0%, because unknown headroom and no headroom are opposite facts.
 */

import { QUOTA_WINDOWS, type QuotaGroup, type QuotaWindow } from '../types.ts'
import { SOFT_QUOTA_THRESHOLD, WEEKLY_QUOTA_THRESHOLD, parseFutureResetMs } from '../runtime/rotation.ts'
import type { AccountView } from '../rpc-contract.ts'
import type { AgyLocaleKey } from './locales.ts'

/**
 * This section's translator, taken structurally.
 *
 * The real `t` is `TranslateNS<'agy'>`; a structural signature keeps this module
 * free of the slots package while still accepting that binding (a wider key
 * parameter is contravariantly assignable to a narrower one).
 */
export type QuotaTranslate = (key: AgyLocaleKey, params?: Record<string, unknown>) => string

/** The badge's reading: a percentage plus the window that produced it. */
export interface BadgeQuota {
  /** 0..100. */
  percent: number
  /** The upstream window token that drove `percent`. */
  window: string
}

/** One rendered window row. */
export interface QuotaWindowRow {
  bucketId: string
  /** Localized window label. */
  label: string
  /**
   * 0..100, or null when upstream reported no fraction — or when the last
   * reading belongs to a period that has already ended (see `stale`).
   */
  percent: number | null
  /** Reset copy, or null when there is no usable reset moment. */
  reset: string | null
  /**
   * True when the last reading belongs to a period that has already ended, so
   * `percent` is withheld rather than shown as a live figure.
   */
  stale: boolean
}

/** One rendered group card. */
export interface QuotaCard {
  key: string
  /** Upstream's own group label (e.g. `Gemini Models`). */
  title: string
  windows: QuotaWindowRow[]
}

// ─── localized words and time ────────────────────────────────────────────────

export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/**
 * Localized label for an upstream quota window token.
 *
 * The tokens are mapped rather than printed so the surface follows the UI
 * language, and an UNRECOGNIZED token falls back to its raw value: upstream may
 * add a window, and showing `30d` is better than a blank or a wrong label.
 */
export function windowLabel(window: string, t: QuotaTranslate): string {
  switch (window) {
    case '5h': return t('quotaWindow5h')
    case 'daily': return t('quotaWindowDaily')
    case 'weekly': return t('quotaWindowWeekly')
    case 'monthly': return t('quotaWindowMonthly')
    default: return window
  }
}

/** Localized account-state label. */
export function stateLabel(state: AccountView['state'], t: QuotaTranslate): string {
  switch (state) {
    case 'active': return t('stateActive')
    case 'cooling': return t('stateCooling')
    case 'verification-required': return t('stateVerificationRequired')
    case 'disabled': return t('stateDisabled')
  }
}

/**
 * Time until a future moment, as localized copy.
 *
 * A quota reset wall is often more than 24h out, so a bare `HH:mm` cannot say
 * whether it means today or tomorrow. Bucket boundaries mirror the host's
 * `relativeTime`; the words stay in this plugin's own dictionary, which is
 * exactly the split that API intends.
 */
export function untilText(iso: string | null, t: QuotaTranslate, now: number): string {
  if (iso === null) return '—'
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return '—'
  const diff = at - now
  if (diff <= 0) return t('relNow')
  const value = diff < MINUTE_MS
    ? t('relNow')
    : diff < HOUR_MS
      ? t('relMinutes', { n: Math.floor(diff / MINUTE_MS) })
      : diff < DAY_MS
        ? t('relHours', { n: Math.floor(diff / HOUR_MS) })
        : diff < 30 * DAY_MS
          ? t('relDays', { n: Math.floor(diff / DAY_MS) })
          : diff < 365 * DAY_MS
            ? t('relMonths', { n: Math.floor(diff / (30 * DAY_MS)) })
            : t('relYears', { n: Math.floor(diff / (365 * DAY_MS)) })
  return t('quotaResetIn', { value })
}

/**
 * How long ago a past moment was (the mirror of `untilText`).
 *
 * Reuses the same `rel*` magnitudes so the two read consistently, but adds a
 * direction suffix: a bare magnitude beside a cooldown could equally mean when
 * it started or when it ends.
 */
export function agoText(iso: string | null, t: QuotaTranslate, now: number): string {
  if (iso === null) return '—'
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return '—'
  const diff = now - at
  // A clock skew or a just-written stamp reads as "just now" rather than a
  // negative age.
  if (diff < MINUTE_MS) return t('relJustNow')
  const value = diff < HOUR_MS
    ? t('relMinutes', { n: Math.floor(diff / MINUTE_MS) })
    : diff < DAY_MS
      ? t('relHours', { n: Math.floor(diff / HOUR_MS) })
      : diff < 30 * DAY_MS
        ? t('relDays', { n: Math.floor(diff / DAY_MS) })
        : diff < 365 * DAY_MS
          ? t('relMonths', { n: Math.floor(diff / (30 * DAY_MS)) })
          : t('relYears', { n: Math.floor(diff / (365 * DAY_MS)) })
  return t('relAgo', { value })
}

/**
 * The reset moment of one window.
 *
 * A wall that has already passed is its own state rather than a zero-distance
 * countdown: `untilText` answers "shortly" for `diff <= 0`, which is precisely
 * the promise the old badge made about a window that had already refilled.
 */
export function resetText(resetTime: string | null, t: QuotaTranslate, now: number): string | null {
  if (resetTime === null) return null
  const at = Date.parse(resetTime)
  if (Number.isNaN(at)) return null
  if (at <= now) return t('quotaResetPassed')
  return untilText(resetTime, t, now)
}

// ─── window arithmetic ───────────────────────────────────────────────────────

/** Sort rank for a window token; an unknown token ranks last. */
function windowRank(window: string): number {
  return QUOTA_WINDOWS[window]?.rank ?? Number.MAX_SAFE_INTEGER
}

/** Order windows shortest-first; an unknown token last, tie-broken alphabetically. */
export function sortWindows(windows: readonly QuotaWindow[]): QuotaWindow[] {
  return [...windows].sort((a, b) =>
    windowRank(a.window) - windowRank(b.window) || a.window.localeCompare(b.window))
}

/** 0..100 for a usable fraction, or null when it is absent or not finite. */
export function toPercent(fraction: number | null | undefined): number | null {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return null
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100)
}

/**
 * Quota tint by remaining fraction: healthy / low / critical.
 *
 * The thresholds are the Settings section's own, so the badge's bars read the
 * same colour as the limits card's beside them. Built from `--dsw-alias-*`
 * tokens (with the literal as a pre-theme fallback) rather than fixed hex: a
 * private palette does not follow the host's light/dark switch.
 */
export function quotaColor(fraction: number): string {
  if (fraction > 0.7) return 'var(--dsw-alias-state-success-primary, #22c55e)'
  if (fraction >= 0.3) return 'var(--dsw-alias-state-warn-primary, #f59e0b)'
  return 'var(--dsw-alias-state-error-primary, #ec1313)'
}

/**
 * The drain threshold that governs one window token, or undefined when the pool
 * does not block on that window.
 *
 * The two numbers are IMPORTED from `runtime/rotation.ts` because they answer
 * the same question there ("how much work is left" over windows of different
 * lengths), which is why they are deliberately asymmetric. `daily`/`monthly`
 * report but never block, so they have no threshold and never drive the badge.
 */
export function drainThresholdFor(window: string): number | undefined {
  if (window === '5h') return SOFT_QUOTA_THRESHOLD
  if (window === 'weekly') return WEEKLY_QUOTA_THRESHOLD
  return undefined
}

/** The windows the pool actually blocks on. */
function rotationWindows(group: QuotaGroup): QuotaWindow[] {
  return group.windows.filter((window) => drainThresholdFor(window.window) !== undefined)
}

/**
 * Whether a window's reset moment has already passed.
 *
 * The pool treats such a window as unmeasured (`isFamilyDrained`,
 * `rankPoolCandidates`): the cached fraction describes a period that has ENDED,
 * so it is not evidence about the one we are in. This view layer reads the same
 * records, so it has to apply the same rule — otherwise a spent five-hour window
 * that has already rolled over keeps the badge red long after the pool resumed
 * serving that account.
 *
 * A reset moment that cannot be parsed counts as passed: it cannot be shown to
 * be in the future, and the reading it dates is not trustworthy either way.
 * A window that reported no reset moment at all is NOT stale — the pool keeps
 * using its fraction, and so does this.
 */
function resetInPast(resetTime: string | null, now: number): boolean {
  if (resetTime === null) return false
  return parseFutureResetMs(resetTime, now) === undefined
}

/**
 * Whether a window's fraction is a leftover from a period that has ended.
 *
 * Only a window that DID report a fraction can be stale: one that never reported
 * stays "unknown", which the row already renders as its own case.
 */
function windowIsStale(window: QuotaWindow, now: number): boolean {
  return window.remainingFraction !== null && resetInPast(window.resetTime, now)
}

/**
 * How close a window is to its own drain point, as a threshold multiple.
 *
 * Comparing raw `remainingFraction` values would rank a comfortable 44% week
 * above a comfortable 82% five-hour window and hand the badge to the week, which
 * is not what stops a request. Dividing by each window's own drain threshold asks
 * the question the pool itself asks — how much runway is left before this window
 * stops serving — so the five-hour window stays in charge until the week is
 * genuinely nearly spent.
 */
function windowPressure(window: QuotaWindow, now: number): number | null {
  if (window.remainingFraction === null) return null
  if (resetInPast(window.resetTime, now)) return null
  const threshold = drainThresholdFor(window.window)
  if (threshold === undefined || threshold <= 0) return null
  return Math.max(window.remainingFraction, 0) / threshold
}

/**
 * Pick the window that constrains the account first, for the header badge.
 *
 * Groups are read in upstream's own order — it lists the Gemini budget first —
 * and the FIRST group reporting a blocking window decides on its own: mixing
 * groups would blend one budget with another. Within that group the window with
 * the smallest threshold multiple wins.
 *
 * Deliberately no family inference here (the badge used to match group names
 * against `/gemini/`): upstream's grouping is a payload detail, and the pool's
 * own family mapping lives in `runtime/quota.ts`, which the browser bundle does
 * not carry.
 */
export function pickBadgeWindow(limits: readonly QuotaGroup[] | null | undefined, now: number): QuotaWindow | null {
  if (!limits || limits.length === 0) return null
  for (const group of limits) {
    const candidates = rotationWindows(group)
    if (candidates.length === 0) continue
    let best: QuotaWindow | null = null
    let bestPressure = Number.POSITIVE_INFINITY
    for (const window of candidates) {
      const pressure = windowPressure(window, now)
      if (pressure === null) continue
      if (pressure < bestPressure) {
        best = window
        bestPressure = pressure
      }
    }
    if (best !== null) return best
    // Every rotating window of this group is unmeasured or already reset.
    // Returning null rather than the first candidate keeps a leftover fraction
    // from rendering as the live reading.
    return null
  }
  // No group reports a window we block on: the shortest window that is still
  // live is the best remaining proxy, so an upstream window vocabulary added
  // later still yields a number instead of a fallback count.
  for (const group of limits) {
    const usable = sortWindows(group.windows).filter((window) => !windowIsStale(window, now))
    const first = usable[0]
    if (first !== undefined) return first
  }
  return null
}

/**
 * The badge's reading: the most constrained tracked window of the ACTIVE account.
 *
 * Reported `daily`/`monthly` windows never drive the badge: the pool does not
 * block on them, so a low monthly figure is not a reason to alarm the header.
 * Returns null when nothing usable is known — the caller renders a dash instead
 * of inventing 0%.
 */
export function pickBadgeQuota(accounts: readonly AccountView[], now: number = Date.now()): BadgeQuota | null {
  const active = accounts.find((account) => account.active) ?? accounts[0]
  const window = pickBadgeWindow(active?.limits, now)
  if (window === null) return null
  const percent = toPercent(window.remainingFraction)
  if (percent === null) return null
  return { percent, window: window.window }
}

/** Build the window rows of one group card. */
export function windowRows(
  windows: readonly QuotaWindow[],
  t: QuotaTranslate,
  now: number,
): QuotaWindowRow[] {
  return sortWindows(windows).map((window) => {
    const stale = windowIsStale(window, now)
    // A stale row withholds its fraction instead of showing it as live: the
    // percentage described a period that ended, and the reset copy says so.
    return {
      bucketId: window.bucketId,
      label: windowLabel(window.window, t),
      percent: stale ? null : toPercent(window.remainingFraction),
      reset: resetText(window.resetTime, t, now),
      stale,
    }
  })
}

/**
 * Build the quota cards for one account.
 *
 * One card per upstream group, exactly as the group arrived: the grouped
 * windows are the only quota channel this plugin has now, and upstream's own
 * split ("Gemini Models" / "Claude and GPT models") cannot be re-derived from
 * model-id prefixes — `3p-*` covers Claude AND GPT.
 *
 * A group whose windows all turned out to be unusable would render as an empty
 * card that pushes a real one off screen, so those are dropped.
 */
export function buildQuotaCards(account: AccountView | undefined, t: QuotaTranslate, now: number): QuotaCard[] {
  const groups = account?.limits
  if (!groups || groups.length === 0) return []
  const cards: QuotaCard[] = []
  for (const group of groups) {
    const rows = windowRows(group.windows, t, now)
    if (rows.length === 0) continue
    cards.push({
      key: group.name || `group-${cards.length}`,
      title: group.name || t('quotaGroupFallback'),
      windows: rows,
    })
  }
  return cards
}

// ─── account identity ────────────────────────────────────────────────────────

/**
 * Which StateDot semantic the badge's health light shows.
 *
 * The pool is usable when some account is serving; anything else (a cooling
 * account, one parked behind verification, a disabled one) is user attention
 * rather than a hard failure, and an empty pool is idle rather than broken.
 */
export function dotStateFor(accounts: readonly AccountView[]): 'done' | 'warning' | 'idle' {
  if (accounts.length === 0) return 'idle'
  if (!accounts.some((account) => account.active || account.state === 'active')) return 'warning'
  return accounts.some((account) => account.state !== 'active') ? 'warning' : 'done'
}

/**
 * Mask an account email for the header surface.
 *
 * Deliberately NOT what the Settings section does: that panel shows the address
 * in full, on a page the user opened on purpose. The conversation header sits on
 * screen for the whole session — including during a share or a recording — so the
 * local part is shortened and the domain kept, which is enough to tell two
 * accounts apart without publishing the address.
 */
export function desensitizeEmail(email: string | null | undefined): string {
  if (!email || !email.includes('@')) return email || '—'
  const [name, domain] = email.split('@')
  if (name === undefined || domain === undefined) return email
  if (name.length <= 3) return `${name.slice(0, 1)}***@${domain}`
  if (name.length <= 6) return `${name.slice(0, 2)}***@${domain}`
  return `${name.slice(0, 5)}***@${domain}`
}

// ─── refresh policy ──────────────────────────────────────────────────────────

/**
 * How long the badge waits before letting an AUTOMATIC refresh probe again after
 * a run that measured nothing and failed.
 *
 * The host's TTL does not cover this case: a failed probe writes no cache at all,
 * so the snapshot stays stale by design and every poll would re-probe — one
 * upstream call per tick for an account whose proxy is down. An explicit refresh
 * is unaffected (that is the whole point of asking).
 */
export const PROBE_FAILURE_BACKOFF_MS = 10 * 60 * 1000

/**
 * Which probe a refresh should run.
 *
 * `force` re-probes inside the host's window (the user asked); `off` leaves the
 * window refresh out entirely for this tick; `auto` lets the host's TTL decide.
 * Ported from the standalone badge, which learned that a failed probe run has to
 * back itself off.
 */
export function shouldProbeLimits(input: {
  force: boolean
  /** When the last probe run measured nothing and failed, or null. */
  failedAt: number | null
  now: number
}): 'force' | 'auto' | 'off' {
  if (input.force) return 'force'
  if (input.failedAt !== null && input.now - input.failedAt < PROBE_FAILURE_BACKOFF_MS) return 'off'
  return 'auto'
}
