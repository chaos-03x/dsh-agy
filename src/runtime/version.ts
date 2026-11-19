/**
 * Fresh Antigravity client version resolution: fetch from the product's own
 * release feeds (6h TTL, single in-flight dedupe), falling back to the pinned
 * pool. Keeps fingerprint User-Agent version strings current — a stale version
 * is the most detectable fingerprint anomaly.
 */

import {
  AGY_VERSION_FALLBACK,
  antigravityUserAgent,
  setResolvedAgyVersion,
  setResolvedCliVersion,
  setResolvedHubVersion,
} from '../oauth/constants.ts'
import { HUB_VERSION_FALLBACK, HUB_VERSION_FLOOR } from '../ua-profile-types.ts'
import { proxiedFetch } from '../proxy.ts'

const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const VERSION_FETCH_TIMEOUT_MS = 5_000

/** Source 1: Antigravity IDE auto-update release feed (array of {version}). */
const IDE_RELEASE_FEED_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app/releases'
/** Source 2: agy CLI GitHub releases (object with tag_name). */
const CLI_RELEASE_URL = 'https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest'
/**
 * Source 3: the hub desktop app's own updater manifest.
 *
 * A `latest.yml`-shaped document (`version: 2.29.0` on the first line), which is
 * what electron-updater reads. It is the ONLY feed that names the desktop app's
 * version — the IDE feed publishes `2.0.0`/`1.2x` and the CLI feed `1.5.x`, so
 * neither can describe it.
 */
export const HUB_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml'

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>
}

export interface VersionState {
  cache?: { version: string; fetchedAt: number }
  inFlight: Promise<string | undefined> | null
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0)
  const pb = b.split('.').map((n) => Number(n) || 0)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function pickNewestVersion(...versions: Array<unknown>): string | null {
  const valid = versions
    .filter((v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))
  if (valid.length === 0) return null
  return valid.reduce<string | null>((best, v) => (!best || compareSemver(v, best) > 0 ? v : best), null)
}

/**
 * Highest version published so far in this process.
 *
 * Kept locally so publication is monotonic: the two feeds resolve independently
 * and either may finish first, so without this the slower (possibly older) source
 * could lower what a User-Agent already advertises. A version never goes
 * backwards here — only the cold-start floor can be below a published value.
 */
let publishedVersion: string | undefined

/**
 * Publish a newly observed version into the shared slot every User-Agent builder
 * reads ({@link setResolvedAgyVersion}), never lowering an already-published one.
 */
function publishVersion(version: string | null | undefined): void {
  if (version === null || version === undefined) return
  const best = pickNewestVersion(version, publishedVersion)
  if (best === null || best === publishedVersion) return
  publishedVersion = best
  setResolvedAgyVersion(best)
}

/**
 * Publish a CLI-feed observation into the CLI slot, never lowering it.
 *
 * The hub slot deliberately does NOT move here: the two feeds are different
 * products, and a CLI number reaching the hub builder (or the reverse) is the
 * line mismatch this whole mechanism exists to prevent.
 */
let publishedCliVersion: string | undefined

function publishCliVersion(version: string | null | undefined): void {
  if (version === null || version === undefined) return
  const best = pickNewestVersion(version, publishedCliVersion)
  if (best === null || best === publishedCliVersion) return
  publishedCliVersion = best
  setResolvedCliVersion(best)
}

/**
 * Publish a freshly observed hub version, never lowering a published one.
 *
 * Separate from {@link publishVersion} (the CLI slot) because the two lines are
 * on disjoint namespaces: a `max` across them compares unrelated numbers, and
 * publishing one into the other's slot is what puts a `1.x` value inside an
 * `Antigravity/2.x` string.
 */
let publishedHubVersion: string | undefined

function publishHubVersion(version: string | null | undefined): void {
  if (version === null || version === undefined) return
  const best = pickNewestVersion(version, publishedHubVersion)
  if (best === null || best === publishedHubVersion) return
  publishedHubVersion = best
  setResolvedHubVersion(best)
}

function parseIdeReleaseFeed(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null
  return pickNewestVersion(...payload.map((entry) => (entry as { version?: unknown })?.version))
}

function parseCliRelease(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const release = payload as { name?: unknown; tag_name?: unknown }
  return pickNewestVersion(release.tag_name ?? release.name)
}

/**
 * Parse the electron-updater manifest's `version:` line.
 *
 * Deliberately a LINE SCAN rather than a YAML parse: the manifest is a flat
 * `key: value` document, the resolver must not grow a YAML dependency for one
 * field, and a full parser would have to decide what to do with the `files:`
 * block. A missing or malformed line yields nothing, which the caller reads as
 * "the feed did not answer".
 */
export function parseHubManifest(payload: unknown): string | null {
  if (typeof payload !== 'string') return null
  const match = payload.match(/^version:\s*(\d+\.\d+\.\d+)\s*$/m)
  return match?.[1] ?? null
}

/**
 * Fetch one version source under a shared timeout.
 *
 * `body` selects how the payload is read: the two JSON feeds parse as JSON,
 * while the electron-updater manifest is a YAML-shaped text document that this
 * module line-scans (see {@link parseHubManifest}).
 */
async function fetchSourceWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  body: 'json' | 'text',
): Promise<unknown> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS)
  // The manifest is YAML even when a caller forgets to say so, so the URL is a
  // fallback for the read mode rather than a second source of truth.
  const asText = body === 'text' || /\.ya?ml(\?|$)/.test(url)
  try {
    const response = await fetchImpl(url, {
      // Every feed here is a service the official Antigravity client ecosystem
      // already talks to, so the client User-Agent is the consistent choice.
      // This previously sent a hardcoded `dsh-agy/0.1` — a self-identifying
      // string that also never tracked the package version.
      headers: {
        Accept: asText ? 'text/yaml, text/plain, */*' : 'application/json, */*',
        'User-Agent': antigravityUserAgent(),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Version source ${url} returned ${response.status}`)
    return asText ? response.text() : response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Resolve the newest OBSERVED version from one feed, or `undefined` when the
 * feed yielded nothing.
 *
 * Returning `undefined` rather than the pinned fallback is what keeps the
 * fallback out of {@link resolveAntigravityVersion}'s cross-source `max`. When
 * this returned the fallback, a source that simply failed to parse contributed
 * the fallback as though it were evidence, and once the fallback was raised to
 * track the live feed it started outranking genuine — but older — feed data.
 * The fallback is a last resort and is applied once, at the public boundary.
 */
async function resolveObservedVersion(
  state: VersionState,
  sourceUrl: string,
  parse: (payload: unknown) => string | null,
  fetchImpl: FetchLike,
  body: 'json' | 'text' = 'json',
  publish: (version: string | undefined) => void = publishVersion,
): Promise<string | undefined> {
  const now = Date.now()
  if (state.cache && now - state.cache.fetchedAt < VERSION_CACHE_TTL_MS) {
    publish(state.cache.version)
    return state.cache.version
  }
  if (state.inFlight) return state.inFlight

  state.inFlight = (async () => {
    let resolved: string | null = null
    try {
      resolved = parse(await fetchSourceWithTimeout(fetchImpl, sourceUrl, body))
    } catch {
      resolved = null
    }
    const observed = pickNewestVersion(resolved, state.cache?.version)
    if (resolved) {
      state.cache = { version: observed ?? resolved, fetchedAt: Date.now() }
      // Publish only a genuinely observed version; the fallback is not evidence.
      publish(resolved)
    }
    return observed ?? undefined
  })()

  try {
    return await state.inFlight
  } finally {
    state.inFlight = null
  }
}

/** Resolve the newest known Antigravity version from the IDE feed. */
export async function resolveAntigravityIdeVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedVersion(ideState, IDE_RELEASE_FEED_URL, parseIdeReleaseFeed, fetchImpl))
    ?? AGY_VERSION_FALLBACK
}

/** Resolve the newest known Antigravity version from the CLI releases. */
export async function resolveAntigravityCliVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedVersion(cliState, CLI_RELEASE_URL, parseCliRelease, fetchImpl, 'json', publishCliVersion))
    ?? AGY_VERSION_FALLBACK
}

/**
 * The newest version actually OBSERVED on the claimed product's feed, or
 * `undefined` when it yielded nothing.
 *
 * Reads the **CLI feed only**. This used to take the numeric max across the IDE
 * and CLI feeds, which is a category error: the three Antigravity lines are
 * separate version namespaces (IDE 2.x, hub 2.2x, CLI 1.5.x), so "newest"
 * across them compares unrelated numbers and picks whichever line happens to
 * count higher. Since this client claims to be the CLI
 * (`docs/official-identity.json`), the CLI feed is the only one that can
 * describe the version we are entitled to advertise; the IDE resolver stays
 * exported for the freshness gate's cross-check, never for the wire.
 *
 * Distinct from {@link resolveAntigravityVersion}, which substitutes the pinned
 * fallback at the boundary. A caller that must tell "observed" from "assumed"
 * cannot use that one — and the freshness gate is exactly such a caller, since
 * the fallback is the value under test.
 */
export async function resolveObservedAgyVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string | undefined> {
  // HUB ONLY. This used to fall back to the CLI feed when the manifest did not
  // answer, publishing a `1.x` value into the hub slot — which made the HUB
  // profile emit `antigravity/hub/1.5.3`, the retired pair that also drops the
  // Gemini quota group. A cross-line fallback is not a fallback: it is the exact
  // defect the separate slots exist to prevent. `undefined` here means "the hub
  // line was not observed", and the caller substitutes the hub floor.
  return resolveObservedVersion(hubState, HUB_MANIFEST_URL, parseHubManifest, fetchImpl)
}

/**
 * Resolve the newest hub desktop-app version, cached 6h.
 *
 * Reads the desktop app's OWN updater manifest. Never returns a value below
 * {@link HUB_VERSION_FLOOR}: the floor is measured (2.6.0 and above are
 * served, 2.1/2.2/2.4/2.5 answer the retirement notice), and a feed that
 * regressed below it must not make this client patently unservable.
 *
 * Returns `undefined` when the manifest did not answer, so the caller can tell
 * "observed" from "assumed" — the settings card shows which one is in force.
 */
export async function resolveObservedHubVersion(
  fetchImpl: FetchLike = proxiedFetch,
): Promise<string | undefined> {
  const observed = await resolveObservedVersion(
    hubState,
    HUB_MANIFEST_URL,
    parseHubManifest,
    fetchImpl,
    'text',
  )
  if (observed === undefined) return undefined
  if (compareSemver(observed, HUB_VERSION_FLOOR) < 0) {
    // Clamp rather than publish: advertising an unservable version would fail
    // every generation turn with the retirement notice, which reads as a stream
    // fault. The floor is the smallest version measured to be served.
    publishHubVersion(HUB_VERSION_FLOOR)
    return HUB_VERSION_FLOOR
  }
  publishHubVersion(observed)
  return observed
}

/**
 * Best available hub version: the observed one, else the shipped floor.
 *
 * The boundary equivalent of {@link resolveAntigravityVersion}, and what the
 * hub UA builder ultimately reads.
 */
export async function resolveHubVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  return (await resolveObservedHubVersion(fetchImpl)) ?? HUB_VERSION_FALLBACK
}

/**
 * Bounded hub resolve, mirroring {@link resolveAntigravityVersionBounded}:
 * the failure path must never block on a cold manifest.
 */
export async function resolveHubVersionBounded(
  timeoutMs = 750,
  fetchImpl: FetchLike = proxiedFetch,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      resolveHubVersion(fetchImpl).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best available version: the claimed product line, cached 6h.
 *
 * During cold start BOTH lines are warmed, because the active UA profile may be
 * either one and a profile switched later must not advertise a stale number.
 * The returned value is the CLI line's, which is what every CLI-shaped surface
 * wants; hub callers use {@link resolveHubVersion}.
 */
export async function resolveAntigravityVersion(fetchImpl: FetchLike = proxiedFetch): Promise<string> {
  const [cli] = await Promise.all([
    resolveObservedAgyVersion(fetchImpl),
    // Warm the hub line too; a failure there must not fail the CLI line,
    // so it is deliberately not awaited for its value.
    resolveObservedHubVersion(fetchImpl).catch(() => undefined),
  ])
  return cli ?? AGY_VERSION_FALLBACK
}

/**
 * Bounded resolve for fingerprint generation: never block the failure path on
 * cold version feeds. Resolves undefined on timeout/error so callers fall
 * back to the pinned version pool; the abandoned fetch keeps running and
 * populates the 6h cache for later calls.
 *
 * `fetchImpl` routes the probe: the feeds belong to no account, so the caller
 * decides which egress they use (the CLI passes the login proxy, the plugin
 * passes the pool's representative account).
 */
export async function resolveAntigravityVersionBounded(
  timeoutMs = 750,
  fetchImpl: FetchLike = proxiedFetch,
): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      resolveAntigravityVersion(fetchImpl).catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Synchronously peek at a fresh cached version (no network). */
export function peekCachedAntigravityVersion(): string | undefined {
  const now = Date.now()
  for (const state of [hubState, cliState, ideState]) {
    if (state.cache && now - state.cache.fetchedAt < VERSION_CACHE_TTL_MS) {
      // A fresh cache is an observation too — publish it so a synchronous peek
      // (the fingerprint failure path) reaches User-Agent builders without I/O.
      publishVersion(state.cache.version)
      return state.cache.version
    }
  }
  return undefined
}

/**
 * One state per FEED, not per caller.
 *
 * The hub manifest IS the hub line's feed, so `hubState` serves both the
 * exported hub resolver and `resolveObservedHubVersion`: two caches over one
 * URL would double the request rate and let the two disagree about a version they
 * both claim to have observed.
 */
const hubState: VersionState = { inFlight: null }
const ideState: VersionState = { inFlight: null }
const cliState: VersionState = { inFlight: null }

/**
 * Drop both feeds' cached state so a test can exercise the cold-start path.
 *
 * `inFlight` is cleared with the cache: a test that lets a probe hang leaves its
 * single-flight promise pending, and the next test's resolve would return THAT
 * promise instead of issuing its own request — silently testing nothing.
 *
 * Deliberately does NOT clear the published version slot: that one is monotonic
 * process state, and dropping it would let a test's User-Agent move backwards.
 */
export function _clearVersionCacheForTest(): void {
  hubState.cache = undefined
  ideState.cache = undefined
  cliState.cache = undefined
  hubState.inFlight = null
  ideState.inFlight = null
  cliState.inFlight = null
}
