/**
 * Conversation-header quota badge & popover.
 *
 * Shows the tightest of the active account's tracked windows, and opens the
 * window breakdown floating card on hover or click.
 *
 * Built with DSH native UI primitives (Button, Tag, StateDot, useAnchoredPosition,
 * useDismissOnOutsidePointer) and semantic design tokens (--dsw-*).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  StateDot,
  Tag,
  useAnchoredPosition,
  useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { h } from './element.ts'
import { aliasVar, installAgyStyles } from './styles.ts'
import {
  accountQuotaRead,
  agoText,
  buildQuotaCards,
  desensitizeEmail,
  dotStateFor,
  isAccountQuotaExhausted,
  nextHealthyIndex,
  quotaColor,
  shouldProbeLimits,
  toPercent,
  windowLabel,
  type QuotaTranslate,
} from './quota-view.ts'
import type { AccountView, AgyRpcClient, UiPrefsView } from '../rpc-contract.ts'
import { DEFAULT_QUOTA_REFRESH_MINUTES } from '../ui-prefs-types.ts'
import type { QuotaWindow } from '../types.ts'

/**
 * Minimum throttle between automated re-fetches (2 minutes).
 */
const AUTO_REFRESH_THROTTLE_MS = 120_000

/**
 * Render-tick cadence for the countdown and staleness figures. Pure state
 * recompute from already-fetched data — deliberately ZERO RPC: the fetch paths
 * are mount, window wake (throttled above) and the popover's refresh button,
 * and without this tick the countdown text would freeze between fetches.
 */
const RENDER_TICK_MS = 60_000

/**
 * Grace period before hover close (250ms).
 */
const HOVER_CLOSE_DELAY_MS = 250

/**
 * Mobile layout breakpoint (aligned with styles.ts media query).
 */
export const MOBILE_BREAKPOINT_PX = 640

/**
 * Quota bar and percentage color for a window.
 * Strictly unified with upstream Settings panel via quotaColor(percent / 100).
 * Thresholds: >70% success green, 30%-70% warning amber, <30% error red.
 */
function quotaColorForWindow(percent: number | null): string {
  if (percent === null) return aliasVar('label-tertiary')
  return quotaColor(percent / 100)
}

/**
 * The account the badge's "next" button rotates TO, or null when there is
 * nothing to rotate to.
 *
 * Exported for a direct unit test — the rule is pure and the client test
 * harness does not render. Eligible accounts are the non-disabled ones (a
 * disabled row cannot serve requests, so activating it would be a no-op);
 * rotation starts AFTER the active account and wraps around. When no account
 * is marked active (an all-disabled pool, or a reply that predates the flag),
 * rotation still moves forward from the first eligible row rather than
 * dead-ending.
 */
export function nextSwitchableIndex(accounts: readonly AccountView[]): number | null {
  const switchable = accounts.filter((candidate) => candidate.state !== 'disabled')
  if (switchable.length < 2) return null
  const activeIndex = accounts.find((candidate) => candidate.active)?.index ?? switchable[0]!.index
  const pos = switchable.findIndex((candidate) => candidate.index === activeIndex)
  const anchor = pos >= 0 ? pos : switchable.length - 1
  const next = switchable[(anchor + 1) % switchable.length]!
  return next.index === activeIndex ? null : next.index
}

interface EnrichedWindow {
  bucketId: string
  label: string
  percent: number | null
  color: string
  reset: string | null
  stale: boolean
}

interface EnrichedCard {
  key: string
  title: string
  windows: EnrichedWindow[]
}

/** Render one window row of a quota card. */
function renderWindow(
  window: EnrichedWindow,
  index: number,
  t: QuotaTranslate,
): ReactNode {
  return h(
    'div',
    {
      key: window.bucketId,
      className: 'agy-ui-limit-row',
    },
    h(
      'div',
      { className: 'agy-ui-limit-header' },
      h('span', { className: 'agy-ui-limit-title' }, window.label),
      h(
        'span',
        { className: 'agy-ui-limit-percent', style: { color: window.color } },
        window.percent === null ? '—' : `${window.percent}%`,
      ),
    ),
    h(
      'div',
      { className: 'agy-ui-progress-track' },
      h('div', {
        className: 'agy-ui-progress-fill',
        style: {
          width: `${window.percent ?? 0}%`,
          backgroundColor: window.color,
        },
      }),
    ),
    window.reset
      ? h(
          'div',
          { className: 'agy-ui-quota-footer' },
          h('span', null, window.reset),
        )
      : null,
    window.percent === null
      ? h(
          'div',
          { className: 'agy-ui-window-note' },
          window.stale ? t('quotaStaleNote') : t('quotaUnmeasuredNote'),
        )
      : null,
  )
}

/**
 * The badge and its popover modal.
 */
export function AgyQuotaBadge({ rpc, t }: { rpc: AgyRpcClient, t: QuotaTranslate }): ReactNode {
  const [accounts, setAccounts] = useState<AccountView[]>([])
  const [loading, setLoading] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isPinned, setIsPinned] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [detailedReset, setDetailedReset] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const leaveTimerRef = useRef<number | null>(null)
  const lastFetchTimeRef = useRef<number>(0)
  const failedAtRef = useRef<number | null>(null)
  // The auto-refresh interval the Settings card stores, in minutes; null =
  // never. The state defaults to the shipped interval so the timer runs before
  // the first prefs read lands.
  const [refreshMinutes, setRefreshMinutes] = useState<number | null>(DEFAULT_QUOTA_REFRESH_MINUTES)

  useEffect(() => {
    installAgyStyles()
    const checkMobile = () => {
      setIsMobile(typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    const onPrefsChange = (e: Event): void => {
      const detail = (e as CustomEvent<UiPrefsView>).detail
      if (detail && typeof detail.detailedQuotaReset === 'boolean') {
        setDetailedReset(detail.detailedQuotaReset)
      }
      if (detail) {
        setRefreshMinutes(detail.quotaRefreshMinutes)
      }
    }
    window.addEventListener('agy:ui-prefs-changed', onPrefsChange)
    return () => {
      window.removeEventListener('resize', checkMobile)
      window.removeEventListener('agy:ui-prefs-changed', onPrefsChange)
    }
  }, [])

  const load = useCallback(async (isManual: boolean = false, forceProbe: boolean = false) => {
    const currentNow = Date.now()
    // The configured interval is the throttle's floor: a 1-minute setting must
    // not be swallowed by the 2-minute wake guard. "Never" keeps the plain
    // guard so a wake refresh cannot stack onto a fresh one.
    const throttle = refreshMinutes === null
      ? AUTO_REFRESH_THROTTLE_MS
      : Math.min(AUTO_REFRESH_THROTTLE_MS, refreshMinutes * 60_000)
    if (!isManual && lastFetchTimeRef.current > 0 && currentNow - lastFetchTimeRef.current < throttle - 1_000) {
      return
    }
    lastFetchTimeRef.current = currentNow

    setIsUpdating(true)
    setLoading(true)
    try {
      const [listed, prefs] = await Promise.all([
        rpc.call('account.list', {}),
        rpc.call('ui.prefs.get', {}).catch(() => null),
      ])
      setAccounts(listed.accounts)
      if (prefs) {
        setDetailedReset(prefs.detailedQuotaReset === true)
        setRefreshMinutes(prefs.quotaRefreshMinutes)
      }
      setError(null)

      const probe = shouldProbeLimits({ force: isManual || forceProbe, failedAt: failedAtRef.current, now: Date.now() })
      if (probe !== 'off') {
        const limits = await rpc.call('account.limits', probe === 'force' ? { force: true } : {})
        const byIndex = new Map(limits.limits.map((entry) => [entry.index, entry]))
        setAccounts((current) => current.map((account) => {
          const entry = byIndex.get(account.index)
          return entry === undefined
            ? account
            : { ...account, limits: entry.groups, limitsUpdatedAt: entry.updatedAt }
        }))
        failedAtRef.current = limits.measured === 0 && limits.failed > 0 ? Date.now() : null
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setNow(Date.now())
      setTimeout(() => {
        setIsUpdating(false)
      }, 1200)
    }
  }, [rpc, refreshMinutes])

  useEffect(() => {
    void load(false)
    const tick = window.setInterval(() => setNow(Date.now()), RENDER_TICK_MS)
    const onWake = (): void => {
      if (document.visibilityState !== 'hidden') void load(false)
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.clearInterval(tick)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    }
  }, [load])

  // The user-configured auto-refresh: a load on a timer, honouring the
  // interval the Settings card stores (default 5 minutes; "never" mounts no
  // timer at all). The tick forces the limits probe past the host's cache TTL
  // — the interval promises fresh quota, not a cached read — while the wake
  // load above keeps its cheap host-TTL-bounded probe. A hidden tab skips the
  // tick; the wake load covers the return, so background probing stays off.
  useEffect(() => {
    if (refreshMinutes === null) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load(false, true)
    }, refreshMinutes * 60_000)
    return () => window.clearInterval(id)
  }, [refreshMinutes, load])

  /**
   * Accounts that can be switched to: everything that is not disabled.
   *
   * The switch moves the pool's active index — a disabled account cannot serve
   * requests, so it is left out of both the badge's "next" rotation and the
   * popover's picker (its row still names it under the account list above, but
   * selecting it would be a no-op).
   */
  const switchableAccounts = accounts.filter((candidate) => candidate.state !== 'disabled')

  /**
   * Announce a completed switch.
   *
   * The badge lives in the conversation header while the Settings section and
   * the host's model picker live elsewhere; they cannot observe this component's
   * state. The window event is the same pattern the UI-pref toggles use, and the
   * listeners reload from the store so every surface shows the new account.
   */
  const announceAccountChanged = (index: number): void => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('agy:account-changed', { detail: { index } }))
    }
  }

  /**
   * Rotate the pool's active account forward one position (wrapping around),
   * then force a quota refresh so the badge and popover show the new account's
   * numbers immediately instead of on the next scheduled tick.
   */
  const handleSwitchNext = useCallback(async () => {
    const next = nextSwitchableIndex(accounts)
    if (next === null) return
    setIsUpdating(true)
    try {
      await rpc.call('account.activate', { index: next })
      // The activated account may see different windows; a forced reload reads
      // them now rather than waiting out the limits cache TTL.
      await load(true)
      lastManualIndexRef.current = next
      announceAccountChanged(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsUpdating(false)
    }
  }, [accounts, load, rpc])

  /**
   * Switch the pool's active account to the given index, then refresh its quota.
   */
  const handleSwitchTo = useCallback(async (index: number) => {
    const activePos = accounts.find((candidate) => candidate.active)?.index
    if (activePos === index) return
    setIsUpdating(true)
    try {
      await rpc.call('account.activate', { index })
      await load(true)
      lastManualIndexRef.current = index
      announceAccountChanged(index)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsUpdating(false)
    }
  }, [accounts, load, rpc])

  // A manual pick is an explicit override: the user chose to sit on this
  // account, so the auto-rotate below must not bounce them off it until the
  // choice stops matching reality (a different active index resets it).
  const lastManualIndexRef = useRef<number | null>(null)
  // One rotation attempt per exhaustion episode: after the switch the reload
  // re-runs this effect with the new active account; the flag stops a second
  // attempt if THAT one is also drained, and the all-drained pool would
  // otherwise chase its own tail. Cleared as soon as the active account is
  // healthy again, so the next exhaustion rotates normally.
  const autoRotateAttemptedRef = useRef(false)

  // Auto-rotate on exhaustion: when a load observes the active account with
  // EITHER tracked window at 0% and a healthy account exists, switch the pool
  // to it. The decision is `nextHealthyIndex` — the same quota-aware rule the
  // rotation reads, so the badge can never rotate differently from the pool.
  // The switch propagates the usual way: `load(true)` re-reads the listing
  // (the board then shows the new active account), and `agy:account-changed`
  // tells the Settings section to reload its own views.
  useEffect(() => {
    if (accounts.length === 0) return
    const active = accounts.find((candidate) => candidate.active) ?? accounts[0]
    if (!active || !isAccountQuotaExhausted(active, Date.now())) {
      autoRotateAttemptedRef.current = false
      return
    }
    if (lastManualIndexRef.current === active.index || autoRotateAttemptedRef.current) return
    const next = nextHealthyIndex(accounts, Date.now())
    if (next === null || next === active.index) return
    autoRotateAttemptedRef.current = true
    lastManualIndexRef.current = null
    void (async () => {
      setIsUpdating(true)
      try {
        await rpc.call('account.activate', { index: next })
        announceAccountChanged(next)
        await load(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setIsUpdating(false)
      }
    })()
  }, [accounts, load, rpc])

  const isOpen = isPinned || isHovered

  // Dismiss pinned popover on outside pointer
  useDismissOnOutsidePointer(rootRef, isPinned, setIsPinned, panelRef)

  // Anchored position calculation for desktop placement
  const anchored = useAnchoredPosition({
    open: isOpen && !isMobile,
    anchorRef: rootRef,
    panelRef,
    side: 'bottom',
    gap: 6,
    margin: 12,
  })

  const handleMouseEnterBadge = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
    setIsHovered(true)
  }

  const handleMouseLeaveBadge = () => {
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    leaveTimerRef.current = window.setTimeout(() => {
      setIsHovered(false)
    }, HOVER_CLOSE_DELAY_MS)
  }

  const handleMouseEnterPopover = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }

  const handleMouseLeavePopover = () => {
    if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    leaveTimerRef.current = window.setTimeout(() => {
      setIsHovered(false)
    }, HOVER_CLOSE_DELAY_MS)
  }

  const handleTogglePin = (e?: { stopPropagation: () => void }) => {
    e?.stopPropagation()
    setIsPinned((prev) => !prev)
    setIsHovered(true)
  }

  const handleClose = () => {
    if (leaveTimerRef.current !== null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
    setIsPinned(false)
    setIsHovered(false)
  }

  const handleRefreshClick = async (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (loading) return
    await load(true)
  }

  const activeAccount = accounts.find((a) => a.active) ?? accounts[0]
  const accountCount = accounts.length
  const rawDot = dotStateFor(accounts)
  const dotState = rawDot === 'done' ? 'active' : rawDot === 'warning' ? 'cooling' : 'disabled'
  // The badge alternates the ACTIVE account's two tracked readings —
  // `account · 5h 82%` then `account · weekly 90%` — instead of ranking a
  // single "tightest" window, so the user sees both numbers the pool rotates
  // on. The flip rides the render tick that already runs (zero RPC); with only
  // one window measured, that one shows steadily instead of flickering to a
  // count.
  const activeRead = accountQuotaRead(activeAccount, now)
  const has5h = activeRead.fiveHour !== null
  const hasWeekly = activeRead.weekly !== null
  const showWeekly = has5h && hasWeekly
    ? Math.floor(now / RENDER_TICK_MS) % 2 === 1
    : hasWeekly && !has5h
  const shownToken = showWeekly ? 'weekly' : '5h'
  const shownFraction = showWeekly ? activeRead.weekly : activeRead.fiveHour
  // The label and percent are hoisted out of the call-site objects: the i18n
  // walker reads each `t('key', {...})` params up to its first `}`, which a
  // template literal's `${...}` would cut short.
  const shownWindowLabel = `${windowLabel(shownToken, t)} `
  const shownPercent = toPercent(shownFraction) ?? 0
  const accountName = activeAccount?.email ? desensitizeEmail(activeAccount.email) : null
  const displayText = shownFraction !== null && accountName !== null
    ? t('badgeAccountQuotaFormat', { account: accountName, window: shownWindowLabel, percent: shownPercent })
    : t('badgeCountFormat', { count: accountCount })

  // The header's traffic light follows the QUOTA contract, not the pool's
  // account-state vocabulary: EITHER tracked window at exactly 0% is red (the
  // pool would rotate off it too), a live 5h reading below 20% is amber, and
  // anything else keeps the healthy look. Classes ride the badge and the dot;
  // the dot rules are declared after the state rules in styles.ts so the quota
  // verdict wins the cascade when both land.
  const exhausted = isAccountQuotaExhausted(activeAccount, now)
  const fiveHourLow = activeRead.fiveHour !== null && activeRead.fiveHour > 0 && activeRead.fiveHour < 0.2
  const statusClass = exhausted ? 'quota-error' : fiveHourLow ? 'quota-warn' : ''
  const statusColor = exhausted
    ? aliasVar('state-error-primary')
    : fiveHourLow
      ? aliasVar('state-warn-primary')
      : null

  // The picker lists every serviceable account. The active row joins even when
  // the switch rules would exclude it (an all-drained pool keeps its active
  // row selectable-looking) so the select's value always has an option to show
  // instead of rendering blank.
  const selectOptions = activeAccount !== undefined
    && switchableAccounts.some((candidate) => candidate.index === activeAccount.index)
    ? switchableAccounts
    : activeAccount
      ? [activeAccount, ...switchableAccounts.filter((candidate) => candidate.index !== activeAccount.index)]
      : switchableAccounts

  const rawCards = buildQuotaCards(activeAccount, t, now, detailedReset)
  const cards: EnrichedCard[] = rawCards.map((rc) => ({
    key: rc.key,
    title: rc.title,
    windows: rc.windows.map((w) => ({
      bucketId: w.bucketId,
      label: w.label,
      percent: w.percent,
      color: quotaColorForWindow(w.percent),
      reset: w.reset,
      stale: w.stale,
    })),
  }))
  const limitsAge = activeAccount?.limitsUpdatedAt
    ? agoText(new Date(activeAccount.limitsUpdatedAt).toISOString(), t, now)
    : null

  const badgeReadingStr = shownFraction !== null
    ? t('badgeReading', { window: shownWindowLabel, percent: shownPercent })
    : t('badgeUnmeasured')
  const badgeTooltip = t('badgeTooltip', { count: accountCount, reading: badgeReadingStr })

  const popoverContent = h(
    'div',
    {
      ref: panelRef,
      className: `agy-ui-popover ${isMobile ? 'mobile' : 'desktop'}`,
      style: !isMobile
        ? (anchored === null
            ? { visibility: 'hidden' as const }
            : {
                position: 'fixed' as const,
                top: `${anchored.top}px`,
                left: `${anchored.left}px`,
                visibility: 'visible' as const,
              })
        : undefined,
      onMouseEnter: handleMouseEnterPopover,
      onMouseLeave: handleMouseLeavePopover,
      onClick: (e: { stopPropagation: () => void }) => { e.stopPropagation() },
    },
    // Mobile handle
    isMobile ? h('div', { className: 'agy-ui-mobile-handle' }) : null,

    // Header
    h(
      'div',
      { className: 'agy-ui-modal-header' },
      h(
        'div',
        { className: 'agy-ui-modal-title' },
        h('span', { className: 'agy-ui-sparkle' }, '✦'),
        h('span', null, t('badgeTitle')),
        isPinned && !isMobile ? h(Tag, { tone: 'solid', className: 'agy-ui-pinned-tag' }, t('badgePinned')) : null,
      ),
      h(
        'div',
        { className: 'agy-ui-header-actions' },
        !isMobile
          ? h(
              Button,
              {
                variant: 'ghost',
                size: 'sm',
                className: `agy-ui-icon-btn ${isPinned ? 'active' : ''}`,
                title: isPinned ? t('badgeUnpinHint') : t('badgeHint'),
                onClick: handleTogglePin,
              },
              h(
                'svg',
                { width: '13', height: '13', viewBox: '0 0 24 24', fill: isPinned ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: '2' },
                h('path', { d: 'M12 2v8m0 0l3-3m-3 3L9 7M5 10h14a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2zM12 15v7' }),
              ),
            )
          : null,
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: 'agy-ui-icon-btn',
            title: t('badgeRefreshHint'),
            onClick: handleRefreshClick,
            disabled: loading,
          },
          h(
            'svg',
            {
              className: loading || isUpdating ? 'agy-ui-spinning' : '',
              width: '13',
              height: '13',
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: '2',
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            },
            h('path', { d: 'M21.5 2v6h-6M2.5 22v-6h6M2.5 11.5a10 10 0 0 1 17.5-4.5l1.5 2M21.5 12.5a10 10 0 0 1-17.5 4.5l-1.5-2' }),
          ),
        ),
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            className: 'agy-ui-icon-btn',
            title: t('badgeClose'),
            onClick: handleClose,
          },
          h(
            'svg',
            { width: '13', height: '13', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
            h('line', { x1: '18', y1: '6', x2: '6', y2: '18' }),
            h('line', { x1: '6', y1: '6', x2: '18', y2: '18' }),
          ),
        ),
      ),
    ),

    // Body
    h(
      'div',
      { className: 'agy-ui-modal-body' },
      activeAccount
        ? h(
            'div',
            { className: 'agy-ui-account-card' },
            h(
              'div',
              { className: 'agy-ui-account-card-row' },
              h(
                'div',
                null,
                h('div', { className: 'agy-ui-account-email' }, desensitizeEmail(activeAccount.email)),
                h('div', { className: 'agy-ui-account-project' }, `${t('fieldProject')}: ${activeAccount.projectId || t('thinkingDefaultAll')}`),
                // The model version upstream actually routed the last request
                // to. Plain text only — NO state tag: upstream's version suffix
                // does not reliably imply a production/canary split, and a
                // guessed label is a false alarm the reader acts on.
                activeAccount.actualModel === null
                  ? null
                  : h('div', { className: 'agy-ui-account-project' },
                    `${t('actualModelLabel')}: ${activeAccount.actualModel}`),
              ),
              // The account picker occupies the state tag's old place: the
              // state it showed is already legible here (the badge's dot, the
              // verify note below), while WHICH account the pool serves is the
              // one fact this card can act on.
              h(
                'select',
                {
                  className: 'agy-ui-account-select',
                  value: String(activeAccount.index),
                  disabled: isUpdating,
                  title: t('badgeSwitchTo'),
                  'aria-label': t('badgeSwitchTo'),
                  onChange: (event: { target: { value: string } }) => {
                    void handleSwitchTo(Number(event.target.value))
                  },
                },
                selectOptions.map((candidate) =>
                  h('option',
                    { key: candidate.index, value: String(candidate.index) },
                    candidate.email ? desensitizeEmail(candidate.email) : `#${candidate.index}`)),
              ),
            ),
          )
        : h(
            'div',
            { className: 'agy-ui-account-card' },
            h('div', { className: 'agy-ui-account-email', style: { color: aliasVar('label-tertiary') } }, error ?? t('badgeNoAccount')),
          ),

      activeAccount?.verificationRequired && activeAccount?.verificationUrl
        ? h(
            'div',
            { className: 'agy-ui-verify-note' },
            h('span', null, t('badgeVerifyRequired')),
            h(
              'a',
              {
                className: 'agy-ui-link-btn',
                href: activeAccount.verificationUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
              },
              t('badgeAppealLink'),
            ),
          )
        : null,

      h('div', { className: 'agy-ui-section-label' }, t('badgeSectionMonitor')),

      ...cards.map((card) =>
        h(
          'div',
          { key: card.key, className: 'agy-ui-quota-card' },
          h(
            'div',
            { className: 'agy-ui-quota-header' },
            h('span', { className: 'agy-ui-model-name' }, card.title),
          ),
          ...card.windows.map((w, idx) => renderWindow(w, idx, t)),
        ),
      ),

      cards.length === 0
        ? h('div', { className: 'agy-ui-window-note' }, t('badgeNoQuotaData'))
        : null,

      limitsAge ? h('div', { className: 'agy-ui-limit-age' }, t('badgeMeasuredAt', { time: limitsAge })) : null,
    ),

    // Footer
    h(
      'div',
      { className: 'agy-ui-modal-footer' },
      h('span', null, t('quotaSourceCaption')),
      h('span', null, t('quotaManageHint')),
    ),
  )

  const popoverNode = isOpen
    ? (isMobile
        ? h(
            'div',
            {
              className: 'agy-ui-popover-container mobile',
              onClick: handleClose,
            },
            popoverContent,
          )
        : popoverContent)
    : null

  return h(
    'span',
    {
      ref: rootRef,
      style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
    },
    h(
      Button,
      {
        variant: 'ghost',
        size: 'sm',
        className: `agy-ui-badge ${isPinned ? 'pinned' : ''}${statusClass ? ` ${statusClass}` : ''}`,
        title: badgeTooltip,
        'aria-label': t('badgeAria'),
        onClick: handleTogglePin,
        onMouseEnter: handleMouseEnterBadge,
        onMouseLeave: handleMouseLeaveBadge,
      },
      h(StateDot, {
        state: rawDot as StateDotState,
        size: 7,
        className: `agy-ui-dot ${dotState}${statusClass ? ` ${statusClass}` : ''}${isUpdating ? ' updating' : ''}`,
      }),
      h('span', { style: statusColor === null ? undefined : { color: statusColor } }, displayText),
      // The rotate affordance lives INSIDE the quota capsule, at its right —
      // one control, not two: the capsule opens the board, the arrow rotates
      // the pool to the next serviceable account. stopPropagation keeps the
      // rotation from toggling the pin the capsule's own click starts.
      h(
        'span',
        {
          className: `agy-ui-badge-switch${switchableAccounts.length < 2 || isUpdating ? ' disabled' : ''}`,
          role: 'button',
          tabIndex: 0,
          title: t('badgeSwitchNext'),
          'aria-label': t('badgeSwitchNext'),
          onClick: (e: { stopPropagation: () => void }) => {
            e.stopPropagation()
            if (!isUpdating && switchableAccounts.length >= 2) void handleSwitchNext()
          },
          onKeyDown: (e: { key: string, stopPropagation: () => void, preventDefault: () => void }) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.stopPropagation()
            e.preventDefault()
            if (!isUpdating && switchableAccounts.length >= 2) void handleSwitchNext()
          },
        },
        h(
          'svg',
          { width: '12', height: '12', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M17 2l4 4-4 4' }),
          h('path', { d: 'M3 11v-1a4 4 0 0 1 4-4h14' }),
          h('path', { d: 'M7 22l-4-4 4-4' }),
          h('path', { d: 'M21 13v1a4 4 0 0 1-4 4H3' }),
        ),
      ),
    ),
    popoverNode,
  )
}
