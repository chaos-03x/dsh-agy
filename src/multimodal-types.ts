/**
 * Multimodal inline-cap vocabulary shared by the host store, the RPC wire
 * contract, and the browser UI.
 *
 * Split out for the same reason `thinking-types.ts` is: these declarations live
 * on their own, free of any `node:*` import, so the browser bundle can describe
 * the settings surface without reaching the host's storage module through
 * `rpc-contract.ts` (which the client typechecks).
 */

/** Persisted document version. */
export const MULTIMODAL_VERSION = 1

/**
 * Built-in per-file inline cap, in MB.
 *
 * NOT a measured upstream boundary: 20MB is the value this feature shipped
 * with, and #101 deliberately leaves the default where it is (only the
 * settings surface and the env knob are new).
 */
export const MULTIMODAL_DEFAULT_MB = 20

/**
 * Accepted interval for a user-configured cap, in MB.
 *
 * A UI guardrail, NOT a measured upstream boundary: the real request-body limit
 * is unprobed (probing it is out of scope for #101). The ceiling is one order of
 * magnitude above the default so a typo like `100000` is rejected at save time
 * instead of turning every request into a body the upstream refuses, and the
 * floor keeps `0` — which would silently disable file inlining — out of the
 * stored document.
 */
export const MULTIMODAL_MIN_MB = 1
export const MULTIMODAL_MAX_MB = 100

/** Which of the three sources currently decides the effective cap. */
export type MultimodalSource = 'default' | 'stored' | 'env'

/** The persisted document; an absent `maxInlineMb` means "use the default". */
export interface MultimodalDocument {
  version: number
  maxInlineMb?: number
}

/**
 * What the settings card renders.
 *
 * `value` is the STORED value (null when nothing is stored) and `source` names
 * which source is EFFECTIVE, so the two can disagree: the box edits the stored
 * value while env wins over it, and showing only one of the two would make a
 * stored-but-overridden setting look either unset or in force.
 */
export interface MultimodalView {
  value: number | null
  source: MultimodalSource
  /** Accepted upper bound, so the UI needs no second source for the interval. */
  max: number
}

/** Whether `value` may be stored as a per-file inline cap: an integer MB in range. */
export function isValidMultimodalMb(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= MULTIMODAL_MIN_MB
    && value <= MULTIMODAL_MAX_MB
}
