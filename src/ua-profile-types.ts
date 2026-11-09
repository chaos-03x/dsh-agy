/**
 * User-Agent profile vocabulary shared by the host store, the RPC wire
 * contract, and the browser UI.
 *
 * Split out for the same reason `thinking-types.ts` and `multimodal-types.ts`
 * are: these declarations live on their own, free of any `node:*` import, so
 * the browser bundle can describe the settings surface without reaching the
 * host's storage module through `rpc-contract.ts` (which the client
 * typechecks).
 *
 * WHY A PROFILE AND NOT A SINGLE CONSTANT. This client's UA is not a cosmetic
 * string: the upstream gates on its SHAPE and reads its VERSION LINE, and the
 * two products are on disjoint version namespaces. Measured on one account at
 * one moment (see `docs/official-identity.json`):
 *
 *   hub 2.29.1  -> generation 200 + finishReason, quota 2 groups
 *   hub 2.6.0   -> generation 200 + finishReason, quota 2 groups
 *   hub 1.5.3   -> generation 200 + "no longer supported", quota 1 group
 *   antigravity/cli/<v>  -> generation 200 + finishReason, quota 2 groups
 *
 * The version is therefore not decoration twice over: below a floor the
 * generation data plane retires the client, and across the hub/CLI line
 * boundary the `retrieveUserQuotaSummary` endpoint silently drops the `Gemini
 * Models` group, which is precisely the "Gemini quota is missing" symptom. A
 * profile carries BOTH the shape and the version line, because a shape without
 * its own namespace produces exactly those two failures.
 */

/** Persisted document version. */
export const UA_PROFILE_VERSION = 1

/** The UA shapes this client knows how to emit. */
export const UA_PROFILE_KINDS = ['hub', 'cli', 'custom'] as const

export type UaProfileKind = (typeof UA_PROFILE_KINDS)[number]

/**
 * Built-in profile ids.
 *
 * Stable strings because they are persisted: a profile file that names
 * `hub` must keep resolving to the hub shape even if the enum is
 * reordered.
 */
export const UA_PROFILE_HUB = 'hub'
export const UA_PROFILE_CLI = 'cli'

/**
 * The HUB line: the Antigravity desktop app (`--subclient_type hub`), `2.x`.
 *
 * NOT the IDE line. On the reference machine the installed app reports
 * `CFBundleShortVersionString` 2.29.1 and its language server is started with
 * `--subclient_type hub`, while the hub updater manifest publishes `2.29.0` — so
 * the app and the feed can differ by a patch, and 2.x is this product's own
 * namespace either way.
 */
export const HUB_VERSION_LINE = '2.x'

/**
 * The lowest hub-line version measured to still be served.
 *
 * Measured 2026-11-09 on one account, one model, one prompt, one session id
 * per probe, repeating each version to rule out flake:
 *
 *   2.0.0 ok · 2.1.0 retired · 2.2.0 retired · 2.3.0 ok · 2.4.0 retired
 *   2.5.0 retired · 2.6.0 ok · 2.7.0 ok · 2.8.0 ok · 2.9.0 ok · 2.10.0 ok
 *   2.15.0 ok · 2.20.0 ok · 2.25.0 ok · 2.29.0 ok · 3.0.0 ok
 *
 * The non-monotonic middle (2.0.0 and 2.3.0 served, 2.1/2.2/2.4/2.5 retired)
 * is upstream's own gate, not a measurement error — every retired version
 * reproduced three times. It means "pick a low version" is NOT safe advice: a
 * version is served or not individually. The rule this constant encodes is
 * only the practical floor, and the resolver plus the shipped default keep the
 * profile far above it.
 */
export const HUB_VERSION_FLOOR = '2.6.0'

/**
 * A version to advertise when the hub feed cannot be read.
 *
 * Deliberately EQUAL to `AGY_VERSION_FALLBACK` in `oauth/constants.ts`: the
 * HUB profile and the hub feed are the SAME line, so two constants naming
 * different releases of one product is a drift with no upside. That module is
 * the single source of truth (the freshness gate compares it against the live
 * feed); this one exists only so `ua-profile-types.ts` can name a floor without
 * importing the OAuth constants, which would pull `node:*` into the browser half.
 *
 * The value tracks the LIVE FEED (2.29.0), not the version installed on any one
 * machine: this constant ships to every user, so advertising a build that the
 * release feed does not publish would name a client that may not exist for them
 * — the installed artifact can legitimately be ahead (a local build) or behind
 * (a machine that has not updated). A unit test pins it equal to
 * `AGY_VERSION_FALLBACK`, so the duplication cannot rot.
 */
export const HUB_VERSION_FALLBACK = '2.29.0'

/** One selectable UA profile, as the settings surface renders it. */
export interface UaProfileView {
  /** Stable persisted id. */
  id: string
  /** Built-in kind, or `custom` for a user-supplied template. */
  kind: UaProfileKind
  /** Human label; for a custom profile, the user's own name. */
  label: string
  /**
   * The version line this profile's versions must come from, e.g. `2.x`.
   * Shown so the reader can tell why two numbers cannot be compared.
   */
  versionLine: string
  /** A rendered example, so the shape is visible before it is selected. */
  example: string
}

/** The persisted document. */
export interface UaProfileDocument {
  version: number
  /** Id of the profile in force. */
  active: string
  /**
   * User-defined profiles, keyed by id.
   *
   * A custom profile is a TEMPLATE with two placeholders (`{version}` and
   * `{platform}`) rather than a frozen string, so switching it later does not
   * require re-editing it when a release moves — and so the version freshness
   * machinery still governs it.
   */
  custom: Record<string, UaCustomProfile>
}

/** A user-defined UA template. */
export interface UaCustomProfile {
  label: string
  /** Template carrying `{version}` and/or `{platform}`. */
  template: string
  /** Which version line `{version}` is filled from. */
  versionLine: string
}

/** What the settings card renders. */
export interface UaProfileViewResult {
  /** Every selectable profile: the two built-ins plus every custom one. */
  profiles: UaProfileView[]
  /** Id of the active profile. */
  active: string
  /** The string that would be sent right now, for the active profile. */
  effective: string
  /**
   * Which version produced `effective`, so a reader can blame a stale feed
   * rather than the profile. `fallback` means the live feed could not be read.
   */
  versionSource: 'live' | 'fallback'
}

/** Message a custom template must contain to receive the version. */
export const UA_TEMPLATE_VERSION_TOKEN = '{version}'

/** Message a custom template may contain to receive the platform token. */
export const UA_TEMPLATE_PLATFORM_TOKEN = '{platform}'

/**
 * Whether a template may be stored.
 *
 * A template with no `{version}` would freeze a literal version into the file,
 * which is exactly the silent staleness the version resolver exists to prevent
 * — and it would drift from `clientMetadata.ideVersion` in the same request.
 * So the version placeholder is REQUIRED; the platform one is optional.
 */
export function isValidUaTemplate(template: unknown): template is string {
  return typeof template === 'string'
    && template.length > 0
    && template.length <= 512
    // Reject control characters: a UA is a header value, and a newline in it
    // is a header-injection shape.
    && !/[\u0000-\u001f\u007f]/.test(template)
    && template.includes(UA_TEMPLATE_VERSION_TOKEN)
}
