/**
 * Model visibility: a per-provider blacklist of model ids hidden from the DSH
 * model selector.
 *
 * Mechanism: DSH's selector reads `session.modelCatalog`, which calls
 * `ctx.llm.listModels(provider)` -> `AgyAdapter.listModels()`. Filtering inside
 * the adapter is therefore sufficient to hide a model from the picker without
 * touching DSH — no host patch, no new RPC.
 *
 * Two deliberate choices:
 *
 * - Blacklist, not whitelist. Only explicitly-disabled models are hidden, so a
 *   model the server adds later still shows up. A whitelist would silently hide
 *   every new model until the user re-enabled it.
 * - Persisted to agy's own file rather than a `ctx.settings` namespace. The
 *   settings service requires a `@deepseek-ai/schemastery` schema, and the
 *   standalone CLI must not import any `@deepseek-ai/*` package at runtime
 *   (AGENTS.md invariant). agy already owns plain JSON state with the same
 *   atomic-write pattern (`agy-accounts.json`), so this stays consistent and
 *   lets the CLI read the same blacklist.
 *
 * Only `true` counts as disabled; an id maps to `true` or is absent. Enabling
 * deletes the key, so the file holds just the hidden set and cannot grow with
 * every toggle.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateToAgyDir } from './store/paths.ts'

export const MODELS_VERSION = 1

/** `provider -> modelId -> true`. */
export type DisabledModelMap = Record<string, Record<string, true>>

export interface ModelVisibilityDocument {
  version: number
  disabled: DisabledModelMap
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>()

/** Keep only well-formed `provider -> { modelId: true }` entries (tolerates hand edits). */
export function sanitizeDisabledModels(raw: unknown): DisabledModelMap {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: DisabledModelMap = {}
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const perProvider: Record<string, true> = {}
    for (const [modelId, flag] of Object.entries(value as Record<string, unknown>)) {
      if (flag === true) perProvider[modelId] = true
    }
    if (Object.keys(perProvider).length > 0) out[provider] = perProvider
  }
  return out
}

export function parseModelVisibility(text: string): ModelVisibilityDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: MODELS_VERSION, disabled: {} }
  }
  const disabled = typeof raw === 'object' && raw !== null
    ? sanitizeDisabledModels((raw as Record<string, unknown>).disabled)
    : {}
  return { version: MODELS_VERSION, disabled }
}

export interface ModelVisibilityOptions {
  /**
   * Defaults to `$DSH_HOME/agy/agy-models.json`, migrating the legacy
   * `$DSH_HOME/agy-models.json` by one-shot rename (see `migrateToAgyDir`).
   */
  file?: string
}

/**
 * In-memory authoritative copy of the blacklist, backed by a JSON file.
 *
 * The adapter calls `disabledFor()` on every `listModels()`, so that read is a
 * pure in-memory lookup: a toggle takes effect on the next catalog refresh
 * without rebuilding the adapter or restarting the host. Writes go through the
 * file immediately (toggles are rare, user-initiated).
 *
 * `disabledFor()` also revalidates against the file's mtime and reloads when it
 * moved. Two instances of this class routinely coexist in ONE process — the
 * main plugin entry and the web entry each build their own runtime — and a
 * toggle is written by the web instance while the model selector reads the main
 * instance. Without the mtime check the selector would keep serving its stale
 * in-memory copy, so switching a model off appeared to do nothing until the
 * host restarted (the `llm/adapters-updated` notification fires, the picker
 * refreshes, and the model is still listed). The same check is what lets a CLI
 * toggle be seen by a running server.
 */
export class ModelVisibility {
  private readonly file: string
  private disabled: DisabledModelMap
  /** Raw text this instance last read or wrote; see `reloadIfChanged`. */
  private raw: string
  /** Reusable frozen empty set, so the common "nothing disabled" read allocates nothing. */
  private readonly sets = new Map<string, ReadonlySet<string>>()

  constructor(options: ModelVisibilityOptions = {}) {
    this.file = options.file ?? migrateToAgyDir('agy-models.json').file
    const initial = this.readWithRaw()
    this.disabled = initial.disabled
    this.raw = initial.raw
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /** The exact bytes `write()` would persist, so `raw` can track what this instance wrote. */
  private static serialize(next: DisabledModelMap): string {
    const doc: ModelVisibilityDocument = { version: MODELS_VERSION, disabled: next }
    return JSON.stringify(doc, null, 2) + '\n'
  }

  /**
   * Read the map together with the raw text it came from.
   *
   * The TEXT (not an mtime) is what detects another writer's change. An mtime
   * cannot: a toggle and a re-read can land in the same filesystem timestamp
   * tick, and Windows resolves that coarsely enough to have failed CI — two
   * distinct writes reported an identical mtime, so the second change was never
   * seen and a disabled model stayed selectable. Content comparison cannot miss
   * a change, whatever the clock resolution.
   */
  private readWithRaw(): { disabled: DisabledModelMap, raw: string } {
    try {
      const raw = readFileSync(this.file, 'utf8')
      return { disabled: parseModelVisibility(raw).disabled, raw }
    } catch {
      // A missing or unreadable file means "nothing disabled".
      return { disabled: {}, raw: '' }
    }
  }

  private write(next: DisabledModelMap): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, ModelVisibility.serialize(next), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /**
   * Disabled model ids for one provider. Cheap enough for every catalog refresh:
   * one `stat` plus an in-memory map lookup, and the stat is what keeps two
   * same-process instances (and a CLI writer) in agreement.
   */
  disabledFor(provider: string): ReadonlySet<string> {
    this.reloadIfChanged()
    const cacheKey = provider
    const cached = this.sets.get(cacheKey)
    if (cached !== undefined) return cached
    const perProvider = this.disabled[provider]
    if (perProvider === undefined) return EMPTY_SET
    const ids = Object.keys(perProvider)
    if (ids.length === 0) return EMPTY_SET
    const set: ReadonlySet<string> = new Set(ids)
    this.sets.set(cacheKey, set)
    return set
  }

  /** Whether one model is currently hidden. Also revalidates, for the same reason. */
  isDisabled(provider: string, modelId: string): boolean {
    this.reloadIfChanged()
    return this.disabled[provider]?.[modelId] === true
  }

  /** The raw map, for the settings UI. */
  all(): DisabledModelMap {
    const out: DisabledModelMap = {}
    for (const [provider, models] of Object.entries(this.disabled)) out[provider] = { ...models }
    return out
  }

  /**
   * Hide or show one model. Persists immediately.
   *
   * The edit is applied to a freshly re-read map, not to this instance's copy:
   * with two instances in one process (main plugin + web entry) and a CLI in
   * another, editing the stale copy would silently drop whatever the other
   * writer had toggled since this instance last read. Toggles are rare and
   * user-initiated, so a read-modify-write costs nothing here — unlike the
   * ledger, this is not a hot path.
   *
   * Not locked: a simultaneous toggle from two processes can still lose one of
   * the two updates. The write itself is atomic (tmp + rename), so the file is
   * never corrupt — losing one toggle under a genuine race is an acceptable
   * trade for not introducing a lock file into a settings toggle.
   */
  setDisabled(provider: string, modelId: string, disabled: boolean): void {
    this.setDisabledMany(provider, [{ modelId, disabled }])
  }

  /** Apply one user action affecting a family and its legacy tiers atomically. */
  setDisabledMany(provider: string, updates: readonly { modelId: string; disabled: boolean }[]): void {
    if (updates.some(({ modelId }) => modelId === '')) throw new Error('setDisabled: modelId must not be empty')
    if (updates.length === 0) return
    this.reload()
    const next: DisabledModelMap = {}
    for (const [key, models] of Object.entries(this.disabled)) next[key] = { ...models }
    const perProvider = { ...(next[provider] ?? {}) }
    for (const { modelId, disabled } of updates) {
      if (disabled) perProvider[modelId] = true
      else delete perProvider[modelId]
    }
    if (Object.keys(perProvider).length === 0) delete next[provider]
    else next[provider] = perProvider
    this.write(next)
    this.disabled = next
    this.raw = ModelVisibility.serialize(next)
    // Drop the memoized set for this provider so the next read reflects the write.
    this.sets.delete(provider)
  }

  /** Re-read the file (multi-process: another writer may have toggled a model). */
  reload(): void {
    const fresh = this.readWithRaw()
    this.disabled = fresh.disabled
    this.raw = fresh.raw
    this.sets.clear()
  }

  /**
   * Reload when the file's contents differ from what this instance last read.
   *
   * Reads rather than stats: `disabledFor()` runs once per catalog refresh, not
   * per request, and the call it feeds is a network request to the model
   * endpoint — one small local read is not the cost that matters here, while a
   * missed change is the bug this whole mechanism exists to prevent.
   */
  private reloadIfChanged(): void {
    let current: string
    try {
      current = readFileSync(this.file, 'utf8')
    } catch {
      // Missing/unreadable: treat as empty, matching `readWithRaw`.
      current = ''
    }
    if (current === this.raw) return
    this.reload()
  }
}
