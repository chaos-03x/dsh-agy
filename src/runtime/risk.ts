/**
 * Risk-control switches (compliance posture): env-gated behaviors that keep
 * the grey-zone product honest —
 *
 * - DSH_AGY_DISABLE=1: global kill switch, the plugin registers nothing.
 * - DSH_AGY_FINGERPRINT_MODE=stable: one identity per account, never
 *   regenerated, deterministic fallback headers (OMP-style fixed-client
 *   posture). Default `dynamic` keeps the upstream per-request randomization.
 *
 * The BYO OAuth app escape hatch (AGY_CLIENT_ID / AGY_CLIENT_SECRET) lives in
 * oauth/constants.ts (resolveAgyClientCredentials) — oauth/ is a dependency
 * leaf and must not import runtime/.
 */

export type FingerprintMode = 'dynamic' | 'stable'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function envFlag(name: string): boolean {
  const value = process.env[name]
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase())
}

/** Global kill switch: DSH_AGY_DISABLE=1 keeps the plugin from registering anything. */
export function isAgyDisabled(): boolean {
  return envFlag('DSH_AGY_DISABLE')
}

/**
 * Fingerprint strategy: `dynamic` (default, upstream behavior: per-request
 * header randomization + regeneration on repeated rate-limits) or `stable`
 * (one identity per account, never regenerated, deterministic fallback
 * headers — mirrors OMP's fixed-client posture).
 */
export function fingerprintMode(): FingerprintMode {
  return process.env.DSH_AGY_FINGERPRINT_MODE === 'stable' ? 'stable' : 'dynamic'
}
