/**
 * UI preferences persistence: per-installation UI toggles stored in
 * `$DSH_HOME/agy/agy-ui-prefs.json`.
 *
 * Persisted to agy's own JSON file rather than `ctx.settings` to avoid
 * schemastery coupling and keep standalone access clean.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { agyDataFile } from './store/paths.ts'
import type { SetUiPrefsPayload, UiPrefsDocument, UiPrefsView } from './ui-prefs-types.ts'
import {
  DEFAULT_BADGE_DETAILED_MODE,
  DEFAULT_BADGE_MODEL_GROUP,
  DEFAULT_BADGE_SKIP_ZERO_WEEKLY,
  DEFAULT_BADGE_WINDOW_TYPE,
  quotaRefreshMinutesView,
  sanitizeQuotaRefreshMinutes,
} from './ui-prefs-types.ts'

export * from './ui-prefs-types.ts'

export const UI_PREFS_VERSION = 1
export const UI_PREFS_FILE = 'agy-ui-prefs.json'

export function sanitizeUiPrefs(raw: unknown): UiPrefsDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { version: UI_PREFS_VERSION }
  }
  const obj = raw as Record<string, unknown>
  const doc: UiPrefsDocument = { version: UI_PREFS_VERSION }
  if (typeof obj.conversationBadge === 'boolean') {
    doc.conversationBadge = obj.conversationBadge
  }
  if (typeof obj.detailedQuotaReset === 'boolean') {
    doc.detailedQuotaReset = obj.detailedQuotaReset
  }
  if (obj.quotaRefreshMinutes !== undefined) {
    const minutes = sanitizeQuotaRefreshMinutes(obj.quotaRefreshMinutes)
    if (minutes !== undefined) doc.quotaRefreshMinutes = minutes
  }
  if (typeof obj.badgeDetailedMode === 'boolean') {
    doc.badgeDetailedMode = obj.badgeDetailedMode
  }
  if (typeof obj.badgeModelGroup === 'string' && obj.badgeModelGroup.length > 0) {
    doc.badgeModelGroup = obj.badgeModelGroup
  }
  if (obj.badgeWindowType === 'both' || obj.badgeWindowType === '5h' || obj.badgeWindowType === 'weekly') {
    doc.badgeWindowType = obj.badgeWindowType
  }
  if (typeof obj.badgeSkipZeroWeekly === 'boolean') {
    doc.badgeSkipZeroWeekly = obj.badgeSkipZeroWeekly
  }
  return doc
}

export function parseUiPrefs(text: string): UiPrefsDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: UI_PREFS_VERSION }
  }
  return sanitizeUiPrefs(raw)
}

export class UiPrefsStore {
  readonly file: string
  private doc: UiPrefsDocument
  private raw: string

  constructor(file: string = agyDataFile(UI_PREFS_FILE)) {
    this.file = file
    const { doc, raw } = this.readWithRaw()
    this.doc = doc
    this.raw = raw
  }

  get(): UiPrefsView {
    this.reloadIfChanged()
    return {
      conversationBadge: this.doc.conversationBadge === true,
      detailedQuotaReset: this.doc.detailedQuotaReset === true,
      quotaRefreshMinutes: quotaRefreshMinutesView(this.doc),
      badgeDetailedMode: this.doc.badgeDetailedMode ?? DEFAULT_BADGE_DETAILED_MODE,
      badgeModelGroup: this.doc.badgeModelGroup ?? DEFAULT_BADGE_MODEL_GROUP,
      badgeWindowType: this.doc.badgeWindowType ?? DEFAULT_BADGE_WINDOW_TYPE,
      badgeSkipZeroWeekly: this.doc.badgeSkipZeroWeekly ?? DEFAULT_BADGE_SKIP_ZERO_WEEKLY,
    }
  }

  set(prefs: Partial<SetUiPrefsPayload>): UiPrefsView {
    this.reload()
    const next: UiPrefsDocument = {
      version: UI_PREFS_VERSION,
      ...(this.doc.conversationBadge !== undefined ? { conversationBadge: this.doc.conversationBadge } : {}),
      ...(this.doc.detailedQuotaReset !== undefined ? { detailedQuotaReset: this.doc.detailedQuotaReset } : {}),
      ...(this.doc.quotaRefreshMinutes !== undefined ? { quotaRefreshMinutes: this.doc.quotaRefreshMinutes } : {}),
      ...(this.doc.badgeDetailedMode !== undefined ? { badgeDetailedMode: this.doc.badgeDetailedMode } : {}),
      ...(this.doc.badgeModelGroup !== undefined ? { badgeModelGroup: this.doc.badgeModelGroup } : {}),
      ...(this.doc.badgeWindowType !== undefined ? { badgeWindowType: this.doc.badgeWindowType } : {}),
      ...(this.doc.badgeSkipZeroWeekly !== undefined ? { badgeSkipZeroWeekly: this.doc.badgeSkipZeroWeekly } : {}),
    }
    if (typeof prefs.conversationBadge === 'boolean') {
      next.conversationBadge = prefs.conversationBadge
    }
    if (typeof prefs.detailedQuotaReset === 'boolean') {
      next.detailedQuotaReset = prefs.detailedQuotaReset
    }
    const minutes = sanitizeQuotaRefreshMinutes(prefs.quotaRefreshMinutes)
    if (minutes !== undefined) {
      next.quotaRefreshMinutes = minutes
    }
    if (typeof prefs.badgeDetailedMode === 'boolean') {
      next.badgeDetailedMode = prefs.badgeDetailedMode
    }
    if (typeof prefs.badgeModelGroup === 'string' && prefs.badgeModelGroup.length > 0) {
      next.badgeModelGroup = prefs.badgeModelGroup
    }
    if (prefs.badgeWindowType === 'both' || prefs.badgeWindowType === '5h' || prefs.badgeWindowType === 'weekly') {
      next.badgeWindowType = prefs.badgeWindowType
    }
    if (typeof prefs.badgeSkipZeroWeekly === 'boolean') {
      next.badgeSkipZeroWeekly = prefs.badgeSkipZeroWeekly
    }
    this.write(next)
    this.doc = next
    this.raw = UiPrefsStore.serialize(next)
    return this.get()
  }

  reload(): void {
    const fresh = this.readWithRaw()
    this.doc = fresh.doc
    this.raw = fresh.raw
  }

  private reloadIfChanged(): void {
    let current: string
    try {
      current = readFileSync(this.file, 'utf8')
    } catch {
      current = ''
    }
    if (current === this.raw) return
    this.reload()
  }

  private readWithRaw(): { doc: UiPrefsDocument; raw: string } {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return { doc: { version: UI_PREFS_VERSION }, raw: '' }
    }
    return { doc: parseUiPrefs(text), raw: text }
  }

  private write(doc: UiPrefsDocument): void {
    const serialized = UiPrefsStore.serialize(doc)
    const tmp = `${this.file}.tmp.${process.pid}.${Date.now()}`
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(tmp, serialized, { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  static serialize(doc: UiPrefsDocument): string {
    return `${JSON.stringify(doc, null, 2)}\n`
  }
}
