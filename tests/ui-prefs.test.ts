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

describe('ui-prefs parser and sanitizer', () => {
  it('sanitizes empty / invalid raw input to default document', () => {
    expect(sanitizeUiPrefs(null)).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs([])).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs('string')).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs({})).toEqual({ version: UI_PREFS_VERSION })
    expect(sanitizeUiPrefs({ conversationBadge: 'yes' })).toEqual({ version: UI_PREFS_VERSION })
  })

  it('keeps valid boolean flags', () => {
    expect(sanitizeUiPrefs({ conversationBadge: true })).toEqual({
      version: UI_PREFS_VERSION,
      conversationBadge: true,
    })
    expect(sanitizeUiPrefs({ conversationBadge: false })).toEqual({
      version: UI_PREFS_VERSION,
      conversationBadge: false,
    })
  })

  it('parses malformed json softly', () => {
    expect(parseUiPrefs('{ bad json')).toEqual({ version: UI_PREFS_VERSION })
  })
})

describe('UiPrefsStore', () => {
  it('returns default view when file does not exist', () => {
    const file = join(tmpdir(), `agy-ui-prefs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    try {
      const store = new UiPrefsStore(file)
      expect(store.get()).toEqual({ conversationBadge: false })
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

      // Toggle back off
      const turnedOff = store.set({ conversationBadge: false })
      expect(turnedOff.conversationBadge).toBe(false)
      expect(store2.get().conversationBadge).toBe(false)
    } finally {
      if (existsSync(file)) rmSync(file)
    }
  })
})
