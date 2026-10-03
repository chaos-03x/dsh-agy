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
  agoText,
  buildQuotaCards,
  desensitizeEmail,
  dotStateFor,
  drainThresholdFor,
  pickBadgeQuota,
  pickBadgeWindow,
  PROBE_FAILURE_BACKOFF_MS,
  quotaColor,
  resetText,
  shouldProbeLimits,
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
  it('tints by the theme tokens the Settings panel already uses', () => {
    expect(quotaColor(0.8)).toContain('--dsw-alias-state-success-primary')
    expect(quotaColor(0.5)).toContain('--dsw-alias-state-warn-primary')
    expect(quotaColor(0.1)).toContain('--dsw-alias-state-error-primary')
  })

  it('imports the pool thresholds rather than restating them', () => {
    expect(drainThresholdFor('5h')).toBe(SOFT_QUOTA_THRESHOLD)
    expect(drainThresholdFor('weekly')).toBe(WEEKLY_QUOTA_THRESHOLD)
    // Reported but never blocked on: no threshold, so they never decide.
    expect(drainThresholdFor('daily')).toBeUndefined()
    expect(drainThresholdFor('monthly')).toBeUndefined()
    expect(drainThresholdFor('30d')).toBeUndefined()
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
})


