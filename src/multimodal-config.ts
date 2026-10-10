/**
 * The per-file inline cap for non-image multimodal files (see
 * `adapter/multimodal.ts`), as one editable number.
 *
 * WHY ONE GLOBAL NUMBER AND NOT A PER-MODEL ROW. The cap is a property of the
 * request-body path, not of a model: `resolveMultimodalFiles` reads a file into
 * a base64 `inlineData` part and the upstream refuses the body once it is too
 * large, so the only knob is "how large a file may be inlined at all". Every
 * Gemini model shares it; Claude never inlines non-image files.
 *
 * Persisted to agy's own JSON rather than `ctx.settings`, for the reason
 * recorded in `model-visibility.ts`: that service needs a
 * `@deepseek-ai/schemastery` schema, and the CLI must not import
 * `@deepseek-ai/*` at runtime. Same atomic-write and content-compare reload
 * pattern as `thinking-budget.ts`, so a writer in one process (the web entry) is
 * seen by a reader in another (the main plugin).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateToAgyDir } from './store/paths.ts'
import {
  MULTIMODAL_DEFAULT_MB,
  MULTIMODAL_MAX_MB,
  MULTIMODAL_MIN_MB,
  MULTIMODAL_VERSION,
  isValidMultimodalMb,
} from './multimodal-types.ts'
import type { MultimodalDocument, MultimodalSource, MultimodalView } from './multimodal-types.ts'
import { DEFAULT_REVALIDATE_INTERVAL_MS } from './thinking-budget.ts'

export const MULTIMODAL_FILE = 'agy-multimodal.json'

export {
  MULTIMODAL_DEFAULT_MB,
  MULTIMODAL_MAX_MB,
  MULTIMODAL_MIN_MB,
  MULTIMODAL_VERSION,
  isValidMultimodalMb,
} from './multimodal-types.ts'
export type { MultimodalDocument, MultimodalSource, MultimodalView } from './multimodal-types.ts'

/** Environment override for the cap, in MB. */
export const MULTIMODAL_ENV_VAR = 'DSH_AGY_MULTIMODAL_MAX_INLINE_MB'

/**
 * Rebuild the document, keeping only fields that are set.
 *
 * ONE place builds a document, so `parse`/`snapshot`/`write` cannot disagree
 * about which fields exist: `thinking-budget.ts` spells its document out in each
 * of the three, and a field added to only two of them is silently dropped by the
 * third (that is why its `write` and `snapshot` both enumerate `claudeBudget`
 * and `tieredBudget` by hand). `undefined` is dropped rather than serialized as
 * `null`, so "unset" has exactly one on-disk form.
 */
function toDocument(doc: MultimodalDocument): MultimodalDocument {
  return {
    version: MULTIMODAL_VERSION,
    ...(doc.maxInlineMb === undefined ? {} : { maxInlineMb: doc.maxInlineMb }),
  }
}

/**
 * Keep the stored value only when it is usable (tolerates hand edits).
 *
 * Dropped rather than clamped: a clamped cap would silently inline files the
 * user asked to keep out, and the fallback — no stored value — is a valid state
 * that simply means the built-in default.
 */
export function sanitizeMultimodalDocument(raw: unknown): MultimodalDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return toDocument({ version: MULTIMODAL_VERSION })
  }
  const value = (raw as Record<string, unknown>).maxInlineMb
  return toDocument({
    version: MULTIMODAL_VERSION,
    ...(isValidMultimodalMb(value) ? { maxInlineMb: value } : {}),
  })
}

export function parseMultimodalDocument(text: string): MultimodalDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return toDocument({ version: MULTIMODAL_VERSION })
  }
  return sanitizeMultimodalDocument(raw)
}

/**
 * The env override, or undefined when unset or unusable.
 *
 * `DSH_AGY_*` rather than `AGY_*`: that prefix is this plugin's own runtime
 * knobs (`risk.ts`'s kill switch and fingerprint mode, `plugin-common.ts`'s
 * health-probe interval), while `AGY_CLIENT_ID`/`AGY_CLIENT_SECRET` are the
 * OAuth client-credential namespace — a knob that changes request behavior
 * belongs to the former.
 *
 * This is the codebase's first NUMERIC env knob, and it inherits `envFlag`'s
 * posture: anything not recognized yields the fallback (here "no override")
 * rather than throwing or warning, because the fallback chain (store, then
 * default) is always a valid state. Recognized means a plain decimal integer —
 * `30MB`, `1.5` and `1e2` are ignored rather than guessed at, so the value that
 * takes effect is the one written.
 *
 * Read per call, not cached at module load, so a test (or a process that sets it
 * late) sees the change without a restart.
 */
function envMaxInlineMb(): number | undefined {
  const raw = process.env[MULTIMODAL_ENV_VAR]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const value = Number(trimmed)
  return isValidMultimodalMb(value) ? value : undefined
}

export interface MultimodalConfigOptions {
  /**
   * Defaults to `$DSH_HOME/agy/agy-multimodal.json`, migrating the legacy
   * `$DSH_HOME/agy-multimodal.json` by one-shot rename (see `migrateToAgyDir`).
   */
  file?: string
  /**
   * Minimum gap between hot-path file revalidations. Defaults to
   * `DEFAULT_REVALIDATE_INTERVAL_MS`; `0` disables throttling (useful in tests
   * that need a cross-instance write visible immediately).
   */
  revalidateIntervalMs?: number
}

/**
 * In-memory authoritative copy of the cap, backed by a JSON file.
 *
 * `maxInlineBytes` sits on the GENERATION HOT PATH (the adapter resolves the cap
 * for every request), so the cross-instance revalidation it needs is
 * rate-limited — the same window, shared with `thinking-budget.ts` rather than
 * re-declared: two settings read on one hot path should not drift into two
 * different staleness bounds. Writes go to the file immediately and bypass the
 * limit so a concurrent edit is never merged into a stale copy.
 *
 * No file lock: a settings write is atomic (tmp+rename) and the accepted loss is
 * one concurrent toggle, which is the same trade `thinking-budget.ts` makes.
 */
export class MultimodalConfigStore {
  private readonly file: string
  private readonly revalidateIntervalMs: number
  private doc: MultimodalDocument
  /** Raw text this instance last read or wrote; see `reloadNow`. */
  private raw: string
  /** When `reloadNow` last ran, for the hot-path throttle. */
  private checkedAt: number

  constructor(options: MultimodalConfigOptions = {}) {
    this.file = options.file ?? migrateToAgyDir(MULTIMODAL_FILE).file
    this.revalidateIntervalMs = options.revalidateIntervalMs ?? DEFAULT_REVALIDATE_INTERVAL_MS
    const initial = this.readWithRaw()
    this.doc = initial.doc
    this.raw = initial.raw
    this.checkedAt = Date.now()
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  private static serialize(doc: MultimodalDocument): string {
    return JSON.stringify(doc, null, 2) + '\n'
  }

  /**
   * Read the document together with the raw text it came from.
   *
   * Content, not mtime: two writers can land in the same filesystem timestamp
   * tick (Windows resolves it coarsely enough to have failed CI in this repo),
   * and a missed change is exactly the bug this check exists to prevent. A
   * missing or unreadable file means "nothing configured" — and must NOT create
   * it, because a settings read runs in processes that never write.
   */
  private readWithRaw(): { doc: MultimodalDocument, raw: string } {
    try {
      const raw = readFileSync(this.file, 'utf8')
      return { doc: parseMultimodalDocument(raw), raw }
    } catch {
      return { doc: toDocument({ version: MULTIMODAL_VERSION }), raw: '' }
    }
  }

  /**
   * Re-read the file if another writer changed it.
   *
   * Unconditional — callers on the hot path use `reloadIfChanged` instead.
   */
  private reloadNow(): void {
    let current: string
    try {
      current = readFileSync(this.file, 'utf8')
    } catch {
      current = ''
    }
    this.checkedAt = Date.now()
    if (current === this.raw) return
    const fresh = this.readWithRaw()
    this.doc = fresh.doc
    this.raw = fresh.raw
  }

  /**
   * Hot-path revalidation: `reloadNow`, rate-limited.
   *
   * Without the limit every generation pays a blocking `readFileSync` plus a
   * UTF-8 decode for a value that changes only when a user saves the settings
   * card, so the worst case here is that a change takes up to
   * `revalidateIntervalMs` to reach an already-running adapter — the right trade
   * for a setting, and not right for the write path, which is why `write` calls
   * `reloadNow` directly.
   */
  private reloadIfChanged(): void {
    if (Date.now() - this.checkedAt < this.revalidateIntervalMs) return
    this.reloadNow()
  }

  /**
   * Write the whole document atomically.
   *
   * Always re-reads first, so a concurrent edit by the OTHER instance in this
   * process (main plugin + web entry) is merged rather than overwritten: the
   * caller passes a mutation, not a full replacement built from a stale copy.
   */
  private write(mutate: (doc: MultimodalDocument) => void): void {
    // Unconditional: building on a throttled-skipped stale copy would drop the
    // other instance's concurrent edit, which is the whole reason for re-reading.
    this.reloadNow()
    const next = toDocument(this.doc)
    mutate(next)
    const text = MultimodalConfigStore.serialize(next)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, this.file)
    this.doc = next
    this.raw = text
  }

  /** The STORED cap in MB, or undefined when nothing is stored. */
  maxInlineMb(): number | undefined {
    this.reloadIfChanged()
    return this.doc.maxInlineMb
  }

  /**
   * The cap actually in force: env overrides the stored value, which overrides
   * the built-in default.
   *
   * The env var is read HERE rather than at construction so the override is
   * live for a long-running process and flippable in a test.
   */
  effectiveMaxInlineMb(): { value: number, source: MultimodalSource } {
    const fromEnv = envMaxInlineMb()
    if (fromEnv !== undefined) return { value: fromEnv, source: 'env' }
    const stored = this.maxInlineMb()
    if (stored !== undefined) return { value: stored, source: 'stored' }
    return { value: MULTIMODAL_DEFAULT_MB, source: 'default' }
  }

  /** The effective cap in bytes, as the multimodal resolver wants it. */
  maxInlineBytes(): number {
    return this.effectiveMaxInlineMb().value * 1024 * 1024
  }

  /**
   * The settings state: the stored value (null when unset) plus which source is
   * effective. See `MultimodalView` for why the two are separate fields.
   */
  snapshot(): MultimodalView {
    const stored = this.maxInlineMb()
    return {
      value: stored ?? null,
      source: this.effectiveMaxInlineMb().source,
      max: MULTIMODAL_MAX_MB,
    }
  }

  /** Replace the cap, or clear it when `value` is undefined. */
  setMaxInlineMb(value: number | undefined): MultimodalView {
    if (value !== undefined && !isValidMultimodalMb(value)) {
      throw new Error(
        `multimodal inline cap must be an integer in [${MULTIMODAL_MIN_MB}, ${MULTIMODAL_MAX_MB}] MB`,
      )
    }
    this.write((doc) => {
      if (value === undefined) delete doc.maxInlineMb
      else doc.maxInlineMb = value
    })
    return this.snapshot()
  }
}
