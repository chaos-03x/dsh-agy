/**
 * User-Agent profile store: which client identity this install presents.
 *
 * WHY THIS EXISTS. The UA is not cosmetic on this channel — the upstream gates
 * on its SHAPE *and* reads its VERSION LINE, and the two products sit on
 * disjoint namespaces (hub `2.x` vs CLI `1.5.x`). Measured on one
 * account, one model, one prompt (2026-11-09):
 *
 *   hub 2.29.1   -> generation 200 + finishReason · quota 2 groups
 *   hub 2.6.0    -> generation 200 + finishReason · quota 2 groups
 *   hub 1.5.3    -> generation 200 + "no longer supported" · quota 1 group
 *   antigravity/cli/<v> -> generation 200 + finishReason · quota 2 groups
 *
 * Two INDEPENDENT failures follow from getting that wrong, which is why a
 * profile carries the shape and its version line together:
 *
 * - Below the version floor the data plane answers 200 with the retirement
 *   notice and no `finishReason` (`parse.ts` reports `AgyClientRetiredError`).
 * - The hub line's version is what makes `retrieveUserQuotaSummary` return
 *   the `Gemini Models` group at all: a `1.x` hub string (or the CLI
 *   string used as the BOOTSTRAP identity) gets only `Claude and GPT models`
 *   back. That is the "Gemini quota does not show" symptom verbatim — the card
 *   and the header badge render one group and look broken.
 *
 * The default is the HUB profile (this product's own desktop app), per the
 * product decision that this client should present as the app rather than the
 * CLI.
 *
 * Persisted to agy's own JSON rather than `ctx.settings`, for the reason
 * recorded in `model-visibility.ts`: that service needs a
 * `@deepseek-ai/schemastery` schema, and the CLI must not import any
 * `@deepseek-ai/*` package at runtime. Same atomic-write and content-compare
 * reload pattern as `thinking-budget.ts`, so a writer in one process (the web
 * entry) is seen by a reader in another (the main plugin).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { migrateToAgyDir } from './store/paths.ts'
import {
  agyCliUserAgent,
  agyHubUserAgent,
  currentCliVersion,
  currentHubVersion,
  setProfileUserAgentRenderer,
} from './oauth/constants.ts'
import { DEFAULT_REVALIDATE_INTERVAL_MS } from './thinking-budget.ts'
import {
  HUB_VERSION_FALLBACK,
  HUB_VERSION_LINE,
  UA_PROFILE_CLI,
  UA_PROFILE_HUB,
  UA_PROFILE_VERSION,
  UA_TEMPLATE_PLATFORM_TOKEN,
  UA_TEMPLATE_VERSION_TOKEN,
  isValidUaTemplate,
} from './ua-profile-types.ts'
import type {
  UaCustomProfile,
  UaProfileDocument,
  UaProfileKind,
  UaProfileView,
  UaProfileViewResult,
} from './ua-profile-types.ts'

export const UA_PROFILE_FILE = 'agy-ua-profile.json'

/** Platform token this client advertises: the Go-style pair the UA vocabulary uses. */
export const DEFAULT_UA_PLATFORM = 'darwin/arm64'

export {
  HUB_VERSION_FALLBACK,
  HUB_VERSION_FLOOR,
  HUB_VERSION_LINE,
  UA_PROFILE_CLI,
  UA_PROFILE_HUB,
  UA_PROFILE_KINDS,
  UA_PROFILE_VERSION,
} from './ua-profile-types.ts'
export type {
  UaCustomProfile,
  UaProfileDocument,
  UaProfileKind,
  UaProfileView,
  UaProfileViewResult,
} from './ua-profile-types.ts'

/** Fill a custom template's placeholders. */
export function renderUaTemplate(template: string, version: string, platform = DEFAULT_UA_PLATFORM): string {
  return template
    .split(UA_TEMPLATE_VERSION_TOKEN).join(version)
    .split(UA_TEMPLATE_PLATFORM_TOKEN).join(platform)
}

/** Whether a profile id names a built-in. */
export function isBuiltinUaProfile(id: string): boolean {
  return id === UA_PROFILE_HUB || id === UA_PROFILE_CLI
}

/** The kind a profile id names; `custom` otherwise. */
export function uaProfileKind(id: string): UaProfileKind {
  if (id === UA_PROFILE_HUB) return 'hub'
  if (id === UA_PROFILE_CLI) return 'cli'
  return 'custom'
}

/** The version line a profile id draws from. */
export function uaProfileVersionLine(id: string): string {
  if (id === UA_PROFILE_HUB) return HUB_VERSION_LINE
  if (id === UA_PROFILE_CLI) return '1.x'
  return 'custom'
}

/**
 * The version an arbitrary line token resolves to.
 *
 * Only the two lines this client actually claims can be resolved; a custom
 * profile naming anything else falls back to the hub version, because a
 * custom shape is by definition an experiment and an unresolvable line must
 * still produce a servable string.
 */
function versionForLine(line: string): string {
  if (line === HUB_VERSION_LINE) return currentHubVersion()
  if (line === '1.x' || line === 'cli') return currentCliVersion()
  return currentHubVersion()
}

/** Move any well-formed custom profile through, dropping unusable ones. */
export function sanitizeCustomProfiles(raw: unknown): Record<string, UaCustomProfile> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, UaCustomProfile> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    // A built-in id is not redefinable: letting a custom profile squat on
    // `hub` would make "switch back to the built-in" a no-op.
    if (isBuiltinUaProfile(id)) continue
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue
    const template = entry.template
    if (!isValidUaTemplate(template)) continue
    const label = typeof entry.label === 'string' && entry.label.trim() !== ''
      ? entry.label.trim().slice(0, 60)
      : id
    const versionLine = typeof entry.versionLine === 'string' && entry.versionLine !== ''
      ? entry.versionLine.slice(0, 16)
      : 'custom'
    out[id] = { label, template, versionLine }
  }
  return out
}

export function parseUaProfileDocument(text: string): UaProfileDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: UA_PROFILE_VERSION, active: UA_PROFILE_HUB, custom: {} }
  }
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const custom = sanitizeCustomProfiles(record.custom)
  // An `active` naming a profile that no longer exists falls back to the
  // default rather than leaving the client with no identity at all.
  const candidate = typeof record.active === 'string' ? record.active : ''
  const active = isBuiltinUaProfile(candidate)
    ? candidate
    : (candidate !== '' && custom[candidate] !== undefined ? candidate : UA_PROFILE_HUB)
  return { version: UA_PROFILE_VERSION, active, custom }
}

export interface UaProfileOptions {
  /**
   * Defaults to `$DSH_HOME/agy/agy-ua-profile.json`, migrating any legacy file
   * by one-shot rename (see `migrateToAgyDir`).
   */
  file?: string
  /** Hot-path revalidation throttle; `0` disables it. */
  revalidateIntervalMs?: number
}

/**
 * In-memory authoritative copy of the profile, backed by a JSON file.
 *
 * `userAgent()` sits on the generation hot path (a header set is assembled per
 * request), so the cross-instance revalidation is rate-limited exactly as
 * `ThinkingBudgetStore` does it, and the WRITE path bypasses the limit so a
 * concurrent edit is never merged into a stale copy.
 */
export class UaProfileStore {
  private readonly file: string
  private readonly revalidateIntervalMs: number
  private doc: UaProfileDocument
  private raw: string
  private checkedAt: number

  constructor(options: UaProfileOptions = {}) {
    this.file = options.file ?? migrateToAgyDir(UA_PROFILE_FILE).file
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

  private static serialize(doc: UaProfileDocument): string {
    return JSON.stringify(doc, null, 2) + '\n'
  }

  private readWithRaw(): { doc: UaProfileDocument, raw: string } {
    try {
      const raw = readFileSync(this.file, 'utf8')
      return { doc: parseUaProfileDocument(raw), raw }
    } catch {
      return { doc: { version: UA_PROFILE_VERSION, active: UA_PROFILE_HUB, custom: {} }, raw: '' }
    }
  }

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

  private reloadIfChanged(): void {
    if (Date.now() - this.checkedAt < this.revalidateIntervalMs) return
    this.reloadNow()
  }

  private write(mutate: (doc: UaProfileDocument) => void): void {
    this.reloadNow()
    const next: UaProfileDocument = {
      version: UA_PROFILE_VERSION,
      active: this.doc.active,
      custom: { ...this.doc.custom },
    }
    mutate(next)
    const text = UaProfileStore.serialize(next)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, this.file)
    this.doc = next
    this.raw = text
  }

  /** Id of the profile in force. */
  activeId(): string {
    this.reloadIfChanged()
    return this.doc.active
  }

  /** The active profile's kind. */
  activeKind(): UaProfileKind {
    return uaProfileKind(this.activeId())
  }

  /** The version line the active profile draws from. */
  activeVersionLine(): string {
    const id = this.activeId()
    if (isBuiltinUaProfile(id)) return uaProfileVersionLine(id)
    const custom = this.doc.custom[id]
    return custom?.versionLine ?? HUB_VERSION_LINE
  }

  /**
   * The active profile's version, resolved for ITS OWN line.
   *
   * This is the load-bearing part: the caller must never hand a CLI-line
   * number to the hub shape or vice versa, because a mismatched pair is
   * exactly what produces the retirement notice and the missing Gemini group.
   */
  activeVersion(): string {
    return versionForLine(this.activeVersionLine())
  }

  /** One custom profile, when it exists. */
  customProfile(id: string): UaCustomProfile | undefined {
    this.reloadIfChanged()
    return this.doc.custom[id]
  }

  /**
   * Render the UA for the active profile.
   *
   * @param options.platform - platform token; defaults to the recorded pair.
   * @param options.version - override the version (callers that already
   *   resolved the CORRECT line; used by the fingerprint migration, which must
   *   preserve the version a stored identity already had).
   */
  userAgent(options: { version?: string, platform?: string } = {}): string {
    this.reloadIfChanged()
    const platform = options.platform ?? DEFAULT_UA_PLATFORM
    const id = this.doc.active
    if (id === UA_PROFILE_HUB) {
      return agyHubUserAgent(options.version ?? currentHubVersion(), platform)
    }
    if (id === UA_PROFILE_CLI) {
      return agyCliUserAgent(options.version ?? currentCliVersion(), platform)
    }
    const custom = this.doc.custom[id]
    if (custom === undefined) {
      // The file named a profile that vanished between reload and render; the
      // default is a valid identity, inventing one would not be.
      return agyHubUserAgent(options.version ?? currentHubVersion(), platform)
    }
    return renderUaTemplate(custom.template, options.version ?? versionForLine(custom.versionLine), platform)
  }

  /** Every selectable profile, for the settings card. */
  profiles(options: { platform?: string } = {}): UaProfileView[] {
    this.reloadIfChanged()
    const platform = options.platform ?? DEFAULT_UA_PLATFORM
    const views: UaProfileView[] = [
      {
        id: UA_PROFILE_HUB,
        kind: 'hub',
        label: 'Antigravity Hub',
        versionLine: HUB_VERSION_LINE,
        example: agyHubUserAgent(currentHubVersion(), platform),
      },
      {
        id: UA_PROFILE_CLI,
        kind: 'cli',
        label: 'Antigravity CLI (agy)',
        versionLine: '1.x',
        example: agyCliUserAgent(currentCliVersion(), platform),
      },
    ]
    for (const [id, custom] of Object.entries(this.doc.custom)) {
      views.push({
        id,
        kind: 'custom',
        label: custom.label,
        versionLine: custom.versionLine,
        example: renderUaTemplate(custom.template, versionForLine(custom.versionLine), platform),
      })
    }
    return views
  }

  /**
   * What the settings card renders.
   *
   * `versionSource` distinguishes a live-resolved version from the shipped
   * floor, so a stale-looking number is attributable to a failed feed read
   * rather than to the profile.
   */
  view(options: { platform?: string, versionSource?: 'live' | 'fallback' } = {}): UaProfileViewResult {
    const platform = options.platform ?? DEFAULT_UA_PLATFORM
    return {
      profiles: this.profiles({ platform }),
      active: this.activeId(),
      effective: this.userAgent({ platform }),
      versionSource: options.versionSource ?? 'fallback',
    }
  }

  /** Switch the active profile. Throws when the id names nothing. */
  setActive(id: string): UaProfileViewResult {
    this.write((doc) => {
      if (!isBuiltinUaProfile(id) && doc.custom[id] === undefined) {
        throw new Error(`unknown UA profile: ${id}`)
      }
      doc.active = id
    })
    return this.view()
  }

  /**
   * Create or replace a custom profile.
   *
   * Re-using an existing custom id replaces it in place (which is how a
   * template is edited), while a built-in id is refused because shadowing it
   * would break the switch-back path.
   */
  setCustom(input: {
    id: string
    label?: string
    template: string
    versionLine?: string
  }): UaProfileViewResult {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.id)) {
      throw new Error('UA profile id must match ^[a-z0-9][a-z0-9-]{0,31}$')
    }
    if (isBuiltinUaProfile(input.id)) {
      throw new Error(`"${input.id}" is a built-in profile and cannot be redefined`)
    }
    if (!isValidUaTemplate(input.template)) {
      throw new Error(
        `UA template must be 1-512 characters, contain ${UA_TEMPLATE_VERSION_TOKEN}, and carry no control characters`,
      )
    }
    const label = input.label?.trim().slice(0, 60) || input.id
    const versionLine = input.versionLine?.slice(0, 16) || 'custom'
    this.write((doc) => {
      doc.custom[input.id] = { label, template: input.template, versionLine }
    })
    return this.view()
  }

  /** Delete a custom profile; the active one falls back to the default. */
  deleteCustom(id: string): UaProfileViewResult {
    if (isBuiltinUaProfile(id)) throw new Error(`"${id}" is a built-in profile and cannot be deleted`)
    this.write((doc) => {
      delete doc.custom[id]
      if (doc.active === id) doc.active = UA_PROFILE_HUB
    })
    return this.view()
  }

  /** The raw document, for tests and export. */
  snapshot(): UaProfileDocument {
    this.reloadIfChanged()
    return { version: UA_PROFILE_VERSION, active: this.doc.active, custom: { ...this.doc.custom } }
  }
}

/**
 * Process-wide profile: the identity every UA builder reads.
 *
 * WHY A MODULE-LEVEL SINGLETON. UA construction happens in dependency leaves
 * (`runtime/fingerprint.ts`, the model/quota probes, the OAuth exchange) that
 * receive no runtime object, and threading a store through every call site
 * would either create a cycle or push the store into the CLI's dependency
 * graph. The store is therefore resolved ONCE, lazily, from the default path —
 * and because the file is content-compared on the hot path, a settings write in
 * the web entry is visible to the main plugin in the same process without any
 * wiring.
 */
let sharedProfile: UaProfileStore | undefined

/** The process-wide profile store (created on first use). */
export function uaProfileStore(): UaProfileStore {
  sharedProfile ??= new UaProfileStore()
  return sharedProfile
}

/**
 * Bind this module as the renderer behind `getAgyBootstrapUserAgent`.
 *
 * Registration happens at import time so it cannot be skipped by a code path
 * that builds a bootstrap UA before a store exists: the module IS the store's
 * home, so loading it is enough. It renders through the process-wide profile, so
 * a settings switch reaches the next bootstrap call in this process immediately
 * (the store content-compares its file on the hot path).
 */
setProfileUserAgentRenderer((version?: string) =>
  uaProfileStore().userAgent(version === undefined ? {} : { version }))

/** Test-only: replace or drop the process-wide store. */
export function _setUaProfileStoreForTest(store: UaProfileStore | undefined): void {
  sharedProfile = store
}

/**
 * The UA this process presents right now.
 *
 * ONE entry point for every surface that must not self-identify: generation
 * headers (via the fingerprint), model discovery, the quota summary probe, the
 * OAuth bootstrap calls, and the CLI's import enrichment. They must all agree,
 * because two different client strings from one process is the anomaly this
 * whole module exists to avoid — and on this channel a disagreement is also
 * functional: the quota endpoint returns a different GROUP SET per line.
 */
export function activeUserAgent(options: { version?: string, platform?: string } = {}): string {
  return uaProfileStore().userAgent(options)
}
