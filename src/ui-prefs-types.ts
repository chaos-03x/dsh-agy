/** Bounds for the auto quota-refresh interval, in minutes. */
export const QUOTA_REFRESH_MIN_MINUTES = 1
export const QUOTA_REFRESH_MAX_MINUTES = 120
/** Interval used while nothing is stored. */
export const DEFAULT_QUOTA_REFRESH_MINUTES = 5

export interface UiPrefsView {
  conversationBadge: boolean
  detailedQuotaReset: boolean
  /**
   * Auto quota-refresh interval in minutes; `null` = never (manual only).
   * Storage that omits the field resolves to the default in the view, so a
   * reader never has to re-implement the fallback.
   */
  quotaRefreshMinutes: number | null
}

export interface SetUiPrefsPayload {
  conversationBadge?: boolean
  detailedQuotaReset?: boolean
  quotaRefreshMinutes?: number | null
}

export interface UiPrefsDocument {
  version: 1
  conversationBadge?: boolean
  detailedQuotaReset?: boolean
  quotaRefreshMinutes?: number | null
}

/**
 * A valid interval for storage, or `undefined` when the raw value is garbage.
 *
 * `null` is MEANINGFUL ("never refresh") and survives; a non-integer, a value
 * outside the bounds, or a wrong type yields `undefined`, which callers treat
 * as "absent" so the default applies instead of a broken interval.
 */
export function sanitizeQuotaRefreshMinutes(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return undefined
  if (raw < QUOTA_REFRESH_MIN_MINUTES || raw > QUOTA_REFRESH_MAX_MINUTES) return undefined
  return raw
}

/** The view's interval: the stored value, else the 5-minute default. */
export function quotaRefreshMinutesView(doc: UiPrefsDocument): number | null {
  return doc.quotaRefreshMinutes === undefined ? DEFAULT_QUOTA_REFRESH_MINUTES : doc.quotaRefreshMinutes
}
