import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  parseUiPrefs,
  sanitizeUiPrefs,
  UiPrefsStore,
  UI_PREFS_VERSION,
} from '../src/ui-prefs.ts'
import {
  DEFAULT_QUOTA_REFRESH_MINUTES,
  quotaRefreshMinutesView,
  sanitizeQuotaRefreshMinutes,
} from '../src/ui-prefs-types.ts'

describe('ui-prefs parser and sanitizer', () => {
  it('sanitizes empty / invalid raw input to default document', () => {
    expect(sanitizeUiPrefs(null)).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs([])).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs('string')).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs({})).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs({ conversationBadge: 'yes' })).toEqual({ version: UI_PREFS_VERSION })
  })

  it('keeps valid boolean flags', () => {
    expect(sanitizeUiPrefs({ conversationBadge: true, detailedQuotaReset: true })).toEqual({
      version: UI_PREFS_VERSION,
      conversationBadge: true,
      detailedQuotaReset: true,
    })
    expect(sanitizeUiPrefs({ conversationBadge: false, detailedQuotaReset: false })).toEqual({
      version: UI_PREFS_VERSION,
      conversationBadge: false,
      detailedQuotaReset: false,
    })
  })

  it('parses malformed json softly', () => {
    expect(parseUiPrefs('{ bad json')).toEqual({ version: UI_PREFS_VERSION })
  })

  it('keeps a null interval (never) and valid integers, drops garbage', () => {
    // `null` is the explicit "never" choice and must survive, not collapse
    // into the default: a user who turned the timer OFF must not find it back
    // on after a reload.
    expect(sanitizeQuotaRefreshMinutes(null)).toBeNull()
    expect(sanitizeQuotaRefreshMinutes(1)).toBe(1)
    expect(sanitizeQuotaRefreshMinutes(120)).toBe(120)
    // 0, fractional, out-of-bounds, and wrong types mean "absent" — the view
    // then falls back to the shipped default.
    expect(sanitizeQuotaRefreshMinutes(0)).toBeUndefined()
    expect(sanitizeQuotaRefreshMinutes(1.5)).toBeUndefined()
    expect(sanitizeQuotaRefreshMinutes(121)).toBeUndefined()
    expect(sanitizeQuotaRefreshMinutes(-5)).toBeUndefined()
    expect(sanitizeQuotaRefreshMinutes('10')).toBeUndefined()
    expect(sanitizeQuotaRefreshMinutes(undefined)).toBeUndefined()

    expect(sanitizeUiPrefs({ quotaRefreshMinutes: null })).toEqual({
      version: UI_PREFS_VERSION,
      quotaRefreshMinutes: null,
    })
    expect(sanitizeUiPrefs({ quotaRefreshMinutes: 15 })).toEqual({
      version: UI_PREFS_VERSION,
      quotaRefreshMinutes: 15,
    })
    expect(sanitizeUiPrefs({ quotaRefreshMinutes: 0 })).toEqual({ version: UI_PREFS_VERSION })
  })

  it('resolves an unstored interval to the shipped default in the view', () => {
    expect(DEFAULT_QUOTA_REFRESH_MINUTES).toBe(5)
    expect(quotaRefreshMinutesView({ version: 1 })).toBe(5)
    expect(quotaRefreshMinutesView({ version: 1, quotaRefreshMinutes: null })).toBeNull()
    expect(quotaRefreshMinutesView({ version: 1, quotaRefreshMinutes: 30 })).toBe(30)
  })
})

describe('UiPrefsStore', () => {
  it('returns default view when file does not exist', () => {
    const file = join(tmpdir(), `agy-ui-prefs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      const store = new UiPrefsStore(file)
      expect(store.get()).toEqual({
        conversationBadge: false,
        detailedQuotaReset: false,
        quotaRefreshMinutes: DEFAULT_QUOTA_REFRESH_MINUTES,
      })
    } finally {
      if (existsSync(file)) rmSync(file)
    }
  })

  it('persists and reloads preference updates atomically', () => {
    const file = join(tmpdir(), `agy-ui-prefs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      const store = new UiPrefsStore(file)
      expect(store.get().conversationBadge).toBe(false)

      const updated = store.set({ conversationBadge: true })
      expect(updated.conversationBadge).toBe(true)
      expect(store.get().conversationBadge).toBe(true)

      // Another store instance reads the persisted value
      const store2 = new UiPrefsStore(file)
      expect(store2.get().conversationBadge).toBe(true)

      // Toggle detailedQuotaReset on
      const withDetailed = store.set({ detailedQuotaReset: true })
      expect(withDetailed.detailedQuotaReset).toBe(true)
      expect(store2.get().detailedQuotaReset).toBe(true)

      // Toggle back off
      const turnedOff = store.set({ conversationBadge: false, detailedQuotaReset: false })
      expect(turnedOff.conversationBadge).toBe(false)
      expect(turnedOff.detailedQuotaReset).toBe(false)
      expect(store2.get().conversationBadge).toBe(false)
      expect(store2.get().detailedQuotaReset).toBe(false)
    } finally {
      if (existsSync(file)) rmSync(file)
    }
  })

  it('persists the refresh interval and its "never" state across instances', () => {
    const file = join(tmpdir(), `agy-ui-prefs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      const store = new UiPrefsStore(file)
      expect(store.get().quotaRefreshMinutes).toBe(DEFAULT_QUOTA_REFRESH_MINUTES)

      const custom = store.set({ quotaRefreshMinutes: 15 })
      expect(custom.quotaRefreshMinutes).toBe(15)
      // Setting an unrelated flag must NOT collapse the stored interval back
      // to the default — that is the silent-pref-reset regression.
      expect(store.set({ conversationBadge: true }).quotaRefreshMinutes).toBe(15)
      expect(new UiPrefsStore(file).get().quotaRefreshMinutes).toBe(15)

      const never = store.set({ quotaRefreshMinutes: null })
      expect(never.quotaRefreshMinutes).toBeNull()
      expect(new UiPrefsStore(file).get().quotaRefreshMinutes).toBeNull()
      // A partial set carries the null through too.
      expect(store.set({ detailedQuotaReset: true }).quotaRefreshMinutes).toBeNull()
    } finally {
      if (existsSync(file)) rmSync(file)
    }
  })
})
