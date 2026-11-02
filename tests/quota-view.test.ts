/**
 * Quota view layer: the badge's arithmetic, pinned without a browser.
 *
 * Every case here is a decision the conversation header depends on: which window
 * is allowed to drive the single figure, what a reading from an ENDED period
 * must not be allowed to say, and what happens when upstream reports nothing at
 * all. `now` is injected everywhere so none of it depends on the wall clock.
 */

import { describe, expect, it } from 'vitest'
import {
  accountQuotaRead,
  accountRecoveryTime,
  agoText,
  barColorFor,
  buildQuotaCards,
  desensitizeEmail,
  dotStateFor,
  drainThresholdFor,
  formatDetailedReset,
  formatQuotaReset,
  isAccountAllQuotaExhausted,
  isAccountQuotaExhausted,
  isGroupQuotaExhausted,
  limitsOlderThanInterval,
  modelLabelForGroup,
  nextHealthyIndex,
  pickBadgeQuota,
  pickBadgeWindow,
  PROBE_FAILURE_BACKOFF_MS,
  quotaColor,
  resetText,
  resolveQuotaGroup,
  shouldProbeLimits,
  smartQuotaVerdict,
  sortWindows,
  stateLabel,
  toPercent,
  untilText,
  windowLabel,
  windowRows,
} from '../src/client/quota-view.ts'
import { zh } from '../src/client/locales.ts'
import { SOFT_QUOTA_THRESHOLD, WEEKLY_QUOTA_THRESHOLD } from '../src/runtime/rotation.ts'
import type { AccountView } from '../src/rpc-contract.ts'
import type { QuotaGroup, QuotaWindow } from '../src/types.ts'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
/** A moment `minutes` in the future (negative for the past), as RFC3339. */
const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

/** The zh dictionary is the key source of truth; the layers only forward it. */
const t = (key: keyof typeof zh, params?: Record<string, unknown>): string => {
  const template = zh[key]
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => String(params[name] ?? match))
}

function window(
  bucketId: string,
  name: string,
  remainingFraction: number | null,
  resetTime: string | null = at(60),
): QuotaWindow {
  return { bucketId, window: name, remainingFraction, resetTime }
}

function group(name: string, windows: QuotaWindow[]): QuotaGroup {
  return { name, windows }
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    index: 0,
    email: 'pilot@example.com',
    projectId: 'proj',
    active: true,
    state: 'active',
    cooldownUntil: null,
    cooldownReason: null,
    cooldownSetAt: null,
    verificationUrl: null,
    verificationRequired: false,
    rateLimits: null,
    fingerprint: null,
    fingerprintHistory: 0,
    proxy: null,
    usage: null,
    limits: null,
    limitsUpdatedAt: null,
    ...overrides,
  }
}

describe('quota window vocabulary', () => {
  it('maps every window upstream reports today', () => {
    expect(windowLabel('5h', t)).toBe(zh.quotaWindow5h)
    expect(windowLabel('daily', t)).toBe(zh.quotaWindowDaily)
    expect(windowLabel('weekly', t)).toBe(zh.quotaWindowWeekly)
    expect(windowLabel('monthly', t)).toBe(zh.quotaWindowMonthly)
  })

  it('passes an unrecognized window token through verbatim', () => {
    // Upstream may add a window; showing its own token beats a blank label or a
    // wrong one borrowed from a neighbouring window.
    expect(windowLabel('30d', t)).toBe('30d')
  })

  it('orders windows shortest first and keeps an unknown token last', () => {
    const input = [
      window('m', 'monthly', 0.5),
      window('w', 'weekly', 0.5),
      window('u', '3d', 0.5),
      window('d', 'daily', 0.5),
      window('h', '5h', 0.5),
    ]
    expect(sortWindows(input).map((entry) => entry.window)).toEqual(['5h', 'daily', 'weekly', 'monthly', '3d'])
    // The caller's array is the RPC payload; sorting it in place would reorder
    // the snapshot every render reads.
    expect(input.map((entry) => entry.window)).toEqual(['monthly', 'weekly', '3d', 'daily', '5h'])
  })

  it('labels every account state and passes an unknown one through', () => {
    expect(stateLabel('active', t)).toBe(zh.stateActive)
    expect(stateLabel('cooling', t)).toBe(zh.stateCooling)
    expect(stateLabel('verification-required', t)).toBe(zh.stateVerificationRequired)
    expect(stateLabel('disabled', t)).toBe(zh.stateDisabled)
  })
})

describe('quota percentage', () => {
  it('rounds a usable fraction to whole percent', () => {
    expect(toPercent(0.826)).toBe(83)
    expect(toPercent(1)).toBe(100)
    expect(toPercent(0)).toBe(0)
  })

  it('clamps a fraction outside [0, 1] instead of printing it', () => {
    expect(toPercent(1.4)).toBe(100)
    expect(toPercent(-1)).toBe(0)
  })

  it('reports no reading for absent or non-finite fractions', () => {
    // Unknown headroom is not zero headroom: a 0% bar would say "spent" about a
    // window upstream never measured.
    expect(toPercent(null)).toBeNull()
    expect(toPercent(undefined)).toBeNull()
    expect(toPercent(Number.NaN)).toBeNull()
    expect(toPercent(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('badge window selection', () => {
  it('reads the 5h window of an account whose only reading is there', () => {
    const quota = pickBadgeQuota([account({ limits: [group('Gemini Models', [window('h', '5h', 0.82)])] })], NOW)
    expect(quota).toEqual({ percent: 82, window: '5h' })
  })

  it('weighs each window against its own drain threshold', () => {
    // Raw fractions would hand this to the week (0.44 < 0.82), but 44% of a week
    // is still 44 drain-thresholds of runway while 82% of a five-hour window is
    // 5.5 — the window that stops serving first is the five-hour one.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.82), window('w', 'weekly', 0.44)])],
    })], NOW)
    expect(quota).toEqual({ percent: 82, window: '5h' })
  })

  it('lets a weekly window drive the badge once the 5h window is spent', () => {
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.95), window('w', 'weekly', 0.02)])],
    })], NOW)
    // 0.95/0.15 = 6.3 against 0.02/0.01 = 2 → the week is the tighter window.
    expect(quota).toEqual({ percent: 2, window: 'weekly' })
  })

  it('ignores a reading whose reset has already passed', () => {
    // The cached fraction describes a period that ENDED: the pool treats that
    // window as unmeasured, so the badge must not keep showing it as spent.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.02, at(-60)), window('w', 'weekly', 0.5)])],
    })], NOW)
    expect(quota).toEqual({ percent: 50, window: 'weekly' })
  })

  it('keeps a reading that reported no reset moment at all', () => {
    // No reset is not the same as a passed reset: the pool keeps using that
    // fraction, and so does the badge.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.31, null)])],
    })], NOW)
    expect(quota).toEqual({ percent: 31, window: '5h' })
  })

  it('treats an unparseable reset moment as passed', () => {
    // A wall that cannot be shown to be in the future cannot date a live
    // reading; the conservative reading is the stale one.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.02, 'not-a-date'), window('w', 'weekly', 0.5)])],
    })], NOW)
    expect(quota).toEqual({ percent: 50, window: 'weekly' })
  })

  it('reports nothing when every window of the deciding group is stale', () => {
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('h', '5h', 0.02, at(-1)), window('w', 'weekly', 0.01, at(-600))])],
    })], NOW)
    expect(quota).toBeNull()
  })

  it('never lets daily or monthly drive the badge', () => {
    // They are reported but never blocked on, so a low monthly figure is not a
    // reason to alarm the header.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [
        window('h', '5h', 0.9),
        window('d', 'daily', 0.2),
        window('m', 'monthly', 0.01),
      ])],
    })], NOW)
    expect(quota).toEqual({ percent: 90, window: '5h' })
  })

  it('rounds a nearly spent week up to a readable 1%', () => {
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('w', 'weekly', 0.005)])],
    })], NOW)
    expect(quota).toEqual({ percent: 1, window: 'weekly' })
  })

  it('falls back to the shortest live window when no group reports a tracked one', () => {
    // A payload naming only daily/monthly still yields a figure rather than an
    // em dash: the badge's job is to show the tightest thing it can see.
    const quota = pickBadgeQuota([account({
      limits: [group('Gemini Models', [window('d', 'daily', 0.4), window('m', 'monthly', 0.9)])],
    })], NOW)
    expect(quota).toEqual({ percent: 40, window: 'daily' })
  })

  it('reads the ACTIVE account, not the first one in the list', () => {
    const accounts = [
      account({ index: 0, active: false, state: 'cooling', limits: [group('Gemini Models', [window('h', '5h', 0.1)])] }),
      account({ index: 1, active: true, limits: [group('Gemini Models', [window('h', '5h', 0.77)])] }),
    ]
    expect(pickBadgeQuota(accounts, NOW)).toEqual({ percent: 77, window: '5h' })
  })

  it('reports nothing when no account carries limits', () => {
    expect(pickBadgeQuota([account()], NOW)).toBeNull()
    expect(pickBadgeQuota([], NOW)).toBeNull()
    expect(pickBadgeWindow(null, NOW)).toBeNull()
  })

  it('lets the first group reporting a tracked window decide alone', () => {
    // Groups are separate budgets; blending one into another would report a
    // figure no single budget can reach.
    const quota = pickBadgeQuota([account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0.3)]),
        group('Claude and GPT models', [window('c', '5h', 0.9)]),
      ],
    })], NOW)
    expect(quota).toEqual({ percent: 30, window: '5h' })
  })

  it('skips a leading group with no tracked window instead of ending the search', () => {
    const quota = pickBadgeQuota([account({
      limits: [
        group('Other', [window('m', 'monthly', 0.1)]),
        group('Gemini Models', [window('h', '5h', 0.6)]),
      ],
    })], NOW)
    expect(quota).toEqual({ percent: 60, window: '5h' })
  })
})

describe('quota cards', () => {
  it('drops a group whose window list is empty', () => {
    // An empty card pushes a real one out of the panel and says nothing.
    const cards = buildQuotaCards(account({
      limits: [group('Empty', []), group('Gemini Models', [window('h', '5h', 0.5)])],
    }), t, NOW)
    expect(cards).toHaveLength(1)
    expect(cards[0]?.title).toBe('Gemini Models')
  })

  it('keeps upstream group order and falls back for an unnamed group', () => {
    const cards = buildQuotaCards(account({
      limits: [group('', [window('h', '5h', 0.5)]), group('Claude and GPT models', [window('c', 'weekly', 0.5)])],
    }), t, NOW)
    expect(cards.map((card) => card.title)).toEqual([zh.quotaGroupFallback, 'Claude and GPT models'])
    expect(cards[0]?.key).toBe('group-0')
  })

  it('withholds the figure of a stale row and explains why', () => {
    const rows = windowRows([window('h', '5h', 0.02, at(-30))], t, NOW)
    expect(rows[0]).toEqual({
      bucketId: 'h',
      window: '5h',
      label: zh.quotaWindow5h,
      percent: null,
      reset: zh.quotaResetPassed,
      stale: true,
    })
  })

  it('renders an unmeasured row as unknown rather than zero', () => {
    const rows = windowRows([window('h', '5h', null)], t, NOW)
    expect(rows[0]?.percent).toBeNull()
    expect(rows[0]?.stale).toBe(false)
    expect(rows[0]?.reset).toBe(zh.quotaResetIn.replace('{value}', zh.relHours.replace('{n}', '1')))
  })

  it('reports no cards for an account with no limits', () => {
    expect(buildQuotaCards(account(), t, NOW)).toEqual([])
    expect(buildQuotaCards(undefined, t, NOW)).toEqual([])
  })

  it('renders detailed reset countdowns when detailed option is enabled', () => {
    const rows = windowRows([
      window('h', '5h', 0.8, at(195)),
      window('w', 'weekly', 0.5, at(5 * 24 * 60 + 12 * 60)),
    ], t, NOW, true)
    // Every window — 5h included — shows the full date plus a minute-precision
    // countdown, so the shortest window is no longer the only one not saying
    // WHEN it resets. The date substring is TZ-dependent; the countdown is not.
    expect(rows[0]?.reset).toContain(zh.badgeCountdownHoursMins.replace('{hours}', '3').replace('{mins}', '15'))
    expect(rows[1]?.reset).toContain(zh.badgeCountdownDaysHours.replace('{days}', '5').replace('{hours}', '12'))
  })
})

describe('account identity', () => {
  it('shortens the local part and keeps the domain', () => {
    // The conversation header is on screen for the whole session, sharing
    // included; the Settings panel shows the full address instead.
    expect(desensitizeEmail('commander@example.com')).toBe('comma***@example.com')
    expect(desensitizeEmail('pilot@example.com')).toBe('pi***@example.com')
    expect(desensitizeEmail('abcd@example.com')).toBe('ab***@example.com')
    expect(desensitizeEmail('abc@example.com')).toBe('a***@example.com')
  })

  it('falls back to an em dash for a missing address and passes other text through', () => {
    expect(desensitizeEmail(null)).toBe(zh.valueUnknown)
    expect(desensitizeEmail(undefined)).toBe(zh.valueUnknown)
    // Ported verbatim: a value that is not an address has no local part to
    // shorten, and it is not an address to leak either.
    expect(desensitizeEmail('not-an-address')).toBe('not-an-address')
  })

  it('shows an idle dot for an empty pool and a warning for a degraded one', () => {
    expect(dotStateFor([])).toBe('idle')
    expect(dotStateFor([account()])).toBe('done')
    expect(dotStateFor([account({ state: 'cooling', active: false })])).toBe('warning')
    expect(dotStateFor([account(), account({ index: 1, state: 'cooling', active: false })])).toBe('warning')
  })
})

describe('quota tints and drain thresholds', () => {
  it('tints every surface by the one quota contract', () => {
    // 0% is exhausted (red), 20% and below is nearly drained (amber), the rest
    // healthy (green). The header badge, its window bars and the Settings
    // limits card all call this one rule, so the same reading can never
    // render two colours on two surfaces.
    expect(quotaColor(0.8)).toContain('--dsw-alias-state-success-primary')
    expect(quotaColor(0.21)).toContain('--dsw-alias-state-success-primary')
    expect(quotaColor(0.2)).toContain('--dsw-alias-state-warn-primary')
    expect(quotaColor(0.19)).toContain('--dsw-alias-state-warn-primary')
    expect(quotaColor(0.05)).toContain('--dsw-alias-state-warn-primary')
    expect(quotaColor(0)).toContain('--dsw-alias-state-error-primary')
  })

  it('imports the pool thresholds rather than restating them', () => {
    expect(drainThresholdFor('5h')).toBe(SOFT_QUOTA_THRESHOLD)
    expect(drainThresholdFor('weekly')).toBe(WEEKLY_QUOTA_THRESHOLD)
    // Reported but never blocked on: no threshold, so they never decide.
    expect(drainThresholdFor('daily')).toBeUndefined()
    expect(drainThresholdFor('monthly')).toBeUndefined()
    expect(drainThresholdFor('30d')).toBeUndefined()
  })

  it('turns the 5h bar gray when weekly quota is exhausted (0%)', () => {
    // When weekly quota is 0 and 5h is NOT 0, the 5h window is moot upstream:
    // the bar renders neutral gray (label-tertiary) instead of misleading green.
    expect(barColorFor('5h', 0.8, 0)).toContain('--dsw-alias-label-tertiary')
    // When 5h is itself 0%, it renders red (state-error-primary), not gray.
    expect(barColorFor('5h', 0, 0)).toContain('--dsw-alias-state-error-primary')
    // When weekly quota is not 0, 5h renders its normal quotaColor.
    expect(barColorFor('5h', 0.8, 0.5)).toContain('--dsw-alias-state-success-primary')
    expect(barColorFor('5h', 0.15, 0.5)).toContain('--dsw-alias-state-warn-primary')
    // Weekly bar itself renders by quotaColor.
    expect(barColorFor('weekly', 0, 0)).toContain('--dsw-alias-state-error-primary')
    // Unmeasured (null) is gray.
    expect(barColorFor('5h', null, 0.5)).toContain('--dsw-alias-label-tertiary')
  })
})

describe('relative time', () => {
  it('counts a future reset down in the magnitudes the panel uses', () => {
    expect(untilText(at(0.5), t, NOW)).toBe(zh.quotaResetIn.replace('{value}', zh.relNow))
    // A wall that has already passed has no distance left to count: "shortly" is
    // the only truthful wording, and `resetText` is what names the state.
    expect(untilText(at(-5), t, NOW)).toBe(zh.relNow)
    expect(untilText(at(30), t, NOW)).toBe(zh.quotaResetIn.replace('{value}', zh.relMinutes.replace('{n}', '30')))
    expect(untilText(at(180), t, NOW)).toBe(zh.quotaResetIn.replace('{value}', zh.relHours.replace('{n}', '3')))
    expect(untilText(at(3 * 24 * 60), t, NOW)).toBe(zh.quotaResetIn.replace('{value}', zh.relDays.replace('{n}', '3')))
    expect(untilText(at(195), t, NOW)).toBe(
      zh.quotaResetIn.replace('{value}', zh.relHoursMins.replace('{hours}', '3').replace('{mins}', '15')),
    )
    expect(untilText(at(3 * 24 * 60 + 5 * 60 + 20), t, NOW)).toBe(
      zh.quotaResetIn.replace('{value}', zh.relDaysHoursMins.replace('{days}', '3').replace('{hours}', '5').replace('{mins}', '20')),
    )
    expect(untilText(null, t, NOW)).toBe(zh.valueUnknown)
    expect(untilText('not-a-date', t, NOW)).toBe(zh.valueUnknown)
  })

  it('names a reset that has already passed as its own state', () => {
    // `untilText` answers "shortly" for a passed wall, which reads as a promise
    // the window has already kept.
    expect(resetText(at(-5), t, NOW)).toBe(zh.quotaResetPassed)
    expect(resetText(at(120), t, NOW)).toBe(zh.quotaResetIn.replace('{value}', zh.relHours.replace('{n}', '2')))
    expect(resetText(null, t, NOW)).toBeNull()
    expect(resetText('not-a-date', t, NOW)).toBeNull()
  })

  it('formats detailed countdowns for 5h and longer windows', () => {
    // 5h now reads EXACTLY like the weekly line: the full date plus a
    // minute-precision countdown. (A bare "resets in 3h 15m" was the only
    // window not saying when it would refill.) The wall-clock substring is
    // TZ-dependent, so the countdown carries the assertion.
    expect(formatDetailedReset('5h', at(195), t, NOW)).toContain(
      zh.badgeCountdownHoursMins.replace('{hours}', '3').replace('{mins}', '15'),
    )
    // 5h window: minutes only (< 1 hour)
    expect(formatDetailedReset('5h', at(45), t, NOW)).toContain(
      zh.badgeCountdownMins.replace('{mins}', '45'),
    )

    // Weekly window: days and hours
    const daysAndHours = formatDetailedReset('weekly', at(5 * 24 * 60 + 12 * 60), t, NOW)
    expect(daysAndHours).toContain(zh.badgeCountdownDaysHours.replace('{days}', '5').replace('{hours}', '12'))

    // Weekly window: days only
    const daysOnly = formatDetailedReset('weekly', at(3 * 24 * 60), t, NOW)
    expect(daysOnly).toContain(zh.badgeCountdownDays.replace('{days}', '3'))

    // Weekly window: hours only (< 1 day)
    const hoursOnly = formatDetailedReset('weekly', at(14 * 60), t, NOW)
    expect(hoursOnly).toContain(zh.badgeCountdownHours.replace('{hours}', '14'))

    // Weekly window: minutes only (< 1 hour)
    const minsOnly = formatDetailedReset('weekly', at(45), t, NOW)
    expect(minsOnly).toContain(zh.badgeCountdownMins.replace('{mins}', '45'))

    // Weekly window: days, hours and minutes
    const daysHoursMins = formatDetailedReset('weekly', at(5 * 24 * 60 + 12 * 60 + 30), t, NOW)
    expect(daysHoursMins).toContain(
      zh.badgeCountdownDaysHoursMins.replace('{days}', '5').replace('{hours}', '12').replace('{mins}', '30'),
    )

    // Weekly window: days and minutes (hours === 0)
    const daysMins = formatDetailedReset('weekly', at(2 * 24 * 60 + 40), t, NOW)
    expect(daysMins).toContain(
      zh.badgeCountdownDaysMins.replace('{days}', '2').replace('{mins}', '40'),
    )

    // Weekly window: hours and minutes (< 1 day)
    const hoursMins = formatDetailedReset('weekly', at(4 * 60 + 25), t, NOW)
    expect(hoursMins).toContain(
      zh.badgeCountdownHoursMins.replace('{hours}', '4').replace('{mins}', '25'),
    )

    // Passed reset
    expect(formatDetailedReset('5h', at(-5), t, NOW)).toBe(zh.quotaResetPassed)
    expect(formatDetailedReset('weekly', at(-10), t, NOW)).toBe(zh.quotaResetPassed)

    // Null or invalid reset
    expect(formatDetailedReset('5h', null, t, NOW)).toBeNull()
    expect(formatDetailedReset('weekly', 'invalid', t, NOW)).toBeNull()
  })

  it('selects standard vs detailed reset format based on the detailed flag', () => {
    const standard = formatQuotaReset('5h', at(195), t, NOW, false)
    expect(standard).toBe(resetText(at(195), t, NOW))

    const detailed = formatQuotaReset('5h', at(195), t, NOW, true)
    expect(detailed).toBe(formatDetailedReset('5h', at(195), t, NOW))
  })

  it('counts a past moment ago with a direction suffix', () => {
    expect(agoText(at(-0.5), t, NOW)).toBe(zh.relJustNow)
    expect(agoText(at(-35), t, NOW)).toBe(zh.relAgo.replace('{value}', zh.relMinutes.replace('{n}', '35')))
    expect(agoText(at(-5 * 60), t, NOW)).toBe(zh.relAgo.replace('{value}', zh.relHours.replace('{n}', '5')))
    expect(agoText(null, t, NOW)).toBe(zh.valueUnknown)
  })
})

describe('refresh policy', () => {
  it('lets an explicit refresh through regardless of the last failure', () => {
    expect(shouldProbeLimits({ force: true, failedAt: NOW - 1_000, now: NOW })).toBe('force')
  })

  it('leaves the automatic probe to the host TTL', () => {
    expect(shouldProbeLimits({ force: false, failedAt: null, now: NOW })).toBe('auto')
  })

  it('backs off after a run that measured nothing and failed', () => {
    // That run wrote no snapshot, so the host's TTL cannot gate it: without a
    // backoff every poll would probe an account whose proxy is down.
    expect(shouldProbeLimits({ force: false, failedAt: NOW - 1_000, now: NOW })).toBe('off')
    expect(shouldProbeLimits({
      force: false,
      failedAt: NOW - PROBE_FAILURE_BACKOFF_MS,
      now: NOW,
    })).toBe('auto')
  })

  it('upgrades an automatic load to a probe when a snapshot outlives the interval', () => {
    // ONE freshness rule for every automatic quota load (badge mount/wake and
    // the Settings cards alike): the configured interval is the age the data on
    // screen can reach, so a snapshot older than it must force a re-probe even
    // though the host's own TTL would still serve it from cache.
    expect(limitsOlderThanInterval([NOW - 4 * 60_000], 5, NOW)).toBe(false)
    expect(limitsOlderThanInterval([NOW - 5 * 60_000], 5, NOW)).toBe(false)
    expect(limitsOlderThanInterval([NOW - 5 * 60_000 - 1], 5, NOW)).toBe(true)
    // One stale row among fresh ones is enough — the board would render it.
    expect(limitsOlderThanInterval([NOW - 60_000, NOW - 9 * 60_000], 5, NOW)).toBe(true)
    // An empty pool and a "never" interval are both trivially non-expired.
    expect(limitsOlderThanInterval([], 5, NOW)).toBe(false)
    expect(limitsOlderThanInterval([NOW - 99 * 60_000], 0, NOW)).toBe(false)
  })

  it('never counts an unmeasured snapshot as interval-stale', () => {
    // A null timestamp means the host's non-forced pass already probes that
    // account immediately; forcing the pool because one row was never measured
    // would multiply the upstream cost without bounds.
    expect(limitsOlderThanInterval([null, undefined, NOW - 60_000], 5, NOW)).toBe(false)
    expect(limitsOlderThanInterval([null, undefined], 5, NOW)).toBe(false)
  })
})

describe('account quota read and the shared rotation rule', () => {
  const withLimits = (index: number, windows: QuotaWindow[], overrides: Partial<AccountView> = {}): AccountView =>
    account({ index, limits: [group('g', windows)], ...overrides })

  const healthy = (index: number, overrides: Partial<AccountView> = {}): AccountView =>
    withLimits(index, [
      window('h', '5h', 0.8, at(60)),
      window('w', 'weekly', 0.9, at(5000)),
    ], overrides)

  const fiveHourDrained = (index: number, overrides: Partial<AccountView> = {}): AccountView =>
    withLimits(index, [
      window('h', '5h', 0, at(60)),
      window('w', 'weekly', 0.9, at(5000)),
    ], overrides)

  const weeklyDrained = (index: number, overrides: Partial<AccountView> = {}): AccountView =>
    withLimits(index, [
      window('h', '5h', 0.8, at(60)),
      window('w', 'weekly', 0, at(5000)),
    ], overrides)

  it('reads the tightest live 5h and weekly fraction per account', () => {
    // Two pools report the same kind; the smaller live fraction is the one the
    // rotation would block on, so that is the number the badge shows.
    const view = account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0.4, at(60)), window('w', 'weekly', 0.9, at(5000))]),
        group('3p', [window('3p-h', '5h', 0.6, at(60))]),
      ],
    })
    expect(accountQuotaRead(view, NOW)).toEqual({ fiveHour: 0.4, weekly: 0.9 })
  })

  it('resolves model groups and isolates readings by target or actualModel', () => {
    const geminiGroup = group('Gemini Models', [window('gemini-h', '5h', 0.54, at(60)), window('gemini-w', 'weekly', 0.86, at(5000))])
    const claudeGroup = group('Claude and GPT models', [window('3p-h', '5h', 1.0, at(60)), window('3p-w', 'weekly', 0, at(5000))])
    const groups = [geminiGroup, claudeGroup]

    expect(resolveQuotaGroup(groups, 'gemini-3.8-flash-n')).toBe(geminiGroup)
    expect(resolveQuotaGroup(groups, 'claude-sonnet-4-6')).toBe(claudeGroup)
    expect(resolveQuotaGroup(groups, 'auto')).toBe(geminiGroup)
    expect(resolveQuotaGroup(groups, 'Claude and GPT models')).toBe(claudeGroup)

    expect(modelLabelForGroup(geminiGroup, 'gemini-3.8-flash-n')).toBe('Gemini')
    expect(modelLabelForGroup(claudeGroup, 'claude-sonnet-4-6')).toBe('Claude')
    expect(modelLabelForGroup(claudeGroup, 'gpt-4o')).toBe('GPT')

    const view = account({
      actualModel: 'gemini-3.8-flash-n',
      limits: groups,
    })
    // Auto target matches actualModel (Gemini Models), ignoring Claude's 0% weekly
    expect(accountQuotaRead(view, NOW, 'auto')).toEqual({ fiveHour: 0.54, weekly: 0.86 })
    // Explicit Claude group reads Claude's windows
    expect(accountQuotaRead(view, NOW, 'Claude and GPT models')).toEqual({ fiveHour: 1.0, weekly: 0 })
  })

  it('withholds readings whose window already reset, and null stays null', () => {
    const view = account({
      limits: [group('g', [
        window('h', '5h', 0, at(-30)),
        window('w', 'weekly', null, at(60)),
      ])],
    })
    // A fraction from a period that already ended is not evidence, and an
    // unmeasured window is unknown — neither may read as a live 0%.
    expect(accountQuotaRead(view, NOW)).toEqual({ fiveHour: null, weekly: null })
    expect(isAccountQuotaExhausted(view, NOW)).toBe(false)
    expect(isAccountQuotaExhausted(account(), NOW)).toBe(false)
    expect(isAccountQuotaExhausted(undefined, NOW)).toBe(false)
  })

  it('judges exhaustion from EITHER tracked window at exactly 0', () => {
    // The pool's own verdict (`isFamilyQuotaExhausted`) blocks on a zero 5h
    // window OR a spent week; the badge's red light is the same condition, so
    // the display can never call drained what the pool would still ride.
    expect(isAccountQuotaExhausted(weeklyDrained(0), NOW)).toBe(true)
    expect(isAccountQuotaExhausted(fiveHourDrained(0), NOW)).toBe(true)
    expect(isAccountQuotaExhausted(healthy(0), NOW)).toBe(false)
  })

  it('rotates to the next healthy account, skipping drained and disabled ones', () => {
    // Active 0 is drained: the next healthy in pool order wins.
    expect(nextHealthyIndex(
      [fiveHourDrained(0, { active: true }), healthy(1, { active: false }), weeklyDrained(2, { active: false }), healthy(3, { active: false })],
      NOW,
    )).toBe(1)

    // A disabled row between healthy ones is not a destination.
    expect(nextHealthyIndex(
      [fiveHourDrained(0, { active: true }), healthy(1, { state: 'disabled', active: false }), healthy(2, { active: false })],
      NOW,
    )).toBe(2)

    // No healthy account after the active one wraps back to the front.
    expect(nextHealthyIndex(
      [healthy(0, { active: false }), healthy(1, { active: true }), fiveHourDrained(2, { active: false })],
      NOW,
    )).toBe(0)

    // Everyone drained (or disabled): nowhere to go — the caller must NOT
    // rotate, or two drained accounts would chase each other forever.
    expect(nextHealthyIndex(
      [fiveHourDrained(0, { active: true }), weeklyDrained(1, { active: false })],
      NOW,
    )).toBeNull()
    expect(nextHealthyIndex(
      [fiveHourDrained(0, { active: true }), healthy(1, { state: 'disabled', active: false })],
      NOW,
    )).toBeNull()
  })
})

describe('smart pause verdicts', () => {
  /**
   * The smart-mode question is the POOL-WIDE one — "can ANY model serve" — so
   * these helpers read EVERY measured group, unlike `isAccountQuotaExhausted`
   * above, which watches the one group the badge displays.
   */
  it('judges a group exhausted only on a live 0% of a window the pool blocks on', () => {
    expect(isGroupQuotaExhausted(group('g', [
      window('h', '5h', 0, at(60)),
      window('w', 'weekly', 0, at(5000)),
    ]), NOW)).toBe(true)
    // Weekly 0% alone exhausts the group too.
    expect(isGroupQuotaExhausted(group('g', [
      window('h', '5h', 0.8, at(60)),
      window('w', 'weekly', 0, at(5000)),
    ]), NOW)).toBe(true)
    // The pool blocks on EITHER window — its own isFamilyQuotaExhausted rule —
    // so a spent 5h window exhausts the group even with weekly runway left.
    expect(isGroupQuotaExhausted(group('g', [
      window('h', '5h', 0, at(60)),
      window('w', 'weekly', 0.1, at(5000)),
    ]), NOW)).toBe(true)
    // A group with no drained window at all is servable.
    expect(isGroupQuotaExhausted(group('g', [
      window('h', '5h', 0.8, at(60)),
      window('w', 'weekly', 0.1, at(5000)),
    ]), NOW)).toBe(false)
    // daily/monthly never block the pool, so their 0% is display-only.
    expect(isGroupQuotaExhausted(group('g', [window('d', 'daily', 0, at(60))]), NOW)).toBe(false)
    // A 0% from a period that already ended is not evidence.
    expect(isGroupQuotaExhausted(group('g', [window('h', '5h', 0, at(-30))]), NOW)).toBe(false)
    // Unmeasured is unknown, not spent.
    expect(isGroupQuotaExhausted(group('g', [window('h', '5h', null, at(60))]), NOW)).toBe(false)
  })

  it('pauses only when EVERY measured group is unusable, and unmeasured is never exhausted', () => {
    const allDrained = account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0, at(60)), window('w', 'weekly', 0, at(5000))]),
        group('Claude and GPT models', [window('3p-h', '5h', 0, at(90))]),
      ],
    })
    expect(isAccountAllQuotaExhausted(allDrained, NOW)).toBe(true)
    // One group with a usable window still has a model to route to.
    const oneUsable = account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0, at(60)), window('w', 'weekly', 0, at(5000))]),
        group('Claude and GPT models', [window('3p-h', '5h', 0.5, at(90))]),
      ],
    })
    expect(isAccountAllQuotaExhausted(oneUsable, NOW)).toBe(false)
    // Never measured is unknown — pausing on it would freeze the board on nothing.
    expect(isAccountAllQuotaExhausted(account(), NOW)).toBe(false)
    expect(isAccountAllQuotaExhausted(account({ limits: [] }), NOW)).toBe(false)
    expect(isAccountAllQuotaExhausted(undefined, NOW)).toBe(false)
    // A disabled row cannot serve either — but only when it IS measured, so the
    // shape of the answer stays "known unusable", not "no data".
    expect(isAccountAllQuotaExhausted(account({
      state: 'disabled',
      limits: [group('g', [window('h', '5h', 0.9, at(60))])],
    }), NOW)).toBe(true)
  })

  it('promises recovery at the earliest usable group, whose reset is the max of its drained windows', () => {
    // Group A: both windows drained — usable when the LATER one resets (the
    // week). Group B: only the 5h drained — usable at its own reset. The
    // account is back the moment the FIRST group returns, so B's 30 minutes.
    const mixed = account({
      limits: [
        group('Gemini Models', [
          window('h', '5h', 0, at(60)),
          window('w', 'weekly', 0, at(5000)),
        ]),
        group('Claude and GPT models', [window('3p-h', '5h', 0, at(30))]),
      ],
    })
    expect(accountRecoveryTime(mixed, NOW)).toBe(NOW + 30 * 60_000)

    // One drained account, one exhausted group: usable when its later window resets.
    const single = account({
      limits: [group('g', [
        window('h', '5h', 0, at(20)),
        window('w', 'weekly', 0, at(5000)),
      ])],
    })
    expect(accountRecoveryTime(single, NOW)).toBe(NOW + 5000 * 60_000)

    // The shape upstream actually reports on a spent week: weekly 0% blocks the
    // family even while the 5h window still has runway, so the group's recovery
    // waits for the WEEK — the 5h reading does not shorten the wait, and the
    // pause must not end at the earlier 5h reset only to re-pause.
    const weeklyOnly = account({
      limits: [group('g', [
        window('h', '5h', 0.8, at(20)),
        window('w', 'weekly', 0, at(5000)),
      ])],
    })
    expect(isAccountAllQuotaExhausted(weeklyOnly, NOW)).toBe(true)
    expect(accountRecoveryTime(weeklyOnly, NOW)).toBe(NOW + 5000 * 60_000)

    // A group that is not exhausted at all makes the account usable NOW.
    const oneUsable = account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0.3, at(60))]),
        group('Claude and GPT models', [window('3p-h', '5h', 0, at(30))]),
      ],
    })
    expect(accountRecoveryTime(oneUsable, NOW)).toBe(NOW)
  })

  it('never promises a pause without an end: unusable resets keep the regular cadence', () => {
    // A 0% window with no reset moment at all cannot promise when it returns.
    const noReset = account({
      limits: [group('g', [window('h', '5h', 0, null)])],
    })
    expect(accountRecoveryTime(noReset, NOW)).toBeNull()

    // A reset moment that cannot be parsed counts as PASSED (the shared
    // stale-reading rule), so the group reads usable and the answer is now —
    // the one shape where "unknown reset" means resume rather than never pause.
    const badReset = account({
      limits: [group('g', [window('h', '5h', 0, 'not-a-date')])],
    })
    expect(accountRecoveryTime(badReset, NOW)).toBe(NOW)

    // The unpromisable group is skipped when ANOTHER group does promise.
    const partiallyPromised = account({
      limits: [
        group('Gemini Models', [window('h', '5h', 0, null)]),
        group('Claude and GPT models', [window('3p-h', '5h', 0, at(45))]),
      ],
    })
    expect(accountRecoveryTime(partiallyPromised, NOW)).toBe(NOW + 45 * 60_000)

    // And nothing measured promises nothing.
    expect(accountRecoveryTime(account(), NOW)).toBeNull()
    expect(accountRecoveryTime(undefined, NOW)).toBeNull()
  })

  it('reads the verdict from the ACTIVE account, falling back to the first row', () => {
    const drainedActive = account({
      index: 2,
      active: true,
      limits: [group('g', [window('h', '5h', 0, at(60))])],
    })
    const idleHealthy = account({ index: 5, active: false, limits: [group('g', [window('h', '5h', 0.9, at(60))])] })

    const verdict = smartQuotaVerdict([drainedActive, idleHealthy], NOW)
    expect(verdict.index).toBe(2)
    expect(verdict.exhausted).toBe(true)
    expect(verdict.recoverAt).toBe(NOW + 60 * 60_000)

    // No active row marked: the first account is what the pool would serve.
    const fallback = smartQuotaVerdict([idleHealthy], NOW)
    expect(fallback.index).toBe(5)
    expect(fallback.exhausted).toBe(false)
    expect(fallback.recoverAt).toBe(NOW)

    // An empty pool has no subject and pauses nothing.
    expect(smartQuotaVerdict([], NOW)).toEqual({ index: null, exhausted: false, recoverAt: null })
  })
})


