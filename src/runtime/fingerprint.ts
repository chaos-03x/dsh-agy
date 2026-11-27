/**
 * Device fingerprint generation for rate-limit mitigation (two layers):
 *
 * 1. Per-request randomized headers — platform/arch/SDK-client pools.
 * 2. Per-account persistent fingerprint — deviceId/sessionToken/UA snapshot
 *    with bounded history (≤5 versions, restorable), regenerated when an
 *    account's capacity looks exhausted.
 *
 * All tunable pools live in fingerprint-data.json so they can be updated
 * without a code release (the reference implementation stopped at an old
 * version string once archived — that staleness is the detectable signal).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { AGY_IDE_TYPE, AGY_PLATFORM_ENUM } from '../oauth/constants.ts'
import { uaProfileStore } from '../ua-profile.ts'
import { HUB_VERSION_LINE } from '../ua-profile-types.ts'
import { migrateToAgyDir } from '../store/paths.ts'
import type { ClientMetadata, Fingerprint, FingerprintVersion } from '../types.ts'
import fingerprintData from './fingerprint-data.json'

export interface FingerprintData {
  versionPool: string[]
  platforms: string[]
  sdkClients: string[]
  ideTypes: string[]
}

export const DEFAULT_FINGERPRINT_DATA = fingerprintData as FingerprintData

export const MAX_FINGERPRINT_HISTORY = 5

/** The override file's NAME (inside the agy data dir), for messages and tests. */
export const FINGERPRINT_OVERRIDE_FILE = 'agy-fingerprint-data.json'

/**
 * Effective fingerprint data: a user override at `$DSH_HOME/agy/agy-fingerprint-data.json`
 * wins when present and parseable (hot-updatable without a code release — the
 * bundled copy is compiled in), otherwise the bundled defaults. The legacy
 * `$DSH_HOME/agy-fingerprint-data.json` location is migrated once by rename.
 */
let cachedData: FingerprintData | null = null
export function getFingerprintData(): FingerprintData {
  if (cachedData) return cachedData
  try {
    // NOT `resolveDshHome()`-based: see the note on `getFingerprintData` above.
    const dshHome = process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.HOME ?? '.', '.dsh')
    const overrideFile = migrateToAgyDir('agy-fingerprint-data.json', dshHome).file
    if (existsSync(overrideFile)) {
      const parsed = JSON.parse(readFileSync(overrideFile, 'utf8')) as FingerprintData
      if (parsed && Array.isArray(parsed.versionPool) && parsed.versionPool.length > 0) {
        cachedData = parsed
        return cachedData
      }
    }
  } catch {
    // unreadable override — fall through to bundled defaults
  }
  cachedData = DEFAULT_FINGERPRINT_DATA
  return cachedData
}

/**
 * A version for the ACTIVE profile's line, taken from the fingerprint pool.
 *
 * The pool is a CLI-line list (`fingerprint-data.json`), and it stays that way:
 * it is a last-resort fallback, not a second source of truth. So a pool entry is
 * only usable when the active profile draws from the CLI line — for the HUB
 * profile the pool's `1.x` numbers are exactly what must NOT be advertised, and
 * the profile's own live-resolved version is used instead.
 *
 * This is the single place that decision is made, so the three builders
 * (`generateFingerprint`, `getRandomizedHeaders`, `getStableHeaders`) cannot
 * disagree about which line they are on.
 */
function profileVersion(data: FingerprintData): string {
  const store = uaProfileStore()
  // The PROFILE's resolution wins: it is the live feed value (or that line's
  // floor), i.e. the freshest number this process has. The pool is what it says
  // — a LAST RESORT — so it is consulted only when the profile line itself is
  // one the pool can describe (the hub line; `fingerprint-data.json` holds
  // hub-line numbers) AND only when no other value exists.
  //
  // Order used to be reversed (`pool[0] ?? activeVersion()`), which made the
  // hardcoded literal override a live resolution: whatever the feed observed, every
  // fresh fingerprint still advertised the pool's literal, making that literal the
  // effective version — the exact staleness the resolver exists to remove.
  const resolved = store.activeVersion()
  if (store.activeVersionLine() !== HUB_VERSION_LINE) return resolved
  return resolved || (data.versionPool[0] ?? '')
}

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

/**
 * Replace the pool data for one test, and restore the real source with `undefined`.
 *
 * `getFingerprintData()` caches its result in-process, so a test cannot exercise a
 * user override file (`$DSH_HOME/agy/agy-fingerprint-data.json`) without a way to drop
 * that cache.
 */
export function _setFingerprintDataForTest(data: FingerprintData | undefined): void {
  cachedData = data ?? null
}

/** Generate a randomized device fingerprint representing one apparent device. */
export function generateFingerprint(
  data: FingerprintData = getFingerprintData(),
  version: string | undefined = undefined,
): Fingerprint {
  const platform = randomFrom(data.platforms)
  return {
    deviceId: randomUUID(),
    sessionToken: randomBytes(16).toString('hex'),
    // The UA comes from the ACTIVE PROFILE (`ua-profile.ts`), which owns both
    // the shape and its version line. Building the string here would reintroduce
    // the defect the profile exists to fix: the shape and the version must come
    // from the same product line, or the data plane answers the retirement
    // notice and the quota endpoint silently drops the Gemini group. The version
    // argument is the caller's (a pool entry or a resolved value); the profile
    // fills it only when nothing was passed.
    userAgent: uaProfileStore().userAgent({
      version: version ?? profileVersion(data),
      platform,
    }),
    apiClient: randomFrom(data.sdkClients),
    // The metadata message, not a header (see `ClientMetadata` in types.ts). The
    // version is stamped here as well as in the UA because the official message
    // carries `ide_version` — a UA the SDK overwrites would otherwise be the only
    // place this client states its version.
    clientMetadata: {
      ideType: randomFrom(data.ideTypes),
      ideVersion: version ?? profileVersion(data),
      platform: AGY_PLATFORM_ENUM,
    },
    createdAt: Date.now(),
  }
}

/**
 * Per-request randomized headers (platform + SDK client pools).
 *
 * No longer used on any production path: the account's identity is created once
 * on first use and reused ({@link generateFingerprint}), so nothing re-rolls a
 * platform per request. Kept as the pool-level primitive that
 * {@link getStableHeaders} and the fingerprint tests are built on.
 */
/** The impersonation surface a fingerprint produces: two headers and the body message. */
export interface ImpersonationHeaders {
  'User-Agent': string
  'X-Goog-Api-Client': string
  clientMetadata: ClientMetadata
}

export function getRandomizedHeaders(
  data: FingerprintData = getFingerprintData(),
  version: string | undefined = undefined,
): ImpersonationHeaders {
  const platform = randomFrom(data.platforms)
  const resolved = version ?? profileVersion(data)
  return {
    'User-Agent': uaProfileStore().userAgent({ version: resolved, platform }),
    'X-Goog-Api-Client': randomFrom(data.sdkClients),
    clientMetadata: {
      ideType: randomFrom(data.ideTypes),
      ideVersion: resolved,
      platform: AGY_PLATFORM_ENUM,
    },
  }
}

/**
 * Deterministic fallback headers for the `stable` fingerprint mode: the first
 * entry of each pool, every call — one fixed client identity instead of
 * per-request randomization (OMP-style fixed-client posture).
 */
export function getStableHeaders(
  data: FingerprintData = getFingerprintData(),
  version: string | undefined = undefined,
): ImpersonationHeaders {
  const platform = data.platforms[0] ?? 'darwin/arm64'
  // Never a literal: the profile's own resolved version (the live feed value or
  // its line's floor). A frozen string here would outlive the release it names,
  // and a number from the WRONG line is worse than stale — see `ua-profile.ts`.
  const resolved = version ?? profileVersion(data)
  return {
    'User-Agent': uaProfileStore().userAgent({ version: resolved, platform }),
    'X-Goog-Api-Client': data.sdkClients[0] ?? '',
    clientMetadata: {
      ideType: data.ideTypes[0] ?? AGY_IDE_TYPE,
      ideVersion: resolved,
      platform: AGY_PLATFORM_ENUM,
    },
  }
}

/**
 * Rewrite the version inside a fingerprint UA; reports whether it changed.
 *
 * Carries the metadata message's `ideVersion` along: they state the same fact,
 * and letting them drift is how one account comes to look like two clients.
 *
 * Rebuilds the string through the ACTIVE PROFILE rather than by substring
 * replacement, so a version bump cannot silently move a stored identity off its
 * line: a hub-shaped identity keeps the hub shape, a CLI-shaped one
 * keeps the CLI shape. Swapping the number into whatever prefix happened to be
 * there is how a `1.x` value ends up inside an `Antigravity/2.x` string.
 *
 * @param version - the version to advertise. It must belong to the active
 *   profile's line; the caller resolves it from the right feed (see
 *   `uaProfile.ts`).
 */
export function updateFingerprintVersion(fingerprint: Fingerprint, version: string): boolean {
  const platform = uaPlatformToken(fingerprint.userAgent)
  const uaChanged = uaVersionOf(fingerprint.userAgent) !== version
  if (uaChanged) fingerprint.userAgent = uaProfileStore().userAgent({ version, platform })
  const metaChanged = fingerprint.clientMetadata.ideVersion !== version
  if (metaChanged) fingerprint.clientMetadata.ideVersion = version
  return uaChanged || metaChanged
}

/**
 * The version inside ANY supported UA shape, or undefined when unrecognized.
 *
 * Covers the CLI shape (`antigravity/cli/<v> (...)`), the hub shape
 * (`antigravity/hub/<v> (...)`), the legacy short shape
 * (`antigravity/<v> <platform>`) and a Chromium product string
 * (`Mozilla/5.0 ... Antigravity/<v> Chrome/...`). The last form is matched
 * separately because a stored identity written by an older build (or by another
 * implementation) must still be re-versionable rather than rewritten blind.
 */
export function uaVersionOf(userAgent: string): string | undefined {
  // `(?:cli|hub)/` is load-bearing, not tidiness: without it a hub string's
  // version never parses, so `updateFingerprintVersion` reported "changed" on
  // every call and rewrote an identity that was already correct — an infinite
  // write loop on the hot path.
  return /^antigravity\/(?:cli\/|hub\/)?([\d.]+)/.exec(userAgent)?.[1]
    ?? /Antigravity\/([\d.]+)/.exec(userAgent)?.[1]
}

/**
 * The `platform/arch` token of any UA shape, for feeding back into the profile
 * builder.
 *
 * Legacy `antigravity/<v> darwin/arm64` carries it after the version; the CLI
 * shape carries `os_type=` / `arch=` labels instead; a hub string names
 * the OS the Chromium way (`Macintosh; Intel Mac OS X 10_15_7` / `Windows NT`).
 * The CLI's OS token is the operating system's name (`macos`) while the UA's own
 * is Go-style (`darwin`) — `darwin` has NOT been measured on the wire, so it is
 * mapped rather than passed through. An unparseable UA keeps the fallback
 * platform, which is a valid identity; inventing a token would not be.
 */
export function uaPlatformToken(userAgent: string): string {
  if (/Macintosh/.test(userAgent)) return 'darwin/arm64'
  if (/Windows NT/.test(userAgent)) return 'windows/amd64'
  const legacy = /^antigravity\/[\d.]+\s+(\S+)\/(\S+)/.exec(userAgent)
  if (legacy) {
    const os = legacy[1] === 'darwin' ? 'macos' : legacy[1]!
    return `${os}/${legacy[2]}`
  }
  const cli = /os_type=([^;)\s]+)/.exec(userAgent)
  const arch = /arch=([^;)\s]+)/.exec(userAgent)
  if (cli && arch) return `${cli[1]}/${arch[1]}`
  return 'macos/arm64'
}

/**
 * Whether {@link migrateStoredFingerprintUa} would rewrite this identity.
 *
 * Split out so the session hot path can decide WITHOUT writing: a mutation per
 * request would take the file lock on every turn for an identity that is
 * already correct.
 */
export function fingerprintUaNeedsMigration(fingerprint: Fingerprint): boolean {
  const { userAgent } = fingerprint
  const version = uaVersionOf(userAgent)
  if (version === undefined) return false
  // `userAgent` renders from the profile for THIS line, so a mismatch means the
  // stored string predates the profile (or was written for another line).
  return uaProfileStore().userAgent({ version, platform: uaPlatformToken(userAgent) }) !== userAgent
}

/**
 * Rewrite a persisted identity's UA into the ACTIVE PROFILE's shape; reports
 * whether it changed.
 *
 * The identity is written ONCE per account and reused for its lifetime, so a
 * profile change would otherwise never reach existing accounts — they would
 * keep presenting the retired/CLI identity while a fresh login presented the
 * new one, which is one install claiming to be two clients. The version is
 * preserved where it still belongs to the target line, and re-resolved from the
 * profile when it does not (a hub string does not accept `1.5.x`).
 */
export function migrateStoredFingerprintUa(fingerprint: Fingerprint): boolean {
  const { userAgent } = fingerprint
  if (!looksLikeAnyUserAgent(userAgent)) return false
  const stored = uaVersionOf(userAgent)
  if (stored === undefined) return false
  const platform = uaPlatformToken(userAgent)
  const store = uaProfileStore()
  // The profile owns which line the version must come from. Only a version that
  // already belongs to that line is carried over; anything else is re-resolved,
  // because carrying it would put a CLI number inside a hub string (the
  // exact pair that gets `retrieveUserQuotaSummary` to drop the Gemini group).
  const lineVersion = store.activeVersion()
  const version = versionBelongsToLine(stored, store.activeVersionLine()) ? stored : lineVersion
  const next = store.userAgent({ version, platform })
  // The metadata message states the SAME fact as the UA (see
  // `updateFingerprintVersion`), so a migration that moves one and not the other
  // leaves the account presenting two versions at once — the drift this module
  // exists to prevent, and the reason this is not just a `userAgent` assignment.
  const metaChanged = fingerprint.clientMetadata.ideVersion !== version
  if (next === userAgent && !metaChanged) return false
  fingerprint.userAgent = next
  if (metaChanged) fingerprint.clientMetadata.ideVersion = version
  return true
}

/** Whether a stored UA is one of the shapes this module understands. */
function looksLikeAnyUserAgent(userAgent: string): boolean {
  return /^antigravity\//.test(userAgent) || /Antigravity\//.test(userAgent)
}

/**
 * Whether a version number plausibly belongs to a line.
 *
 * Deliberately coarse (major only): the point is to keep a `1.x` number out of
 * an `Antigravity/2.x` string, not to validate against a feed — a feed failure
 * must not make a stored identity un-migratable.
 */
function versionBelongsToLine(version: string, line: string): boolean {
  const major = version.split('.')[0]
  if (line === '2.x') return major === '2'
  if (line === '1.x' || line === 'cli') return major === '1'
  return true
}

/** Append a fingerprint to the account history (bounded), then use it as current. */
export function recordFingerprintVersion(
  history: FingerprintVersion[] | undefined,
  fingerprint: Fingerprint,
  reason: FingerprintVersion['reason'],
): FingerprintVersion[] {
  const next = [...(history ?? []), { fingerprint, timestamp: Date.now(), reason }]
  return next.slice(-MAX_FINGERPRINT_HISTORY)
}
