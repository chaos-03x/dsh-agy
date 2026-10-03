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
import { installAgyStyles } from './styles.ts'
import {
  agoText,
  buildQuotaCards,
  desensitizeEmail,
  dotStateFor,
  pickBadgeQuota,
  quotaColor,
  shouldProbeLimits,
  stateLabel,
  windowLabel,
  type QuotaTranslate,
} from './quota-view.ts'
import type { AccountView, AgyRpcClient } from '../rpc-contract.ts'
import type { QuotaWindow } from '../types.ts'

/**
 * Minimum throttle between automated re-fetches (2 minutes).
 */
const AUTO_REFRESH_THROTTLE_MS = 120_000

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
  if (percent === null) return 'var(--dsw-alias-label-tertiary, #8f959e)'
  return quotaColor(percent / 100)
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
  const [error, setError] = useState<string | null>(null)

  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const leaveTimerRef = useRef<number | null>(null)
  const lastFetchTimeRef = useRef<number>(0)
  const failedAtRef = useRef<number | null>(null)

  useEffect(() => {
    installAgyStyles()
    const checkMobile = () => {
      setIsMobile(typeof window !== 'undefined' && window.innerWidth <= MOBILE_BREAKPOINT_PX)
    }
    checkMobile()
    window.addEventListener('resize', checkMobile)
    return () => window.removeEventListener('resize', checkMobile)
  }, [])

  const load = useCallback(async (isManual: boolean = false) => {
    const currentNow = Date.now()
    if (!isManual && lastFetchTimeRef.current > 0 && currentNow - lastFetchTimeRef.current < AUTO_REFRESH_THROTTLE_MS - 1_000) {
      return
    }
    lastFetchTimeRef.current = currentNow

    setIsUpdating(true)
    setLoading(true)
    try {
      const listed = await rpc.call('account.list', {})
      setAccounts(listed.accounts)
      setError(null)

      const probe = shouldProbeLimits({ force: isManual, failedAt: failedAtRef.current, now: Date.now() })
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
  }, [rpc])

  useEffect(() => {
    void load(false)
    const onWake = (): void => {
      if (document.visibilityState !== 'hidden') void load(false)
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
      if (leaveTimerRef.current !== null) window.clearTimeout(leaveTimerRef.current)
    }
  }, [load])

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
  const badgeQuota = pickBadgeQuota(accounts, now)
  const badgeWindow = badgeQuota?.window && badgeQuota.window !== '5h' ? `${windowLabel(badgeQuota.window, t)} ` : ''
  const displayText = badgeQuota !== null
    ? (badgeWindow !== ''
        ? t('badgeWindowQuotaFormat', { window: badgeWindow, percent: badgeQuota.percent })
        : t('badgeQuotaFormat', { percent: badgeQuota.percent }))
    : t('badgeCountFormat', { count: accountCount })

  const rawCards = buildQuotaCards(activeAccount, t, now)
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

  const badgeReadingStr = badgeQuota !== null
    ? t('badgeReading', { window: badgeWindow, percent: badgeQuota.percent })
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
              null,
              h('div', { className: 'agy-ui-account-email' }, desensitizeEmail(activeAccount.email)),
              h('div', { className: 'agy-ui-account-project' }, `${t('fieldProject')}: ${activeAccount.projectId || t('thinkingDefaultAll')}`),
            ),
            h(
              Tag,
              {
                tone: activeAccount.state === 'active' ? 'success' : activeAccount.state === 'cooling' ? 'warning' : 'danger',
                className: `agy-ui-state-pill ${activeAccount.state || 'active'}`,
              },
              stateLabel(activeAccount.state || 'active', t),
            ),
          )
        : h(
            'div',
            { className: 'agy-ui-account-card' },
            h('div', { className: 'agy-ui-account-email', style: { color: 'var(--dsw-alias-label-tertiary, #8f959e)' } }, error ?? t('badgeNoAccount')),
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
        className: `agy-ui-badge ${isPinned ? 'pinned' : ''}`,
        title: badgeTooltip,
        'aria-label': t('badgeAria'),
        onClick: handleTogglePin,
        onMouseEnter: handleMouseEnterBadge,
        onMouseLeave: handleMouseLeaveBadge,
      },
      h(StateDot, {
        state: rawDot as StateDotState,
        size: 7,
        className: `agy-ui-dot ${dotState}${isUpdating ? ' updating' : ''}`,
      }),
      h('span', null, displayText),
    ),
    popoverNode,
  )
}
