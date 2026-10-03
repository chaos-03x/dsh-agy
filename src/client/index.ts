/**
 * agy Settings section — the browser half.
 *
 * One `settings.section` page with four tabs (accounts, models, usage,
 * credentials), replacing the standalone `/agy` dashboard. Every figure comes
 * from the `/api/agy` RPC over `ctx.connection`, so this section needs no
 * host-rendered page and there is no second UI to keep in step.
 *
 * Elements are built through the local `h` helper rather than JSX or nested
 * `createElement` calls: this package configures no JSX transform for the client
 * bundle, and `h(tag, props, ...children)` keeps the element tree flat and
 * readable where nested `createElement` calls become a parenthesis maze.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import {
  Button,
  Input,
  Pill,
  StateDot,
  Switch,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { installAgyStyles } from './styles.ts'
import { en, zh, type AgyLocaleKey } from './locales.ts'
import { h } from './element.ts'
import { AgyQuotaBadge } from './quota-badge.ts'
import { agoText, quotaColor, stateLabel, untilText, windowLabel, MINUTE_MS, HOUR_MS } from './quota-view.ts'
import type { AccountView, AgyRpcClient, AgyRpcResult, ModelView, StatsView, ThinkingBudgets } from '../rpc-contract.ts'
import { CLAUDE_BUDGET_MAX, CLAUDE_BUDGET_MIN, THINKING_BUDGET_MAX, THINKING_BUDGET_MIN, THINKING_LEVELS } from '../thinking-types.ts'
import type { UsageCounters } from '../usage-types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Antigravity Settings section. */
    agy: AgyLocaleKey
  }

  /**
   * The Session header's action row.
   *
   * The face is OWNED by `@deepseek-ai/dsh-client-ui-conversation`, which this
   * package deliberately does not depend on: that UI package brings its own
   * app-shell peer set, and a plugin registering ONE slot should not install a
   * shell to name it. The entry below mirrors that package's declaration (a
   * list-ordered slot scoped to a Session, whose owner face is empty because
   * header actions read the standard session kit) — the same declaration-merging
   * idiom already used for `LocaleNamespaceMap` above.
   */
  interface SlotMap {
    'conversation.session.header.actions': {
      kind: 'list'
      scope: 'session'
      owner: Record<string, never>
    }
  }
}

/** Required browser services: the slot registry, dictionaries, and the RPC carrier. */
export const inject = ['slots', 'locale', 'connection']

/** Dictionary namespace this plugin owns. */
const NS = 'agy'

/** This section's translator. */
type T = TranslateNS<typeof NS>

/** One row of the recent-activity list (`pool.recent`). */
type RecentEntry = AgyRpcResult<'pool.recent'>['recent'][number]

/** RPC channel and endpoint the host registers as `/api/agy`. */
const RPC_CHANNEL = '/api'
const RPC_ENDPOINT = 'agy'

type TabId = 'accounts' | 'models' | 'usage' | 'credentials'

/**
 * How long a one-shot action's verdict stays on screen.
 *
 * Both the success and the failure channel use this: an action's outcome is a
 * transient acknowledgement, and the screen is in a valid state either way. A
 * STANDING failure (the account list failing to load) deliberately does not use
 * it — see `actionError` in `AgySettings`.
 */
const ACTION_MESSAGE_TTL_MS = 3_500

/**
 * How often the section re-reads the pool's in-flight snapshot.
 *
 * The call is a pure in-memory read on the host (no token refresh, no quota
 * probe), so a tight-ish interval is free; 3s makes the live line feel live
 * without a visible request cost.
 */
const POOL_POLL_INTERVAL_MS = 3_000

/** Connection shape this plugin needs (structural, so no host-only import). */
interface ConnectionLike {
  rpc: {
    call: (channel: string, endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>
  }
}

/** Call one management method and unwrap the Connection RPC envelope. */
function createRpc(connection: ConnectionLike): AgyRpcClient {
  return {
    async call(method, payload, signal) {
      const raw = await connection.rpc.call(
        RPC_CHANNEL,
        RPC_ENDPOINT,
        { method, payload },
        signal,
      ) as { ok?: boolean; value?: unknown; error?: { message?: string } } | undefined
      if (raw?.ok === true) return raw.value as never
      if (raw?.ok === false) throw new Error(raw.error?.message ?? `${method} failed`)
      // An unrecognized envelope means the transport misbehaved; surfacing it
      // beats returning undefined as though the call had succeeded.
      throw new Error(`${method}: malformed RPC response`)
    },
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

/** Compact token text: 1.2M / 284K / 512. */
/** Token-count units, largest first. */
const TOKEN_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1_000_000_000_000, 'T'],
  [1_000_000_000, 'B'],
  [1_000_000, 'M'],
  [1_000, 'K'],
]

/**
 * Compact token count: `1.2M` / `284K` / `512`. Counts below 1000 render in
 * full — a suffix starts at 1K.
 *
 * The unit is chosen from the value ROUNDED TO ITS DISPLAYED PRECISION, and
 * promoted when that rounding would reach 1000 (which belongs to the next unit).
 * Deciding from the raw magnitude let rounding contradict the suffix: 999_999
 * printed as `1000K`, 99999 as `100.0K` while 100000 was `100K`, and 9999999 as
 * `10.0M` while 10000000 was `10M`.
 *
 * Exported for a direct unit test: the boundaries are exactly where this broke.
 * @param value - token count.
 * @returns the display string.
 */
export function tokenText(value: number): string {
  if (value < 1_000) return String(value)
  /** One decimal below 100 (`1.2M`), none at or above (`284K`). */
  const render = (scaled: number, suffix: string): string =>
    `${scaled < 100 ? scaled.toFixed(1) : String(Math.round(scaled))}${suffix}`

  // Largest unit the value reaches; a smaller index is a larger unit.
  const start = TOKEN_UNITS.findIndex(([divisor]) => value >= divisor)
  for (let index = start; index >= 0; index--) {
    const [divisor, suffix] = TOKEN_UNITS[index]!
    const scaled = Math.round((value / divisor) * 10) / 10
    // Rounding overflow belongs to the next unit up, not to `1000<suffix>`.
    if (scaled < 1_000) return render(scaled, suffix)
  }
  // Beyond the largest unit: render it anyway rather than mislabel the value.
  const [divisor, suffix] = TOKEN_UNITS[0]!
  return render(Math.round((value / divisor) * 10) / 10, suffix)
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const seconds = ms / 1_000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`
}

/** Cache-hit share of prompt-side input; null when nothing was billed. */
function cacheHitPercent(counters: UsageCounters): number | null {
  const billed = counters.input + counters.cacheRead + counters.cacheWrite
  if (billed <= 0) return null
  return Math.round((counters.cacheRead / billed) * 100)
}

function average(total: number, count: number): number {
  return count > 0 ? total / count : 0
}

/** Total tokens across the four disjoint buckets. */
function totalTokens(counters: UsageCounters): number {
  return counters.input + counters.output + counters.cacheRead + counters.cacheWrite
}

/**
 * Cumulative average OUTPUT rate for one scope, in tokens per second.
 *
 * Pure and exported for a direct unit test. The denominator is the STREAMING
 * window (average latency minus average time-to-first-token), NOT the wall
 * clock: on this channel the pre-first-token wait (upstream queue, routing,
 * prompt processing, silent thinking) is ~90% of the request — measured 7.5s
 * of an 8.3s average — so dividing by wall time understated the decode rate
 * about 8× (40 tok/s shown where the account really streamed ~300).
 *
 * Per-request AVERAGES, not raw sums: a failed request carries wall time but
 * never a first token (`latencyN` > `ttftN`), so subtracting raw sums would
 * hand its wait to the decode window. Both averages must exist — a scope with
 * no timed request or no reported first token gets null, hiding the row rather
 * than showing a fake rate.
 */
export function throughputTokenPerSecond(totals: UsageCounters): number | null {
  if (totals.latencyN === 0 || totals.ttftN === 0 || totals.output <= 0) return null
  const decodeMs = totals.latencyMs / totals.latencyN - totals.ttftMs / totals.ttftN
  if (decodeMs <= 0) return null
  return Math.round(totals.output / totals.latencyN / (decodeMs / 1_000))
}

/**
 * The whole prompt side: everything the model read, cached or not.
 *
 * The LEDGER keeps `input` as the uncached portion alone, because that is DSH's
 * own disjoint-bucket vocabulary (`usage-types.ts`, and the adapter's SSE parse
 * subtracts the cached count for exactly this reason) — that split must not be
 * redefined at the storage layer.
 *
 * The DISPLAY folds it, though: an input figure of 18.6M beside a cache figure
 * of 62.2M reads as though 62.2M went unaccounted for, and a cache read LARGER
 * than the input looks like a bug rather than the expected shape of a prefix
 * cache. So the headline shows the whole prompt side and the cache line becomes
 * a HIT count — a subset, which is why the two are never added together and the
 * old explanatory footnote is gone.
 * @param counters - one scope's counters.
 * @returns prompt tokens including the cached portion.
 */
function promptTokens(counters: UsageCounters): number {
  return counters.input + counters.cacheRead + counters.cacheWrite
}

/**
 * Localized label for a reasoning level.
 *
 * Falls back to the raw id so a level added upstream is still usable rather than
 * rendering blank.
 */
function levelLabel(level: string, t: T): string {
  switch (level) {
    case 'low': return t('thinkingLevelLow')
    case 'medium': return t('thinkingLevelMedium')
    case 'high': return t('thinkingLevelHigh')
    default: return level
  }
}

/**
 * Humanize a burn horizon (hours until a window runs dry at the sampled rate).
 *
 * Reuses the shared `rel*` magnitudes so the phrasing matches every other
 * duration on the panel; under an hour falls to minutes rather than rounding
 * to a false zero.
 */
function burnHorizon(hours: number, t: T): string {
  if (hours < 1) return t('relMinutes', { n: Math.max(1, Math.round(hours * 60)) })
  if (hours < 48) return t('relHours', { n: Math.round(hours) })
  return t('relDays', { n: Math.round(hours / 24) })
}

/**
 * A wall-clock moment for a state label (a cooldown end).
 *
 * Time-of-day alone is enough while the wall is today; past midnight it must
 * carry the date, or a 24h quota cooldown reads as though it ends in a few
 * minutes. (`untilText` is the relative form, used where "how long from now" is
 * the question rather than "when".)
 *
 * `lang` is the UI language ('zh' | 'en'), not the browser locale: the words on
 * this panel follow the host's language setting, so the dates must too — a zh
 * panel rendering `9/24/2026` (the browser's en-US ordering) was the symptom.
 * `undefined` degrades to the browser default, the pre-`lang` behaviour.
 */
function clockTime(iso: string | null, lang?: string): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay
    ? date.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString(lang, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * A ledger day key ('YYYY-MM-DD', local by construction) as a short label.
 * Parsed as LOCAL date parts — a UTC parse would shift the label a day for
 * half the planet.
 */
function dayLabel(day: string, lang?: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return day
  return new Date(y, m - 1, d).toLocaleDateString(lang, { month: 'short', day: 'numeric' })
}

/**
 * Localized label for a cooldown reason.
 *
 * Falls back to the raw token so a reason added on the host side still renders
 * something legible rather than blank.
 */
function cooldownReasonLabel(reason: string, t: T): string {
  switch (reason) {
    case 'network-error': return t('cooldownReasonNetworkError')
    case 'quota-exhausted': return t('cooldownReasonQuotaExhausted')
    case 'validation-required': return t('cooldownReasonValidationRequired')
    case 'project-error': return t('cooldownReasonProjectError')
    default: return reason
  }
}

/**
 * Ago label with seconds resolution, for the recent list. `agoText` collapses
 * the whole first minute into "just now", which is too coarse when the reader
 * is watching live activity — here the seconds carry the information.
 */
function recentAgo(at: number, now: number, t: T): string {
  const diff = now - at
  if (diff < 10_000) return t('relJustNow')
  if (diff < MINUTE_MS) return t('relSeconds', { n: Math.floor(diff / 1_000) })
  return agoText(new Date(at).toISOString(), t, now)
}

/**
 * Middle-truncate an identity for the recent list.
 *
 * Both ends carry the signal — an email's domain, a model id's tier suffix —
 * so the cut is taken from the MIDDLE, and bounding the rendered length (not
 * relying on CSS clipping of a `table-layout: fixed` cell) is what keeps the
 * columns honest. The full value stays on the cell's title.
 * @param text - the full identity.
 * @param max - rendered character budget including the ellipsis.
 * @returns the truncated display string.
 */
export function truncateIdentity(text: string, max = 22): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}
// ─── building blocks ─────────────────────────────────────────────────────────

/**
 * A host-styled button.
 *
 * Delegates to the host's `Button` so focus rings, disabled states, size tiers
 * and theming are the platform's rather than an imitation. `danger` has no
 * primitive equivalent, so it keeps the ghost family with a local class.
 *
 * Every click stops propagating. Account rows are themselves click targets
 * (selecting the row), so without this a row's "Delete"/"Verify"/"Activate"
 * button also selected that row — and for Delete the row indices then shifted
 * underneath a selection that was about to be acted on. Stopping unconditionally
 * is safe for buttons outside rows, where there is no ancestor handler.
 */
function button(label: string, onClick: () => void, options: {
  variant?: 'danger' | 'ghost'
  size?: 'sm'
  disabled?: boolean
  title?: string
} = {}): ReactNode {
  return h(Button, {
    variant: options.variant === 'danger' ? 'outline' : (options.variant ?? 'outline'),
    size: options.size === 'sm' ? 'sm' : 'md',
    ...(options.disabled === true ? { disabled: true } : {}),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.variant === 'danger' ? { className: 'agy-btn-danger' } : {}),
    onClick: (event: { stopPropagation?: () => void }) => {
      event?.stopPropagation?.()
      onClick()
    },
  }, label)
}

/** Full-width quota row used by the (collapsible) model quota list. */
/** Account state rendered with the host's state dot plus a tinted tag. */
function stateBadge(state: AccountView['state'], label: string): ReactNode {
  const dot: StateDotState = state === 'active'
    ? 'done'
    : state === 'cooling' ? 'warning' : 'error'
  const tone: TagTone = state === 'active' ? 'success' : state === 'cooling' ? 'warning' : 'danger'
  return h('span', { className: 'agy-state' },
    h(StateDot, { state: dot, size: 8 }),
    h(Tag, { tone }, label))
}

function subhead(title: string, aside?: string): ReactNode {
  return h('div', { className: 'agy-subhead' },
    h('span', null, title),
    aside === undefined || aside === '' ? null : h('span', { className: 'agy-aside' }, aside))
}

function hint(text: string): ReactNode {
  return h('p', { className: 'agy-hint' }, text)
}

function table(headers: ReactNode, rows: ReactNode[]): ReactNode {
  return h('table', { className: 'agy-table' },
    headers === null ? null : h('thead', null, headers),
    h('tbody', null, ...rows))
}

/** A titled grouping surface. Grouping is what keeps a dense page readable. */
function card(title: ReactNode, body: ReactNode, aside?: ReactNode): ReactNode {
  return h('section', { className: 'agy-card' },
    h('div', { className: 'agy-card-head' },
      h('span', { className: 'agy-card-title' }, title),
      aside === undefined ? null : h('span', { className: 'agy-aside' }, aside)),
    h('div', { className: 'agy-card-body' }, body))
}

/** A metric strip inside a card. */
function metrics(cells: ReactNode[]): ReactNode {
  return h('div', { className: 'agy-metrics' }, ...cells)
}

/** One metric cell: a label, a large value, and an optional detail line. */
function metric(label: string, value: number | string, detail: string): ReactNode {
  const text = typeof value === 'number' ? tokenText(value) : value
  // Split a trailing unit so it can be typeset smaller, e.g. "1.2" + "M".
  const match = /^([\d.]+)([MK]?)$/.exec(text)
  return h('div', { className: 'agy-metric' },
    h('div', { className: 'agy-metric-k' }, label),
    h('div', { className: 'agy-metric-v' },
      match === null ? text : match[1],
      match !== null && match[2] !== '' ? h('small', null, match[2]) : null),
    h('div', { className: 'agy-metric-d' }, detail))
}

/** Definition rows: label/value pairs with hairline separators. */
function defs(rows: Array<[ReactNode, ReactNode]>): ReactNode {
  return h('dl', { className: 'agy-defs' },
    ...rows.flatMap(([label, value], index) => [
      h('dt', { key: `k${index}` }, label),
      h('dd', { key: `v${index}` }, value),
    ]))
}

// ─── Accounts tab ────────────────────────────────────────────────────────────

interface AccountHandlers {
  /** Localized copy, resolved per render so a language switch applies. */
  t: T
  onActivate: (index: number) => void
  onVerify: (index: number) => void
  onDelete: (index: number) => void
  onTest: (index: number) => void
  onExport: (index: number) => void
  onRegenerateFingerprint: (index: number) => void
  onSetProxy: (index: number, proxy: string) => void
  /**
   * Probe a proxy. The draft is passed alongside the index so an UNSAVED value
   * can be tested; an empty string means "use the account's stored proxy".
   */
  onTestProxy: (index: number, proxy: string) => void
}

/** One account's detail: identity, cumulative usage, proxy, and its actions. */
function AccountDetail(props: {
  account: AccountView
  busy: boolean
  handlers: AccountHandlers
  /** UI language for locale-sensitive date formatting ('zh' | 'en'). */
  lang?: string
  t: T
}): ReactNode {
  const { account, busy, handlers, t } = props
  const [proxyDraft, setProxyDraft] = useState('')
  const usage = account.usage
  // One clock reading per render, so every reset label agrees (as the quota list does).
  const now = Date.now()
  const throughput = usage === null ? null : throughputTokenPerSecond(usage.totals)

  // The verification challenge, when the upstream raised one. The state badge
  // says the account is parked; THIS is the only place that says how to un-park
  // it, and the link exists nowhere else in the UI — dropping it left the appeal
  // URL reachable over the RPC but invisible to the person who has to act on it.
  const identityRows: Array<[ReactNode, ReactNode]> = [
    [t('fieldProject'), account.projectId ?? t('noProject')],
    [t('fieldProxy'), h('span', { className: 'agy-mono' }, account.proxy ?? t('proxyDirect'))],
    [t('fieldFingerprint'), account.fingerprint === null
      ? t('fingerprintNone')
      : t('fingerprintRegenerated', {
        count: account.fingerprintHistory,
        date: new Date(account.fingerprint.createdAt).toLocaleDateString(props.lang),
      })],
    // The age matters as much as the reason: "network error" alone reads the
    // same whether it happened seconds or days ago, which is exactly how a stale
    // value went unnoticed. The host clears expired state before rendering, so
    // this row and the state badge cannot agree to disagree. The row renders
    // ONLY while a reason is live — a permanent "—" told the reader nothing and
    // padded every healthy account.
    ...(account.cooldownReason === null ? [] : [[
      t('fieldCooldownReason'),
      `${cooldownReasonLabel(account.cooldownReason, t)} · ${agoText(account.cooldownSetAt, t, now)}`,
    ] as [ReactNode, ReactNode]]),
    [t('fieldSources'), usage === null
      ? t('noProject')
      : t('sourcesSummary', {
        chat: usage.sources.chat,
        cli: usage.sources.cli,
        verify: usage.sources.verify,
        test: usage.sources.test,
      })],
    [t('fieldLatency'), usage === null
      ? t('noProject')
      : `${t('latencyAverage', { value: formatDuration(average(usage.totals.latencyMs, usage.totals.latencyN)) })}`
        + ` · ${t('latencyTtft', { value: formatDuration(average(usage.totals.ttftMs, usage.totals.ttftN)) })}`],
    // Streaming decode rate (output over the window AFTER the first token), a
    // lifetime average — the ledger stores sums, not samples. Absent entirely
    // when nothing was timed, rather than rendering a fake 0.
    ...(throughput === null ? [] : [[
      t('fieldThroughput'),
      `${t('throughputValue', { n: throughput })} · ${t('throughputNote')}`,
    ] as [ReactNode, ReactNode]]),
  ]
  // Disabled is the one state whose recovery REQUIRES a human action, so the
  // row must say what happened, when, and what to do next. The cause space has
  // exactly one value (an upstream invalid_grant), so the reason is a fixed
  // sentence; the time comes from `disabledAt` (null for pre-field data, where
  // "when" is simply absent rather than faked).
  if (account.state === 'disabled') {
    identityRows.push([t('fieldDisabled'), account.disabledAt === null
      ? t('disabledCredentials')
      : `${t('disabledCredentials')} · ${t('disabledSince', { ago: agoText(account.disabledAt, t, now) })}`])
  }
  if (account.verificationRequired) {
    identityRows.push([t('fieldVerification'), account.verificationUrl === null
      ? t('verificationNoUrl')
      : h('a', {
        className: 'agy-link',
        href: account.verificationUrl,
        // A new tab, because the Settings section is inside the host SPA:
        // navigating away would lose the panel the user is working in.
        target: '_blank',
        rel: 'noreferrer noopener',
      }, t('verificationOpen'))])
  }

  const identity = card(t('detailTitle'),
    h('div', null,
      defs(identityRows),
      account.state === 'disabled' ? hint(t('disabledHint')) : null),
    account.email ?? `#${account.index}`)

  // Deleting lives here, in the one-account surface, not on every list row: a
  // destructive action per row sat one misclick from the row's other buttons,
  // and the confirm() dialog was the only guard. The row keeps the frequent,
  // safe actions; the detail — where the user's attention already is — owns the
  // destructive one.
  const actions = card(t('colActions'), h('div', { className: 'agy-actions' },
    button(t('actionTest'), () => { handlers.onTest(account.index) }, { disabled: busy }),
    button(t('actionExport'), () => { handlers.onExport(account.index) }, { disabled: busy }),
    button(t('actionRegenerateFingerprint'), () => { handlers.onRegenerateFingerprint(account.index) }, { disabled: busy }),
    button(t('actionDelete'), () => { handlers.onDelete(account.index) }, { variant: 'danger', disabled: busy })))

  /**
   * The 5-hour / weekly windows, placed ABOVE the cumulative usage card.
   *
   * Ordering is deliberate: these are the figures a user actually acts on
   * (the rolling budget still available), while cumulative usage is a
   * retrospective total that only grows. Putting the actionable number first is
   * the whole point of the panel.
   *
   * A window with no reported fraction renders its bar empty and its percentage
   * as an em dash — "unknown" must not look like "0% left". A null `limits` means
   * the account has not been measured YET, and says so rather than showing an
   * empty card. That is reachable at any pool size: `refreshLimits` runs for a
   * solo account too (unlike the scheduling quota refresh, which a pool of one
   * skips because measuring it could block the only account).
   */
  const limitsBlock = card(t('limitsTitle'),
    account.limits === null || account.limits.length === 0
      ? h('div', { className: 'agy-empty' }, t('limitsUnavailable'))
      // The snapshot's age is shown, not just its values. These windows come from
      // a TTL cache and a FAILED refresh keeps the previous numbers rather than
      // clearing them, so an unlabelled figure could be arbitrarily old with
      // nothing on screen to say so — the same trap as an undated cooldown reason.
      : h('div', { className: 'agy-limits' },
        account.limitsUpdatedAt === null
          ? null
          : h('div', { className: 'agy-limit-age' },
            t('limitsMeasured', { ago: agoText(new Date(account.limitsUpdatedAt).toISOString(), t, now) })),
        ...account.limits.map((group) => h('div', { className: 'agy-limit-group', key: group.name },
          h('div', { className: 'agy-limit-group-name' }, group.name),
          ...group.windows.map((window) => {
            const fraction = window.remainingFraction
            // Burn projection: rate (fraction/hour) over remaining fraction
            // gives hours-to-empty. Spoken ONLY when that lands BEFORE the
            // window's reset — otherwise the reset time this row already shows
            // is the answer, and a "won't run dry" line is noise.
            const burn = account.limitBurn?.[window.bucketId]
            const hoursLeft = fraction !== null && burn !== undefined && burn > 0
              ? fraction / burn
              : null
            const resetHours = window.resetTime === null
              ? null
              : (new Date(window.resetTime).getTime() - now) / HOUR_MS
            const exhaustsFirst = hoursLeft !== null && resetHours !== null
              && hoursLeft < resetHours
            return h('div', { key: window.bucketId },
              h('div', { className: 'agy-limit-row' },
                h('span', { className: 'agy-limit-k' }, windowLabel(window.window, t)),
                h('span', { className: 'agy-limit-track' },
                  fraction === null
                    ? null
                    : h('i', { style: { width: `${Math.round(fraction * 100)}%`, background: quotaColor(fraction) } })),
                // An unreported fraction is an em dash, never "0%": unknown
                // headroom and no headroom are opposite facts. A dedicated key
                // rather than reusing `noProject`, whose NAME would then be wrong
                // for the value it renders.
                h('span', { className: 'agy-limit-p' }, fraction === null ? t('valueUnknown') : `${Math.round(fraction * 100)}%`),
                h('span', { className: 'agy-limit-reset' },
                  window.resetTime === null ? null : untilText(window.resetTime, t, now))),
              exhaustsFirst
                ? h('div', { className: 'agy-limit-burn' },
                  t('limitBurnWarn', { value: burnHorizon(hoursLeft!, t) }))
                : null)
          })))))

  const usageBlock = usage === null ? null : card(
    t('usageCumulative'),
    metrics([
      metric(t('kpiInput'), promptTokens(usage.totals), t('kpiInputMissed', {
        tokens: tokenText(usage.totals.input),
      })),
      metric(t('kpiOutput'), usage.totals.output, t('kpiOutputDetail')),
      metric(t('kpiCacheRead'), usage.totals.cacheRead, t('kpiCacheHit', { percent: cacheHitPercent(usage.totals) ?? 0 })),
      metric(t('kpiRequests'), String(usage.totals.requests), t('kpiRequestsDetail', {
        succeeded: usage.totals.succeeded,
        failed: usage.totals.failed,
      })),
    ]),
  )

  // Saving only ever writes a non-empty draft: the empty string is the store's
  // "no proxy" sentinel (`delete account.proxy`), so a Save button that accepted
  // an empty field silently deleted the account's proxy. Clearing is an explicit
  // action with its own button, which is also what makes the destructive path
  // visible instead of sitting behind a placeholder hint.
  const saveProxy = (): void => {
    const value = proxyDraft.trim()
    if (value === '') return
    handlers.onSetProxy(account.index, value)
    setProxyDraft('')
  }

  const proxyBlock = card(t('fieldProxy'), h('div', { className: 'agy-actions' },
    h(Input, {
      value: proxyDraft,
      placeholder: t('proxyPlaceholder'),
      onChange: (event: { target: { value: string } }) => { setProxyDraft(event.target.value) },
    }),
    button(t('actionSave'), saveProxy, { disabled: busy || proxyDraft.trim() === '' }),
    button(t('actionClear'), () => {
      handlers.onSetProxy(account.index, '')
      setProxyDraft('')
    }, { disabled: busy || account.proxy === null }),
    // A probe needs a subject: with an empty box and no stored proxy there is
    // nothing to test, so the button is disabled with the reason on its tooltip
    // rather than clicking through to the host's "no proxy configured" error.
    (() => {
      const noTarget = proxyDraft.trim() === '' && account.proxy === null
      return button(t('actionTestProxy'),
        () => { handlers.onTestProxy(account.index, proxyDraft.trim()) },
        { disabled: busy || noTarget, ...(noTarget ? { title: t('proxyTestNoTarget') } : {}) })
    })()))

  return h('div', { className: 'agy-detail' }, identity, actions, limitsBlock, usageBlock, proxyBlock)
}

/**
 * Whether the row should offer "set as current".
 *
 * A pure rule, exported for a direct unit test. Two cases hide the action:
 * the account is already the pool's preference, or it is DISABLED — `activate`
 * only writes the preference and cannot re-enable, so on a disabled row the
 * button was a no-op the user would read as broken. The repair path for a
 * button was a no-op the user would read as broken. The repair path for a
 * disabled account is `actionVerify`, which stays on the row.
 */
export function canActivateAccount(account: AccountView): boolean {
  return !account.active && account.state !== 'disabled'
}

/**
 * Pick the selected account index: defaults to the active account (badge "current")
 * when present, otherwise falls back to index 0. Clamps to valid bounds.
 */
export function resolveSelectedAccountIndex(
  accounts: readonly AccountView[],
  selected: number | null,
): number {
  if (accounts.length === 0) return 0
  if (selected !== null) {
    if (selected >= 0 && selected < accounts.length) return selected
    const activePos = accounts.findIndex((a) => a.active)
    return activePos >= 0 ? activePos : Math.min(Math.max(selected, 0), accounts.length - 1)
  }
  const activePos = accounts.findIndex((a) => a.active)
  return activePos >= 0 ? activePos : 0
}

function PreferencesCard(props: {
  rpc: AgyRpcClient
  t: T
  onBadgePrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { rpc, t, onBadgePrefChange } = props
  const [badgeEnabled, setBadgeEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void rpc.call('ui.prefs.get', {}).then((prefs) => {
      if (active) {
        setBadgeEnabled(prefs?.conversationBadge === true)
        setLoading(false)
      }
    }).catch(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [rpc])

  const toggleBadge = useCallback(async (checked: boolean) => {
    setSaving(true)
    setBadgeEnabled(checked)
    try {
      const res = await rpc.call('ui.prefs.set', { conversationBadge: checked })
      setBadgeEnabled(res.conversationBadge)
      onBadgePrefChange?.(res.conversationBadge)
    } catch {
      setBadgeEnabled(!checked)
    } finally {
      setSaving(false)
    }
  }, [rpc, onBadgePrefChange])

  return card(t('preferencesTitle'),
    h('div', { className: 'agy-pref-row' },
      h('div', { className: 'agy-pref-info' },
        h('div', { className: 'agy-pref-name' }, t('prefConversationBadge')),
        h('div', { className: 'agy-pref-desc' }, t('prefConversationBadgeDesc'))),
      h(Switch, {
        label: t('prefConversationBadge'),
        checked: badgeEnabled,
        disabled: loading || saving,
        onChange: (checked: boolean) => void toggleBadge(checked),
      })))
}

function AccountsTab(props: {
  accounts: AccountView[]
  busy: boolean
  /** Accounts with upstream requests in flight, from the latest pool.status. */
  busyNow: AgyRpcResult<'pool.status'>['busy']
  /** RPC carrier, for the recent-activity card's own polling. */
  rpc: AgyRpcClient
  handlers: AccountHandlers
  /** UI language for locale-sensitive date formatting ('zh' | 'en'). */
  lang?: string
  t: T
  onBadgePrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { accounts, busy, handlers, t } = props
  const [selected, setSelected] = useState<number | null>(null)
  const selectedRef = useRef<HTMLDivElement | null>(null)
  // One clock reading per render: the row metas' relative "active N ago"
  // fragments must agree with each other (as the detail card's already do).
  const now = Date.now()

  /**
   * The live line: who is serving right now, and how much.
   *
   * Present ONLY while something is in flight — an idle pool renders no strip,
   * so the quiet state stays quiet. The dot is the host `StateDot`'s ongoing
   * state, so the animation is the platform's.
   */
  const liveLine = props.busyNow.length === 0 ? null : (() => {
    const total = props.busyNow.reduce((sum, entry) => sum + entry.count, 0)
    const [first] = props.busyNow
    // The label's subject is computed first, not inline: keeping the params
    // object free of nested braces is also what the placeholder test can see.
    const subject = first === undefined ? '' : first.email ?? `#${first.index}`
    return h('div', { className: 'agy-live' },
      h(StateDot, { state: 'ongoing', size: 8 }),
      h('span', null, props.busyNow.length === 1
        ? t('liveOne', { email: subject, count: total })
        : t('liveMany', { count: total, accounts: props.busyNow.length })))
  })()

  // Clamp by index, not by re-deriving a "selected id": deletion renumbers every
  // row, so an id-based selection would have to be remapped anyway.
  const index = resolveSelectedAccountIndex(accounts, selected)
  const current = accounts[index]

  // Hooks MUST run unconditionally: an early `return` above any hook changes
  // this component's hook count between renders, desyncing React and throwing
  // React error #310 (white-screen).
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [index])

  if (accounts.length === 0) {
    return card(t('colAccount'), h('div', { className: 'agy-empty' }, t('emptyAccounts')))
  }

  // A selectable row: a div with a real button role, so it is reachable and
  // operable from the keyboard. Wrapping the row in a <button> would nest the
  // action buttons inside it — invalid HTML — so the role, tab stop and key
  // handling are declared here instead.
  const rows = accounts.map((account, at) => h('div', {
    key: String(account.index),
    ref: at === index ? selectedRef : undefined,
    className: 'agy-rowitem',
    'data-clickable': 'true',
    'data-selected': at === index,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': at === index,
    onClick: () => { setSelected(at) },
    onKeyDown: (event: { key: string, preventDefault: () => void }) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      // Space would otherwise scroll the settings panel.
      event.preventDefault()
      setSelected(at)
    },
  },
  h('div', { className: 'agy-rowmain' },
    h('div', { className: 'agy-rowtitle' },
      h('span', { className: 'agy-rowname' }, account.email ?? `#${account.index}`),
      account.active ? h(Tag, { tone: 'info' }, t('currentAccount')) : null),
      h('div', { className: 'agy-rowmeta' },
        (account.projectId ?? t('noProject')),
        account.usage === null || account.usage.totals.requests === 0
          ? null
          : ` · ${t('rowRequestsTotal', { n: account.usage.totals.requests })}`,
        // The recency fragment: "is this account still alive" is a scan-level
        // question the all-time count cannot answer. Any source counts — a
        // verify is as much activity as a turn of chat.
        account.usage === null || account.usage.lastUsedAt === null
          ? null
          : ` · ${t('lastActive', { ago: agoText(new Date(account.usage.lastUsedAt).toISOString(), t, now) })}`)),
  h('div', { className: 'agy-rowactions' },
    stateBadge(account.state, account.state === 'cooling'
      ? `${t('coolingUntil')} ${clockTime(account.cooldownUntil, props.lang)}`
      : account.state === 'verification-required'
        // A parked account holds a timed window (its `cooldownUntil`), and its
        // end is the question the reader asks — the mirror of the cooling badge.
        ? t('verificationRetry', { time: clockTime(account.cooldownUntil, props.lang) })
        : stateLabel(account.state, t)),
    canActivateAccount(account) ? button(t('actionActivate'), () => {
      setSelected(at)
      handlers.onActivate(account.index)
    }, { size: 'sm', disabled: busy }) : null,
    button(t('actionVerify'), () => { handlers.onVerify(account.index) }, { size: 'sm', disabled: busy }))))

  return h('div', { className: 'agy-root' },
    // The container-query wrapper the `.agy-split` breakpoint measures; see
    // styles.ts for why this is a container query rather than a viewport one.
    h('div', { className: 'agy-split-wrap' },
      h('div', { className: 'agy-split' },
        card(t('colAccount'),
          h('div', null,
            liveLine,
            h('div', { className: 'agy-rows' }, ...rows)),
          `${accounts.length}`),
        // `key` remounts the detail per account so its proxy draft cannot carry
        // over: without it React reuses the instance and a draft typed for one
        // account was still in the box after selecting another, one Save away
        // from writing A's proxy to B.
        //
        // `onDelete` is wrapped here, not in the shared handlers object: the
        // row-level delete used to clear the selection before acting (deletion
        // renumbers every index), and that selection state lives in THIS
        // component. Deleting from the detail's action card must behave the same.
        current === undefined
          ? null
          : h(AccountDetail, {
            key: String(current.index),
            account: current,
            busy,
            handlers: {
              ...handlers,
              onDelete: (index: number) => {
                setSelected(null)
                handlers.onDelete(index)
              },
            },
            lang: props.lang,
            t,
          })),
    // The "what just happened" list, under the split: it is pool-level
    // activity, not one account's, and the split owns the full height.
    h(RecentCard, { rpc: props.rpc, t }),
    h(PreferencesCard, { rpc: props.rpc, t, onBadgePrefChange: props.onBadgePrefChange })))
}

/**
 * Models tab: per-model visibility switches, plus the account's model quota in a
 * collapsible block.
 *
 * Quota lives here rather than in the account list because both answer the same
 * question — "which models can I use, and how much is left" — and the quota list
 * is long (20+ rows), so it must not push the account list off screen. The
 * disclosure keeps it one click away without spending the space by default.
 */
/**
 * Order models for display: enabled first, disabled sunk to the bottom.
 *
 * Exported for a direct unit test — the rule is pure and worth pinning, and the
 * client test harness does not render. Stable by construction: `Array.sort` is
 * stable per spec, so the host's own order survives inside each group. That is
 * what makes a toggle move exactly one row instead of reshuffling the list.
 * @param models - the host's list, in host order.
 * @returns a new array, enabled models first.
 */
export function orderModels(models: readonly ModelView[]): ModelView[] {
  return [...models].sort((a, b) => Number(a.disabled) - Number(b.disabled))
}

function ModelsTab(props: {
  models: ModelView[]
  account: string | null
  /** Model ids whose own toggle write is in flight; everything else stays live. */
  pending: ReadonlySet<string>
  /** Model ids whose own test call is in flight (see the per-row test button). */
  testing: ReadonlySet<string>
  onToggle: (modelId: string, disabled: boolean) => void
  /** Fire one test call against this exact model on the active account. */
  onTestModel: (modelId: string) => void
  /** RPC carrier for the thinking-budget block, which loads its own state. */
  rpc: AgyRpcClient
  t: T
}): ReactNode {
  const { models, account, pending, testing, onToggle, onTestModel, rpc, t } = props

  // Hooks MUST run unconditionally: an early `return` above any hook changes
  // this component's hook count between renders, and React's renderer state —
  // keyed by call order — desyncs and throws mid-render. The exception unmounts
  // the whole Settings tree: a white panel that no tab click can revive, only a
  // restart. This fired whenever `models.length` crossed the 0/non-0 boundary
  // between two renders (startup loads models async; a refresh that loses the
  // account empties it), which is why it looked like a random crash.
  const ordered = useMemo(() => orderModels(models), [models])

  if (models.length === 0) {
    return card(t('modelsTitle'), h('div', { className: 'agy-empty' }, t('emptyModels')))
  }
  const hidden = models.filter((model) => model.disabled).length

  // One normal row per model. A row is a plain grid, not a table: the switch is
  // the affordance and a table's column rules would fight the card's rhythm.
  // Each row carries its own test button: "does THIS model work" is the same
  // decision the visibility switch answers, so the two live side by side. The
  // old dashboard also had a "test all models" loop; deliberately not restored —
  // it fired one billed upstream call per model, serially, behind one confirm.
  const rows = ordered.map((model) => h('div', { className: 'agy-rowitem', key: model.id },
    h('div', { className: 'agy-rowmain' },
      h('div', { className: 'agy-rowtitle' },
        h('span', { className: 'agy-rowname' }, model.name)),
      model.name === model.id
        ? null
        : h('div', { className: 'agy-rowmeta agy-mono' }, model.id)),
    h('div', { className: 'agy-rowactions' },
      // The host `Button` at `ghost`, not a local class: this is a quiet action
      // (one per row of a long list, so a filled capsule would read as many
      // competing primary actions), and `ghost` is the host's own variant for
      // exactly that weight. Styling it locally meant our own colors, radius and
      // focus ring, which is how this row ended up looking unlike every other
      // button in the panel.
      button(testing.has(model.id) ? t('modelTesting') : t('actionTestModel'),
        () => { onTestModel(model.id) },
        { size: 'sm', variant: 'ghost', disabled: testing.has(model.id) }),
      h(Switch, {
        checked: !model.disabled,
        // Only THIS switch locks while its own write is in flight. The previous
        // global `busy` disabled every control on the page for the duration of
        // two network round trips, which is what made one toggle feel like the
        // whole panel froze.
        disabled: pending.has(model.id),
        label: t('modelToggleAria', { name: model.name }),
        onChange: () => { onToggle(model.id, !model.disabled) },
      }))))

  return h('div', { className: 'agy-root' },
    card(t('modelsTitle'), h('div', { className: 'agy-rows' }, ...rows),
      hidden > 0 ? t('modelsHiddenSuffix', { count: hidden }) : account ?? undefined),
    hint(t('modelsHelp')),
    h(ThinkingBudgetCard, { rpc, t }))
}

/**
 * The global reasoning-level token budgets.
 *
 * One row per level rather than per model: only `*-tiered` models send a
 * `thinkingConfig` at all, and the level itself is already chosen in DSH's model
 * selector. So this supplies the missing VALUE behind each level — the same three
 * numbers for every such model.
 *
 * An EMPTY input is the meaningful default: the request then sends
 * `thinkingLevel` and lets upstream pick, which is exactly the behaviour before
 * this setting existed. That is why the field is not a `number` input with a
 * zero fallback, and why clearing it is a real action rather than "set to 0"
 * (measured: `0` reduces thinking but does not reliably disable it).
 */
/**
 * One budget row: label, input, and optional shortcut chips.
 *
 * There is deliberately NO trailing text column. An earlier version put the wire
 * form there ("sends thinkingLevel: high"), which was wrong twice over: on the
 * "High" row it restated that row's own label, and `thinkingLevel` /
 * `thinkingBudget` are identifiers for us rather than words a user needs. The
 * input plus its label carry all the information the row has.
 *
 * `chips` are shortcuts, not a second control: they only fill the input, and the
 * empty one is the meaningful default (upstream allocates).
 */
function thinkingRow(
  id: string,
  label: string,
  value: string,
  t: T,
  handlers: {
    onInput: (value: string) => void
    onCommit: (value: string) => void
    chips?: Array<{ label: string, value: string }>
  },
): ReactNode {
  return h('div', { className: 'agy-thinking-row', key: id },
    h('span', { className: 'agy-thinking-k' }, label),
    h(Input, {
      value,
      // The placeholder states what EMPTY does, not a number: a grey `1000`
      // would read as "leaving this blank gives you 1000", the opposite of the
      // real behaviour.
      placeholder: t('thinkingAuto'),
      inputMode: 'numeric',
      onChange: (event: { target: { value: string } }) => { handlers.onInput(event.target.value) },
      onBlur: (event: { target: { value: string } }) => { handlers.onCommit(event.target.value) },
    }),
    handlers.chips === undefined
      ? null
      : h('span', { className: 'agy-thinking-chips' }, ...handlers.chips.map((chip) =>
        h('button', {
          key: chip.label,
          type: 'button',
          className: 'agy-thinking-chip',
          // Clicking fills the field and commits in one step; the blur handler
          // then sees an unchanged value and does not save twice.
          onClick: () => { handlers.onInput(chip.value); handlers.onCommit(chip.value) },
        }, chip.label))))
}

/**
 * Measured thinking-token samples, one row per effort THE PICKER ACTUALLY OFFERS.
 *
 * The rows are exactly the picker's entries — Default, Low, Medium, High — and
 * nothing else. `Max` is deliberately absent: it was a chip that filled the input
 * with the maximum, and measurement showed it buys nothing. At the model's real
 * ceiling (65536) `high` reaches ~63k, i.e. 96% of it, so there is no higher
 * ceiling for a bigger number to unlock.
 *
 * WHY A TABLE AND NOT A SENTENCE. These numbers only mean anything compared
 * DOWN a column: `High` spends ~165 tokens on `17*23` and ~63,000 on a hard
 * derivation. A sentence listing both is unreadable, and a single number per tier
 * reads as a fixed value when the real behaviour is a range.
 *
 * MEASUREMENT TRAP, recorded because it wasted a full investigation: thinking and
 * output SHARE `maxOutputTokens` (measured exactly — cap 2048 gave 1962 thoughts
 * + 82 output = 2044). A harness that pins the cap below the thinking demand
 * measures its own pin. Six runs at cap 60000 all reported ~24k regardless of
 * level and looked like "the tiers are equivalent"; at cap 65536 they separate.
 * The hard column below was re-measured at the ceiling. `pnpm run
 * verify:thinking-levels` re-derives all of it.
 *
 * A `0` is a MEASURED ZERO, not a placeholder: on the medium prompt `Low`
 * returned no `thoughtsTokenCount` field at all, and `total - output` equalled
 * the prompt size in all 5 runs — upstream really spent no thinking tokens. It is
 * printed as `0` rather than `-` so the row does not look like missing data.
 *
 * Every value is the mean of 2-11 live samples, rounded. `Default`'s hard cell
 * carried only 2 samples (34k and 57k, 51% apart) until four more were taken:
 * 6 samples now give ~48,700 at sd ~8,800. The spread is why these are labelled
 * samples and not a specification.
 */
const THINKING_SAMPLES: ReadonlyArray<{
  level: string
  easy: number | null
  medium: number | null
  hard: number | null
}> = [
  { level: 'Default', easy: 135, medium: 1_100, hard: 48_700 },
  // 0, not "unreported": total - output equalled the prompt size in all 5 runs,
  // i.e. upstream really spent no thinking tokens on this combination.
  { level: 'Low', easy: 50, medium: 0, hard: 9_000 },
  { level: 'Medium', easy: 150, medium: 870, hard: 60_400 },
  { level: 'High', easy: 165, medium: 1_855, hard: 63_400 },
  // Independent, NOT nested under High: the same value typed into ANY row sends
  // the same request (a filled budget replaces the level token), so there is no
  // structural relationship to High — only a numerical resemblance on the hard
  // question. Users ask about this value by name, so it belongs in the grid.
  { level: 'max', easy: 185, medium: 2_130, hard: 62_900 },
]

/**
 * Collapsible table of measured thinking tokens.
 *
 * MUST be rendered as a component (`h(ThinkingSamples, { t })`), never CALLED as
 * `ThinkingSamples({ t })` or as a lowercase helper. This function owns a
 * `useState`, and React keys renderer state by hook call order: a direct call
 * inside the parent's conditional branch appends this hook to the PARENT's
 * sequence, so the parent's hook count changes the moment the section expands and
 * React throws mid-render. The exception unmounts the whole Settings tree — a
 * white panel no click can revive, only a restart.
 *
 * This is the second occurrence of that class of bug in this file (`ModelsTab`
 * ran a `useMemo` after an early return, white-screening on tab switch). Both
 * passed `tsc`, the 442 unit tests and CI, because the test environment is
 * `environment: 'node'` and renders nothing — nothing static checks hook order.
 */
function ThinkingSamples({ t }: { t: T }): ReactNode {
  const [show, setShow] = useState(false)
  // A true zero is printed as `0`, not `~0`: the tilde marks a rounded sample,
  // and it would make a measured absence of thinking look like an estimate.
  const cell = (value: number | null): ReactNode =>
    h('td', { className: 'agy-num' }, value === null ? '-' : value === 0 ? '0' : `~${value.toLocaleString()}`)
  return h('div', { className: 'agy-disclosure', 'data-open': show },
    h('button', {
      type: 'button',
      className: 'agy-disclosure-toggle',
      'aria-expanded': show,
      onClick: () => { setShow(!show) },
    },
    h('span', { className: 'agy-caret' }),
    h('span', null, t('thinkingSamplesTitle'))),
    show
      ? h('div', { className: 'agy-disclosure-body' },
        h('p', { className: 'agy-hint' }, t('thinkingSamplesIntro')),
        h('p', { className: 'agy-hint' }, t('thinkingSamplesCaption')),
        h('div', { className: 'agy-table-wrap' },
          table(h('tr', null,
            h('th', null, t('thinkingSamplesLevel')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesEasy')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesMedium')),
            h('th', { className: 'agy-num' }, t('thinkingSamplesHard'))),
          THINKING_SAMPLES.map((row) => h('tr', { key: row.level },
            // The nested row is indented so it reads as High's configuration.
            h('td', { className: 'agy-strong' },
              row.level === 'max' ? t('thinkingSamplesMaxRow') : row.level),
            cell(row.easy), cell(row.medium), cell(row.hard))))),
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesComparison')),
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesSources')),
        // The `0` is real and reproducible, but a reader could mistake it for a
        // broken cell, so it is called out explicitly.
        h('p', { className: 'agy-hint agy-table-note' }, t('thinkingSamplesZero')))
      : null)
}

function ThinkingBudgetCard(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  const [budgets, setBudgets] = useState<ThinkingBudgets>({})
  const [tieredBudget, setTieredBudget] = useState<number | null>(null)
  const [claudeBudget, setClaudeBudget] = useState<number | null>(null)
  const [claudeDraft, setClaudeDraft] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loaded, setLoaded] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback((): void => {
    void (async () => {
      try {
        const result = await rpc.call('thinking.get', {})
        if (!alive.current) return
        setBudgets(result.budgets)
        setTieredBudget(result.tieredBudget)
        setDrafts((c) => ({ ...c, tiered: result.tieredBudget === null ? '' : String(result.tieredBudget) }))
        setClaudeBudget(result.claudeBudget)
        setClaudeDraft(result.claudeBudget === null ? '' : String(result.claudeBudget))
        // Drafts mirror the stored values as strings, so an in-progress edit is
        // never clobbered by a reload and an empty box stays empty.
        setDrafts(Object.fromEntries(
          THINKING_LEVELS.map((level) => [level, result.budgets[level] === undefined ? '' : String(result.budgets[level])]),
        ))
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (alive.current) setLoaded(true)
      }
    })()
  }, [rpc])

  // Loaded on first open, not on mount: the Models tab renders on every visit to
  // the panel, and this is a settings read nobody needs until the block is shown.
  useEffect(() => {
    if (open && !loaded) load()
  }, [open, loaded, load])

  const save = (level: string, raw: string): void => {
    const trimmed = raw.trim()
    // An empty box means "no budget for this level", which the host clears.
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.set', { level, budget: value })
        if (!alive.current) return
        setBudgets(result.budgets)
        setError(undefined)
      } catch (caught) {
        // The host rejects an out-of-range value with the exact interval, so its
        // message is more useful than a generic one.
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const saveTiered = (raw: string): void => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.setTiered', { budget: value })
        if (!alive.current) return
        setTieredBudget(result.tieredBudget)
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const saveClaude = (raw: string): void => {
    const trimmed = raw.trim()
    const value = trimmed === '' ? null : Number(trimmed)
    if (value !== null && !Number.isInteger(value)) {
      setError(t('thinkingInvalid'))
      return
    }
    void (async () => {
      try {
        const result = await rpc.call('thinking.setClaude', { budget: value })
        if (!alive.current) return
        setClaudeBudget(result.claudeBudget)
        setError(undefined)
      } catch (caught) {
        if (!alive.current) return
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
  }

  const configured = THINKING_LEVELS.filter((level) => budgets[level] !== undefined).length
    + (tieredBudget === null ? 0 : 1)
  const block = h('div', { className: 'agy-disclosure', 'data-open': open },
    h('button', {
      type: 'button',
      className: 'agy-disclosure-toggle',
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
    h('span', { className: 'agy-caret' }),
    h('span', null, t('thinkingTitle')),
    h('span', { className: 'agy-disclosure-meta' },
      configured === 0 ? t('thinkingDefaultAll') : t('thinkingConfigured', { count: configured }))),
    open
      ? h('div', { className: 'agy-disclosure-body' },
        error === undefined ? null : h('div', { className: 'agy-error' }, error),

        // ── Gemini (tiered) ────────────────────────────────────────────────
        h('div', { className: 'agy-thinking-group' },
          h('div', { className: 'agy-thinking-group-name' }, t('thinkingGeminiGroup')),
          h('p', { className: 'agy-hint' }, t('thinkingGeminiHint')),
          h('ul', { className: 'agy-thinking-notes agy-thinking-effects' },
            h('li', null, t('thinkingEffectLowUp')),
            h('li', null, t('thinkingEffectHighDown')),
            h('li', null, t('thinkingEffectMax')),
            h('li', null, t('thinkingEffectReset'))),
          // The selector's "Default" effort carries no level id, so it is its own
          // row rather than one of the three. Empty = upstream allocates; a value
          // = Max, a bare cap with no level sent alongside it.
          thinkingRow('tiered', t('thinkingTieredLabel'), drafts.tiered ?? '', t, {
            onInput: (value) => { setDrafts((c) => ({ ...c, tiered: value })) },
            onCommit: (value) => {
              const stored = tieredBudget === null ? '' : String(tieredBudget)
              if (value.trim() !== stored) saveTiered(value)
            },
            chips: [{ label: t('thinkingChipClear'), value: '' }],
          }),
          ...THINKING_LEVELS.map((level) => thinkingRow(level, levelLabel(level, t), drafts[level] ?? '', t, {
            onInput: (value) => { setDrafts((c) => ({ ...c, [level]: value })) },
            onCommit: (value) => {
              const stored = budgets[level] === undefined ? '' : String(budgets[level])
              if (value.trim() !== stored) save(level, value)
            },
          })),
          h(ThinkingSamples, { t })),

        // ── Claude ─────────────────────────────────────────────────────────
        h('div', { className: 'agy-thinking-group' },
          h('div', { className: 'agy-thinking-group-name' }, t('thinkingClaudeGroup')),
          // Three bullets rather than one sentence: Claude differs from Gemini on
          // three independent axes, and the last one is why no reference table is
          // offered here — upstream never reports Claude's thinking tokens, so
          // there is nothing to sample.
          h('ul', { className: 'agy-thinking-notes' },
            h('li', null, t('thinkingClaudeNoLevels', { min: CLAUDE_BUDGET_MIN, max: CLAUDE_BUDGET_MAX })),
            h('li', null, t('thinkingClaudeMaxTokens')),
            h('li', null, t('thinkingClaudeNoReport'))),
          thinkingRow('claude', t('thinkingClaudeLabel'), claudeDraft, t, {
            onInput: (value) => { setClaudeDraft(value) },
            onCommit: (value) => {
              const stored = claudeBudget === null ? '' : String(claudeBudget)
              if (value.trim() !== stored) saveClaude(value)
            },
            chips: [{ label: t('thinkingChipClear'), value: '' }],
          })))
      : null)

  return card(t('thinkingTitle'), block)
}

// ─── Recent activity ─────────────────────────────────────────────────────────

/** Result vocabulary for one recent row; rotation events are their own kind. */
function recentResultKind(entry: RecentEntry): 'ok' | 'fail' | 'limited' | 'rotation' {
  if (entry.kind === 'rotation') return 'rotation'
  if (entry.rateLimited) return 'limited'
  if (!entry.ok) return 'fail'
  return 'ok'
}

/**
 * Localized label for a failure-classification token, falling back to the raw
 * token so a classification added upstream still reads as something.
 */
function failureReasonLabel(reason: string, t: T): string {
  switch (reason) {
    case 'rate-limit': return t('colRateLimited')
    case 'network-error': return t('cooldownReasonNetworkError')
    case 'auth-failure': return t('disabledCredentials')
    case 'verification-required': return t('cooldownReasonValidationRequired')
    case 'quota-exhausted': return t('cooldownReasonQuotaExhausted')
    case 'project-error': return t('cooldownReasonProjectError')
    default: return reason
  }
}

/**
 * The result cell's text. Rotation rows say WHY (`reason` rides the record
 * since the ring captures the classification); a failed request with a
 * non-rate-limit classification also names it — the rate-limit case is already
 * the whole RateLimited label, and doubling it reads as a stutter.
 */
function recentResultText(entry: RecentEntry, t: T): string {
  const kind = recentResultKind(entry)
  if (kind === 'rotation') {
    return entry.reason === null
      ? t('colRotations')
      : `${t('colRotations')} · ${failureReasonLabel(entry.reason, t)}`
  }
  if (kind === 'limited') return t('colRateLimited')
  if (kind === 'fail') {
    return entry.reason === null || entry.reason === 'rate-limit'
      ? t('colFailed')
      : `${t('colFailed')} · ${failureReasonLabel(entry.reason, t)}`
  }
  return t('recentOk')
}

/**
 * The "what just happened" list: the most recent records this process saw,
 * newest first, collapsed by default and polled while open.
 *
 * A component (never called directly) — it owns hooks; see ThinkingSamples for
 * the hook-order rule this file has been bitten by twice. The poll is the same
 * 3s cadence as the live line and reads the host's memory ring, so an open
 * list costs nothing upstream.
 */
function RecentCard(props: { rpc: AgyRpcClient, t: T }): ReactNode {
  const { rpc, t } = props
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<RecentEntry[] | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback((): void => {
    void rpc.call('pool.recent', {}).then((result) => {
      if (alive.current) {
        setRecent(result.recent)
        setError(undefined)
      }
    }).catch((caught: unknown) => {
      if (alive.current) setError(caught instanceof Error ? caught.message : String(caught))
    })
  }, [rpc])

  // Loaded on first open (nobody needs it before that), then refreshed on the
  // poll cadence while open. A closed list never fires.
  useEffect(() => { if (open && recent === null) load() }, [open, recent, load])
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => { if (!document.hidden) load() }, POOL_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [open, load])

  const now = Date.now()

  return h('div', { className: 'agy-disclosure agy-recent', 'data-open': open },
    h('button', {
      type: 'button',
      className: 'agy-disclosure-toggle',
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
    h('span', { className: 'agy-caret' }),
    h('span', null, t('recentTitle')),
    recent === null ? null : h('span', { className: 'agy-disclosure-meta' }, String(recent.length))),
    open === false ? null : h('div', { className: 'agy-disclosure-body' },
      error === undefined ? null : h('div', { className: 'agy-error' }, error),
      recent === null
        ? h('div', { className: 'agy-empty' }, t('loading'))
        : recent.length === 0
          ? h('div', { className: 'agy-empty' }, t('recentEmpty'))
          : h('div', { className: 'agy-table-wrap' },
            table(
              // Every column carries an explicit width: a fixed-layout table
              // with an auto column starved it to a sliver, and the identity
              // truncation below bounds content so the widths hold.
              h('tr', null,
                h('th', { style: { width: '64px' } }, t('colTime')),
                h('th', { style: { width: '30%' } }, t('colAccount')),
                h('th', { style: { width: '24%' } }, t('colModel')),
                h('th', { style: { width: '96px' } }, t('colResult')),
                h('th', { style: { width: '56px' } }, t('colDuration')),
                h('th', { style: { width: '48px' } }, t('colOutput'))),
              recent.map((entry, index) => h('tr', { key: `${entry.at}-${index}` },
                h('td', null, recentAgo(entry.at, now, t)),
                h('td', null, h('span', {
                  className: 'agy-mail',
                  title: entry.account ?? undefined,
                }, entry.account === null ? '—' : truncateIdentity(entry.account))),
                h('td', null, h('span', {
                  className: 'agy-mail',
                  title: entry.model ?? undefined,
                }, entry.model === null ? '—' : truncateIdentity(entry.model))),
                h('td', null, h('span', { className: 'agy-recent-state', 'data-kind': recentResultKind(entry) }, recentResultText(entry, t))),
                h('td', null, entry.latencyMs === null ? '—' : formatDuration(entry.latencyMs)),
                h('td', { className: 'agy-num' }, entry.output === null ? '—' : tokenText(entry.output))))))))
}

// ─── Usage tab ───────────────────────────────────────────────────────────────

type RangeId = 'today' | 'week' | 'month' | 'all'

const RANGE_IDS: readonly RangeId[] = ['today', 'week', 'month', 'all']

/** Localized label for one range chip. */
function rangeLabel(id: RangeId, t: T): string {
  switch (id) {
    case 'today': return t('rangeToday')
    case 'week': return t('rangeWeek')
    case 'month': return t('rangeMonth')
    case 'all': return t('rangeAll')
  }
}

/**
 * Fixed widths for the numeric columns, shared by BOTH breakdown tables.
 *
 * They must be identical across the two tables. `table-layout: fixed` gives the
 * auto-width first column whatever is left, so two different width sums put the
 * numeric columns of the two tables at different x positions — the by-account
 * table's numbers sat 48px right of the by-model table's, which is what made a
 * long account row look like it was shoving the figures sideways. Sharing one
 * vector keeps every numeric column vertically aligned down the page.
 *
 * Last entry is wider because it carries the share bar (by model) as well as a
 * plain count (by account, "rotations").
 */
const NUM_COL_WIDTHS = ['48px', '56px', '56px', '56px', '64px'] as const

/** One right-aligned numeric header cell at column position `index`. */
function numHeader(index: number, label: string): ReactNode {
  return h('th', { className: 'agy-num', style: { width: NUM_COL_WIDTHS[index] } }, label)
}

/**
 * The Token composition bar rows: cache hits, input misses, output.
 *
 * A plain-prefix cache makes the cached share dominate (it re-reads the whole
 * prefix every turn), which is correct but reads as impossible without a
 * breakdown — hence this bar, which shows the proportion rather than restating
 * the numbers.
 *
 * The three rows must stay a PARTITION of `totalTokens` (they sum to 100%), so
 * the prompt side is split rather than labelled: `kpiCacheRead` (the hit count)
 * and `kpiInputMissed` (the rest). Using `kpiInput` for a row here would
 * double-count every cached token, because the headline input figure is now the
 * WHOLE prompt side — which already contains the hits. The split is what keeps
 * the bar honest and still adds up.
 *
 * `labelKey` and `id` are SEPARATE fields on purpose. A single `key` field used
 * for both the i18n lookup and React's `key` prop is how the label position ended
 * up rendering the raw dictionary key (`kpiCacheRead`) to every user: the value
 * served React correctly, so nothing failed, and the same variable was then
 * handed to the label span. Two names make that mix-up impossible.
 */
function tokenComposition(counters: UsageCounters, t: T): ReactNode {
  const total = totalTokens(counters)
  const rows: Array<{ id: string, labelKey: AgyLocaleKey, value: number, tone: string }> = [
    { id: 'cacheRead', labelKey: 'kpiCacheRead', value: counters.cacheRead, tone: 'var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6)' },
    { id: 'missed', labelKey: 'kpiInputMissedLabel', value: counters.input, tone: 'var(--dsw-static-neutral-bluish-700, #8b8f96)' },
    { id: 'output', labelKey: 'kpiOutput', value: counters.output, tone: 'var(--dsw-alias-state-success-primary, #22c55e)' },
  ]
  return h('div', { className: 'agy-compose' }, ...rows.map((row) => {
    const share = total > 0 ? (row.value / total) * 100 : 0
    return h('div', { className: 'agy-compose-row', key: row.id },
      h('span', { className: 'agy-compose-k' }, t(row.labelKey)),
      h('span', { className: 'agy-compose-track' },
        h('i', { style: { width: `${Math.max(share, row.value > 0 ? 1 : 0)}%`, background: row.tone } })),
      h('span', { className: 'agy-compose-v' }, tokenText(row.value)),
      h('span', { className: 'agy-compose-p' }, `${share.toFixed(1)}%`))
  }))
}

function UsageTab(props: { stats: StatsView | null, lang?: string, t: T }): ReactNode {
  const { t } = props
  const [range, setRange] = useState<RangeId>('today')
  const stats = props.stats
  if (stats === null) return h('div', { className: 'agy-empty' }, t('loading'))
  if (stats.all.counters.requests === 0) {
    return card(t('usageTitle'), h('div', { className: 'agy-empty' }, t('emptyUsage')))
  }

  // ONE selection drives the whole page: the headline strip AND both breakdown
  // tables read the same range. Previously the tables read all-time maps, so
  // "Today" showed 30 requests above a 164-request row.
  const view = range === 'today'
    ? stats.today
    : range === 'week'
      ? stats.week
      : range === 'month' ? stats.month : stats.all
  const counters = view.counters
  const hit = cacheHitPercent(counters)
  const total = totalTokens(counters)

  // The primitives catalog names `Pill` for view switchers and filters: it owns
  // the active/inactive fill pair, so no local chip skin is needed.
  const rangePicker = h('div', { className: 'agy-toolbar' },
    h('div', { className: 'agy-chips' }, ...RANGE_IDS.map((id) => h(Pill, {
      key: id,
      active: range === id,
      onClick: () => { setRange(id) },
    }, rangeLabel(id, t)))),
    h('span', { className: 'agy-grow' }),
    stats.since === null
      ? null
      : h('span', { className: 'agy-aside' }, t('since', { date: new Date(stats.since).toLocaleDateString(props.lang) })))

  /**
   * The headline: total Token FIRST, then the three buckets that add up to it.
   *
   * The anchor is what makes the rest readable. Without it a reader sees "cache
   * read 25.8M" beside "input 11.1M" and has no way to know both are parts of
   * one quantity — and a cache read LARGER than the input looks like a bug
   * rather than the expected shape of a prefix cache. With the total stated, the
   * three figures are visibly a partition (their sum is checked by eye).
   */
  const summary = card(t('usageTitle'), h('div', null,
    metrics([
      metric(t('kpiTotalTokens'), total, t('kpiTotalDetail', {
        requests: counters.requests,
        failed: counters.failed,
      })),
      // The prompt side, whole. Its detail line states the MISSED portion, which
      // is the complement of the cache line beside it — so the two figures
      // answer "how much was cached" at a glance without either being a subset
      // the reader has to subtract for.
      metric(t('kpiInput'), promptTokens(counters),
        t('kpiInputMissed', { tokens: tokenText(counters.input) })),
      metric(t('kpiCacheRead'), counters.cacheRead,
        hit === null ? t('kpiNoBilledInput') : t('kpiCacheHit', { percent: hit })),
      metric(t('kpiOutput'), counters.output, t('kpiOutputDetail')),
    ]),
    tokenComposition(counters, t)))

  const timing = card(t('fieldLatency'), defs([
    [t('fieldCacheWrite'), tokenText(counters.cacheWrite)],
    [t('fieldRateLimitRotation'), `${counters.rateLimited} / ${counters.rotations}`],
    [t('labelLatencyAverage'), formatDuration(average(counters.latencyMs, counters.latencyN))],
    [t('labelTtft'), formatDuration(average(counters.ttftMs, counters.ttftN))],
  ]))

  // The per-day trend, independent of the range picker: it answers "is this
  // pool degrading over time", a question the range-folded tables above cannot
  // show. Fixed 7-day window, zeros filled (see StatsView.days).
  const trend = card(t('trendTitle'),
    h('div', { className: 'agy-table-wrap' },
      table(
        h('tr', null,
          h('th', null, t('colDay')),
          numHeader(0, t('colRequests')),
          numHeader(1, t('colFailed')),
          numHeader(2, t('colRateLimited')),
          numHeader(3, t('colRotations'))),
        stats.days.map((row) => h('tr', { key: row.day },
          h('td', null, dayLabel(row.day, props.lang)),
          h('td', { className: 'agy-num' }, String(row.requests)),
          h('td', { className: 'agy-num' }, String(row.failed)),
          h('td', { className: 'agy-num' }, String(row.rateLimited)),
          h('td', { className: 'agy-num' }, String(row.rotations)))))))

  // Column headers state the semantics directly, so no footnote is needed: the
  // prompt side is one column (all of it, cached included) and the cache line
  // beside it is the HIT count — a subset, which is why nobody adds the two up.
  // The old pair (an uncached-only input column plus a disjoint cache column)
  // required a sentence of prose to explain and still read as though the cache
  // read had gone missing from the input.
  const byModel = view.models.length === 0 ? null : card(
    t('byModel'),
    h('div', { className: 'agy-table-wrap' },
      table(
        h('tr', null,
          h('th', null, t('colModel')),
          numHeader(0, t('colRequests')),
          numHeader(1, t('kpiInput')),
          numHeader(2, t('kpiCacheRead')),
          numHeader(3, t('colOutput')),
          numHeader(4, t('colTokenShare'))),
        view.models.map((row) => h('tr', { key: row.model },
          h('td', { className: 'agy-strong' }, h('span', { className: 'agy-mail' }, row.model)),
          h('td', { className: 'agy-num' }, String(row.counters.requests)),
          h('td', { className: 'agy-num' }, tokenText(promptTokens(row.counters))),
          h('td', { className: 'agy-num' }, tokenText(row.counters.cacheRead)),
          h('td', { className: 'agy-num' }, tokenText(row.counters.output)),
          // Token share, not request share: every neighbouring column is tokens,
          // and the old bar silently measured requests under a "share" header, so
          // the heaviest-REQUEST row led even when it moved few tokens.
          h('td', { className: 'agy-num' },
            h('span', { className: 'agy-bar' },
              h('span', { className: 'agy-track' },
                h('i', {
                  style: {
                    width: `${Math.round((totalTokens(row.counters) / Math.max(1, total)) * 100)}%`,
                  },
                })))))))))

  const byAccount = view.accounts.length === 0 ? null : card(t('byAccount'),
    h('div', { className: 'agy-table-wrap' },
      table(h('tr', null,
        h('th', null, t('colAccount')),
        numHeader(0, t('colRequests')),
        numHeader(1, t('colToken')),
        numHeader(2, t('colFailed')),
        numHeader(3, t('colRateLimited')),
        numHeader(4, t('colRotations'))),
      view.accounts.map((row) => h('tr', { key: row.account },
        h('td', { className: 'agy-strong' }, h('span', { className: 'agy-mail' }, row.account)),
        h('td', { className: 'agy-num' }, String(row.counters.requests)),
        h('td', { className: 'agy-num' }, tokenText(totalTokens(row.counters))),
        h('td', { className: 'agy-num' }, String(row.counters.failed)),
        h('td', { className: 'agy-num' }, String(row.counters.rateLimited)),
        h('td', { className: 'agy-num' }, String(row.counters.rotations))))),
    ),
  )

  return h('div', { className: 'agy-root' },
    rangePicker, summary, timing, trend, byModel, byAccount)
}

// ─── Credentials tab ─────────────────────────────────────────────────────────

function CredentialsTab(props: {
  busy: boolean
  onImport: (kind: 'json' | 'blob', sources: string[]) => void
  onExportAll: () => void
  t: T
}): ReactNode {
  const { t } = props
  const [text, setText] = useState('')
  const sources = useMemo(
    () => text.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
    [text],
  )
  const suffix = sources.length > 1 ? ` (${sources.length})` : ''
  return h('div', { className: 'agy-root' },
    subhead(t('importTitle')),
    hint(t('importHelp')),
    h('textarea', {
      className: 'agy-textarea',
      style: { marginTop: '8px' },
      value: text,
      placeholder: t('importPlaceholder'),
      onChange: (event: { target: { value: string } }) => { setText(event.target.value) },
    }),
    h('div', { className: 'agy-toolbar', style: { marginTop: '8px' } },
      // Both labels go through the dictionary: hardcoded Chinese showed up in
      // the English UI and bypassed the zh/en parity check.
      button(`${t('importJson')}${suffix}`, () => { props.onImport('json', sources) },
        { disabled: props.busy || sources.length === 0 }),
      button(`${t('importBlob')}${suffix}`, () => { props.onImport('blob', sources) },
        { disabled: props.busy || sources.length === 0 }),
      h('span', { className: 'agy-grow' }),
      button(t('exportAll'), () => { props.onExportAll() }, { disabled: props.busy })))
}

// ─── root ────────────────────────────────────────────────────────────────────

/** The Settings section body. */
export function AgySettings(props: {
  rpc: AgyRpcClient
  t: T
  lang?: string
  onBadgePrefChange?: (enabled: boolean) => void
}): ReactNode {
  const { rpc, t } = props
  useEffect(() => {
    installAgyStyles()
  }, [])
  const [tab, setTab] = useState<TabId>('accounts')
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [models, setModels] = useState<ModelView[]>([])
  const [modelAccount, setModelAccount] = useState<string | null>(null)
  /** Model-discovery failure, shown on the Models tab only (see loadModels). */
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  /** Model ids whose own visibility write is in flight (see the toggle handler). */
  const [toggling, setToggling] = useState<ReadonlySet<string>>(() => new Set())
  /** Model ids whose own test call is in flight (see the per-row test button). */
  const [modelTesting, setModelTesting] = useState<ReadonlySet<string>>(() => new Set())
  const [stats, setStats] = useState<StatsView | null>(null)
  /**
   * Accounts with upstream requests in flight, from the polled `pool.status`.
   *
   * A poll, not a push: the section has no push channel, and the call is a pure
   * in-memory read on the host. A failed poll is display-only and stays silent —
   * the previous frame (including "idle") holds until the next tick, which is
   * the honest degradation for a status line.
   */
  const [poolBusy, setPoolBusy] = useState<AgyRpcResult<'pool.status'>['busy']>([])
  const [error, setError] = useState<string | undefined>(undefined)
  /** A non-fatal outcome worth reporting (e.g. a partial credential import). */
  const [notice, setNoticeState] = useState<string | undefined>(undefined)
  /**
   * The outcome of a one-shot action, timed like `notice`.
   *
   * A SEPARATE channel from `error` on purpose. `error` is also where a failed
   * `refresh()` lands, and "the account list could not be loaded" is a standing
   * condition: auto-dismissing it would leave a broken page looking fine 3.5s
   * later. Only an action's own verdict is transient, because the user already
   * knows what they clicked and the screen returns to a valid state either way.
   */
  const [actionError, setActionErrorState] = useState<string | undefined>(undefined)

  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /** Guards state updates after the section unmounts mid-request. */
  const alive = useRef(true)

  /**
   * Show a transient message, then clear it.
   *
   * A message that never clears is indistinguishable from a stuck UI: the model
   * test's "X is working." stayed on screen forever, through every later action.
   * The deleted dashboard's toasts auto-dismissed after 3.5s for the same
   * reason; this keeps that behaviour, and a newer message simply replaces the
   * pending timer.
   *
   * One factory rather than two near-identical setters: the timer bookkeeping is
   * the part that must not drift between the success and failure channels. It
   * takes the timer ref as an argument rather than creating one, because a
   * `useCallback(timedChannel(...))` argument is evaluated on EVERY render — the
   * discarded function would still have appended its timer to the cancel list.
   * @param timer - the ref owning this channel's pending dismissal.
   * @param set - the state setter this channel writes to.
   * @returns a setter that arms the dismissal timer.
   */
  const timedChannel = (
    timer: { current: ReturnType<typeof setTimeout> | undefined },
    set: (text: string | undefined) => void,
  ): ((text: string | undefined) => void) => (text) => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    set(text)
    if (text === undefined) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      if (alive.current) set(undefined)
    }, ACTION_MESSAGE_TTL_MS)
  }

  /** Pending dismissal timers, one per channel, cancelled together on unmount. */
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const actionErrorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setNotice = useCallback(timedChannel(noticeTimer, setNoticeState), [])
  const setActionError = useCallback(timedChannel(actionErrorTimer, setActionErrorState), [])

  // Cancel every pending dismissal when the section unmounts.
  useEffect(() => () => {
    if (noticeTimer.current !== undefined) clearTimeout(noticeTimer.current)
    if (actionErrorTimer.current !== undefined) clearTimeout(actionErrorTimer.current)
  }, [])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const refresh = useCallback(async () => {
    // Deliberately NOT `Promise.all` on both calls. `account.list` can be slow
    // (it reaches upstream for quota discovery), while `stats.get` is a pure
    // local file read that cannot be — pairing them meant one slow call blanked
    // BOTH views, showing "no accounts" and a permanent spinner for data that
    // was never in doubt. Each settles on its own, so the usage tab renders
    // even if accounts lag.
    const [accountOutcome, statsOutcome] = await Promise.allSettled([
      rpc.call('account.list', {}),
      rpc.call('stats.get', {}),
    ])
    if (!alive.current) return
    if (accountOutcome.status === 'fulfilled') setAccounts(accountOutcome.value.accounts)
    if (statsOutcome.status === 'fulfilled') setStats(statsOutcome.value)
    // Surface a failure, but only after committing the successful halves, so a
    // partial failure still renders everything it can.
    const failed = [accountOutcome, statsOutcome].find((outcome) => outcome.status === 'rejected')
    if (failed?.status === 'rejected') {
      const caught: unknown = failed.reason
      setError(caught instanceof Error ? caught.message : String(caught))
    } else {
      setError(undefined)
    }
    if (alive.current) setLoaded(true)
  }, [rpc])

  /**
   * Refresh the 5h/weekly windows and merge them into the account rows.
   *
   * A separate call from `account.list` because that reply is deliberately
   * probe-free — folding an upstream call into it once made the whole view wait
   * on the network. Here the rows render immediately from `account.list` and the
   * windows fill in when they arrive, so a slow probe costs a placeholder.
   *
   * It also works for a pool of ANY size: the scheduling quota refresh is skipped
   * for a single enabled account (measuring that one could block the only
   * account), so this endpoint is the only thing that fills `cachedLimits` there.
   *
   * @param force - re-probe inside the TTL. Only an EXPLICIT refresh does this;
   *   an automatic one must respect the TTL, or every action that reloads the
   *   page would spend an upstream quota call.
   * @param report - whether to surface the outcome. Set only when the user asked
   *   for the refresh, since an automatic one must stay silent.
   */
  const loadLimits = useCallback(async (force = false, report = false) => {
    try {
      const result = await rpc.call('account.limits', force ? { force: true } : {})
      if (!alive.current) return
      const byIndex = new Map(result.limits.map((entry) => [entry.index, entry]))
      setAccounts((current) => current.map((account) => {
        const entry = byIndex.get(account.index)
        // Leave the row untouched when this refresh learned nothing, so a failed
        // probe cannot erase windows that were already showing.
        if (entry === undefined || entry.groups === null) return account
        return {
          ...account,
          limits: entry.groups,
          limitsUpdatedAt: entry.updatedAt,
          // A null rate keeps the previous one: "these two samples saw no drop"
          // is not evidence the burn stopped.
          limitBurn: entry.burn ?? account.limitBurn,
        }
      }))
      // An explicit refresh reports itself. Without this a forced probe that
      // failed changed nothing on screen — no new numbers, no new timestamp —
      // so the click looked inert. "Still fresh" and "probe failed" are
      // different facts and must not read the same.
      if (report) {
        if (result.failed > 0) setActionError(t('limitsRefreshFailed', { failed: result.failed }))
        else if (result.measured > 0) setNotice(t('limitsRefreshOk', { measured: result.measured }))
        else setNotice(t('limitsRefreshFresh'))
      }
    } catch (caught) {
      // Display-only in the automatic case: a failed refresh leaves the existing
      // windows in place and must never surface an error over the account list.
      if (report) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      }
    }
  }, [rpc, setActionError, setNotice, t])

  useEffect(() => { void refresh() }, [refresh])

  // The live line's poll. Runs for the section's lifetime — the interval is
  // cheap by design (one local read), and a hidden panel skips its ticks.
  useEffect(() => {
    const tick = (): void => {
      if (document.hidden) return
      void rpc.call('pool.status', {})
        .then((result) => { if (alive.current) setPoolBusy(result.busy) })
        .catch(() => { /* display-only; the next tick retries */ })
    }
    tick()
    const timer = setInterval(tick, POOL_POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [rpc])
  useEffect(() => {
    // Only on the tab that shows them, and after the rows exist so the merge has
    // something to write into.
    //
    // TTL-respecting (no `force`): this fires on mount and whenever the account
    // COUNT changes, and neither is a request for fresh numbers. Note the
    // dependency is the LENGTH, so a plain `refresh()` — which replaces the
    // array without changing its length — does not re-run this. That is why the
    // toolbar's Refresh calls `refreshAll` rather than relying on this effect.
    if (tab === 'accounts' && accounts.length > 0) void loadLimits()
  }, [tab, accounts.length, loadLimits])

  /**
   * The toolbar's Refresh: reload the page AND force the quota windows.
   *
   * The force is the whole point of a manual refresh — without it the click
   * could not deliver anything newer than what the 10-minute TTL already holds,
   * so "I want the latest numbers now" was unanswerable. The two halves are
   * deliberately not awaited together: `refresh()` is the fast local reload,
   * while the forced probe can take seconds, and the rows should not wait on it.
   */
  const refreshAll = useCallback(() => {
    void refresh()
    if (tab === 'accounts') void loadLimits(true, true)
  }, [loadLimits, refresh, tab])

  /**
   * The model list loads separately: it is the one call that may reach upstream
   * (model discovery), so the page must render even when it is slow or fails.
   *
   * Its failure is kept out of the shared error banner. The list is loaded
   * eagerly (the tab badge needs it), and "no account configured yet" is a
   * perfectly ordinary startup state for an accounts-first page — putting that
   * in the banner would greet every new user with an error.
   */
  const loadModels = useCallback(async () => {
    try {
      const result = await rpc.call('model.list', {})
      if (!alive.current) return
      setModels(result.models)
      setModelAccount(result.account)
      setModelError(undefined)
    } catch (caught) {
      if (!alive.current) return
      setModelError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [rpc])

  // Models load up front, not on first visit to the Models tab: the tab badge is
  // rendered from this list, so lazy loading made the count appear only after
  // the user had already been there, and left it stale after account changes.
  // The call is not awaited by `refresh`, so a slow model discovery still does
  // not hold up the accounts view.
  useEffect(() => { void loadModels() }, [loadModels])
  useEffect(() => {
    // Retry when the Models tab is opened and the initial load failed (e.g. no
    // account existed yet at mount, and one was added afterwards).
    if (tab === 'models' && models.length === 0) void loadModels()
  }, [tab, models.length, loadModels])
  /** Run one mutating call, then reload; failures land in the banner. */
  const act = useCallback(async (run: () => Promise<unknown>) => {
    setBusy(true)
    // A fresh action supersedes the previous outcome; a stale notice next to a
    // new error would read as if both were current.
    setNotice(undefined)
    try {
      await run()
      await refresh()
      setError(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [refresh])

  const startLogin = useCallback(() => {
    setBusy(true)
    rpc.call('auth.url', {}).then((result) => {
      window.open(result.url, 'agy-oauth', 'width=520,height=680')
      setError(undefined)
    }).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      if (alive.current) setBusy(false)
    })
  }, [rpc])

  // The callback page posts this once the exchange succeeds.
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      // Check the ORIGIN, not just the payload: the callback page is served from
      // this same web server, so a matching origin is what distinguishes it from
      // any other page that can reach this window. Without the check, an
      // unrelated opener could trigger a refresh by posting the same shape.
      if (event.origin !== window.location.origin) return
      if ((event.data as { type?: string } | null)?.type === 'agy_login_success') void refresh()
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [refresh])

  const copyText = useCallback(async (text: string) => {
    await navigator.clipboard?.writeText(text)
  }, [])

  /**
   * Run one one-shot action under the shared busy / clear / report envelope.
   *
   * Deliberately NOT `act()`. `act()` reads only a REJECTION and then calls
   * `refresh()`, which clears the banner — so a handler whose failure arrives
   * IN BAND (`{ ok: false }`, which is how `account.verify`, `account.test` and
   * `account.proxyTest` all report) had its verdict both discarded and erased:
   * the click fired, the host answered, and the panel showed nothing. The
   * reload is also not always wanted; each caller decides.
   *
   * A thrown error still lands here, so a request-level failure (a rejected
   * promise, e.g. "no proxy configured") reports through the same channel.
   * @param run - the action, which reports its own in-band verdict.
   */
  const runAction = useCallback(async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    // A fresh action supersedes the previous outcome; a stale verdict next to a
    // new one would read as if both were current.
    setNotice(undefined)
    setActionError(undefined)
    try {
      await run()
    } catch (caught) {
      if (alive.current) {
        setActionError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [setActionError, setNotice])

  const handlers: AccountHandlers = useMemo(() => ({
    t,
    onActivate: (index) => { void act(() => rpc.call('account.activate', { index })) },
    onVerify: (index) => {
      void runAction(async () => {
        const result = await rpc.call('account.verify', { index })
        // Reload BEFORE reporting: a live credential re-enables the account, so
        // the row must show the new state even when the verdict is a failure.
        if (alive.current) await refresh()
        if (!alive.current) return
        if (result.ok) setNotice(t('verifyOk', { email: result.email ?? `#${index}` }))
        else setActionError(t('verifyFail') + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
    onDelete: (index) => {
      if (!window.confirm(t('confirmDelete'))) return
      void act(() => rpc.call('account.delete', { index }))
    },
    onTest: (index) => {
      // Test needs a model id; discover the first visible one rather than
      // guessing, and report clearly when there is none.
      void runAction(async () => {
        const listed = models.length > 0 ? models : (await rpc.call('model.list', {})).models
        const target = listed.find((entry) => !entry.disabled)?.id
        if (target === undefined) throw new Error(t('noModelToTest'))
        // Carry the clicked row's index: without it the host tested whichever
        // account affinity picked and reported that result here.
        const result = await rpc.call('account.test', { model: target, index })
        // The test billed a real request, so the ledger reload is meaningful.
        if (alive.current) await refresh()
        if (!alive.current) return
        if (result.ok) setNotice(t('modelTestOk', { model: target }))
        else setActionError(t('modelTestFail', { model: target })
          + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
    onExport: (index) => {
      void act(async () => {
        const result = await rpc.call('account.export', { index })
        if (result.blob === undefined) throw new Error(result.error ?? t('exportFailed'))
        await copyText(result.blob)
      })
    },
    onRegenerateFingerprint: (index) => {
      void act(() => rpc.call('account.fingerprint', { index, action: 'regenerate' }))
    },
    onSetProxy: (index, proxy) => { void act(() => rpc.call('account.proxy', { index, proxy })) },
    /**
     * Probe the proxy and REPORT the verdict.
     *
     * `account.proxyTest` answers in band (`{ ok, masked, error? }`) and only
     * throws for a request-level failure, so the in-band verdict is read here
     * rather than left to `act()`. No `refresh()`: the probe mutates no account
     * state, so reloading would be a second `account.list` + `stats.get` round
     * trip bought for nothing.
     */
    onTestProxy: (index, proxy) => {
      void runAction(async () => {
        // The draft wins when present, so a proxy can be probed BEFORE it is
        // saved; the host normalizes it exactly as `account.proxy` does.
        const result = await rpc.call('account.proxyTest', {
          index,
          ...(proxy === '' ? {} : { proxy }),
        })
        if (!alive.current) return
        if (result.ok) setNotice(t('proxyTestOk', { proxy: result.masked }))
        else setActionError(t('proxyTestFail', { proxy: result.masked })
          + (result.error === undefined ? '' : `\n${result.error}`))
      })
    },
  }), [act, copyText, models, refresh, rpc, runAction, setActionError, setNotice, t])

  const tabButton = (id: TabId, label: string, count?: number): ReactNode =>
    h('button', {
      key: id,
      type: 'button',
      className: 'agy-tab',
      'data-active': tab === id,
      onClick: () => { setTab(id) },
    }, label, count === undefined ? null : h('span', { className: 'agy-count' }, String(count)))

  const body = tab === 'accounts'
    ? h(AccountsTab, { accounts, busy, busyNow: poolBusy, handlers, lang: props.lang, rpc, t, onBadgePrefChange: props.onBadgePrefChange })
    : tab === 'models'
      ? modelError === undefined
        ? h(ModelsTab, {
          models,
          account: modelAccount,
          // The quota panel answers the same question as the visibility list
          // ("which models can I use, how much is left"), so it lives here. It is
          // read from the active account's row, which is the only one the host
          // queries (see management.ts listAccounts).
          pending: toggling,
          testing: modelTesting,
          rpc,
          t,
          /**
           * Optimistic, per-model toggle.
           *
           * The old handler ran the write AND a full `model.list` reload through
           * `act()`, so a click cost two network round trips (the reload reaches
           * upstream model discovery) while a single global `busy` flag disabled
           * every control on the page — hence "it hangs, everything is disabled,
           * then it switches". The write is authoritative and its result is
           * already known, so the list is updated from the response and no
           * reload is needed: the switch reflects exactly what the host stored.
           */
          onToggle: (modelId: string, disabled: boolean) => {
            setToggling((current) => new Set(current).add(modelId))
            void (async () => {
              try {
                const result = await rpc.call('model.setDisabled', { modelId, disabled })
                if (!alive.current) return
                setModels((current) => current.map((model) => (model.id === result.modelId
                  ? { ...model, disabled: result.disabled }
                  : model)))
                setError(undefined)
              } catch (caught) {
                if (!alive.current) return
                setError(caught instanceof Error ? caught.message : String(caught))
              } finally {
                if (alive.current) {
                  setToggling((current) => {
                    const next = new Set(current)
                    next.delete(modelId)
                    return next
                  })
                }
              }
            })()
          },
          /**
           * One billed test call against exactly this model, reported in the
           * shared notice line (OK) or error banner (failure). The result must
           * not be silent: a test that shows nothing looks like nothing ran.
           */
          onTestModel: (modelId: string) => {
            setError(undefined)
            setNotice(undefined)
            setModelTesting((current) => new Set(current).add(modelId))
            void (async () => {
              try {
                // The active account serves the test, which is the account whose
                // quota this list describes; passing no index keeps that contract.
                const result = await rpc.call('account.test', { model: modelId })
                if (!alive.current) return
                if (result.ok) {
                  setNotice(t('modelTestOk', { model: modelId }))
                } else {
                  setError(t('modelTestFail', { model: modelId }) + (result.error ? `\n${result.error}` : ''))
                }
              } catch (caught) {
                if (!alive.current) return
                setError(caught instanceof Error ? caught.message : String(caught))
              } finally {
                if (alive.current) {
                  setModelTesting((current) => {
                    const next = new Set(current)
                    next.delete(modelId)
                    return next
                  })
                }
              }
            })()
          },
        })
        : h('div', { className: 'agy-root' },
          h('div', { className: 'agy-error' }, modelError),
          button(t('refresh'), () => { void loadModels() }, { size: 'sm' }))
      : tab === 'usage'
        ? h(UsageTab, { stats, lang: props.lang, t })
        : h(CredentialsTab, {
          busy,
          t,
          onImport: (kind: 'json' | 'blob', sources: string[]) => {
            void act(async () => {
              const result = await rpc.call('account.import', { kind, sources })
              // A batch with failures is a partial success, so it must not be
              // reported through the error path — and it must not be silent
              // either, which is what discarding this result used to be.
              if (result.errors.length > 0) {
                setNotice(`${t('importPartial', {
                  imported: result.imported,
                  replaced: result.replaced,
                  failed: result.errors.length,
                })}\n${result.errors.join('\n')}`)
              } else {
                setNotice(t('importResult', {
                  imported: result.imported,
                  replaced: result.replaced,
                }))
              }
            })
          },
          onExportAll: () => {
            void act(async () => {
              const { blobs } = await rpc.call('account.exportAll', {})
              await copyText(blobs.map((entry) => entry.blob).join('\n'))
            })
          },
        })

  return h('div', { className: 'agy-root' },
    h('div', { className: 'agy-head' },
      h('div', null,
        h('div', { className: 'agy-title' }, 'Antigravity'),
        h('div', { className: 'agy-sub' }, t('subtitle'))),
      h('div', { className: 'agy-toolbar' },
        // Both header actions use the host's `outline` variant — the same one
        // Refresh already used. They are equal-weight utility actions, so they
        // must look identical; an earlier pass gave Login `toolbar` (a filled
        // variant) to avoid the near-white `primary` slab, which fixed that
        // button but left the pair visibly mismatched. Copying Refresh is the
        // correct answer: `outline` is a bordered transparent capsule that reads
        // correctly in both themes, and it needs no token reasoning of ours.
        button(t('refresh'), refreshAll, { size: 'sm', disabled: busy }),
        button(t('login'), startLogin, { size: 'sm', disabled: busy }))),
    h('div', { className: 'agy-tabs' },
      tabButton('accounts', t('tabAccounts'), accounts.length),
      tabButton('models', t('tabModels'), models.length > 0 ? models.length : undefined),
      tabButton('usage', t('tabUsage')),
      tabButton('credentials', t('tabCredentials'))),
    error === undefined ? null : h('div', { className: 'agy-error' }, error),
    // The action's own verdict, in the same red as a standing error because it
    // IS one — it simply expires, since the page is still usable and the user
    // already knows what they clicked. `pre-wrap` is not inherited from
    // `.agy-notice`, so the two-line "what failed + why" form relies on the
    // stylesheet keeping newlines (see `.agy-error`).
    actionError === undefined ? null : h('div', { className: 'agy-error' }, actionError),
    notice === undefined ? null : h('div', { className: 'agy-notice' }, notice),
    body,
    loaded || error !== undefined ? null : h('div', { className: 'agy-empty' }, t('loading')))
}

/**
 * Register the Antigravity Settings section while this client plugin is active.
 * @param ctx - Client Cordis context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installAgyStyles(), 'dsh-agy: styles')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agy: dictionaries')
  const connection = ctx.get('connection') as ConnectionLike | undefined
  if (connection === undefined) {
    ctx.logger.warn('[dsh-agy] connection service unavailable — Antigravity settings not registered')
    return
  }
  const rpc = createRpc(connection)
  // Bound once from the host's locale service: the slot content is re-created on
  // a language switch (the locale plugin bumps the ledger), so `t` stays current.
  const t = ctx.locale.bind(NS)
  // The UI language for date formatting, read once per mount for the same
  // reason. Optional-call against an older host whose locale service predates
  // `getLocale`: undefined then degrades to the browser default, which is the
  // pre-`lang` behaviour, not a crash.
  const lang = ctx.locale.getLocale?.().active
  let badgeDisposer: (() => void) | null = null

  const registerBadge = (): void => {
    if (badgeDisposer !== null) return
    badgeDisposer = ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'agy-quota-badge',
      order: 8,
      label: () => t('title'),
    }, () => h(AgyQuotaBadge, { rpc, t })))
  }

  const unregisterBadge = (): void => {
    if (badgeDisposer !== null) {
      badgeDisposer()
      badgeDisposer = null
    }
  }

  // Opt-in: only register when user preference has enabled the badge
  void rpc.call('ui.prefs.get', {}).then((prefs) => {
    if (prefs?.conversationBadge) {
      registerBadge()
    }
  }).catch(() => {})

  const onBadgePrefChange = (enabled: boolean): void => {
    if (enabled) {
      registerBadge()
    } else {
      unregisterBadge()
    }
  }

  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agy',
    order: 30,
    locale: NS,
    label: () => t('title'),
  }, () => h(AgySettings, { rpc, t, lang, onBadgePrefChange }))), 'dsh-agy: Settings section')

  ctx.effect(() => () => {
    unregisterBadge()
  }, 'dsh-agy: quota badge cleanup')
}
