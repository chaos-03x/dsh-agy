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
    }
  }

  set(prefs: Partial<SetUiPrefsPayload>): UiPrefsView {
    this.reload()
    const next: UiPrefsDocument = {
      version: UI_PREFS_VERSION,
      ...(this.doc.conversationBadge !== undefined ? { conversationBadge: this.doc.conversationBadge } : {}),
    }
    if (typeof prefs.conversationBadge === 'boolean') {
      next.conversationBadge = prefs.conversationBadge
    }
    this.write(next)
    this.doc = next
    this.raw = UiPrefsStore.serialize(next)
    return {
      conversationBadge: next.conversationBadge === true,
    }
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
