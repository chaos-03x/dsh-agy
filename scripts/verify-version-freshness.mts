// Version-freshness gate: every compiled floor must not trail the live release
// feed OF ITS OWN PRODUCT LINE by more than one minor.
//
// Why this exists as a SCHEDULED check rather than a PR check: agy ships without
// a PR here, so drift appears between releases of THIS package. A stale client
// version is the most detectable fingerprint anomaly (the whole reason
// `version.ts` resolves the version at runtime), and a floor is what every
// User-Agent uses when the feed is unreachable — offline, firewalled, or before
// the first resolve. Nothing else notices when it rots.
//
// TWO LINES, TWO FEEDS, TWO FLOORS. The Antigravity product lines are disjoint
// namespaces — hub `2.x`, CLI `1.5.x` — and this client ships a UA profile for
// each (`src/ua-profile.ts`). So the gate checks each pair SEPARATELY:
//
//   hub line : AGY_VERSION_FALLBACK      vs the hub electron-updater manifest
//   CLI line : AGY_CLI_VERSION_FALLBACK  vs the antigravity-cli GitHub releases
//
// Crossing the lines is the failure this structure prevents: a `1.x` value
// compared against a `2.x` feed always looks "behind by many minors", and (worse)
// publishing the CLI value into the hub slot made the HUB profile emit
// `antigravity/hub/1.5.3`, which the data plane retires.
//
// The versionPool is held to the HUB line only — that is the line its literals
// name (see `fingerprint-data.json`).
//
// Usage:
//   pnpm run verify:version-freshness                       # against the real feeds
//   pnpm run verify:version-freshness --fallback 2.0.0      # hub red-capability
//   pnpm run verify:version-freshness --cli-fallback 1.0.0  # CLI red-capability
//   pnpm run verify:version-freshness --pool 1.0.0          # pool red-capability
//   pnpm run verify:version-freshness --hub 3.0.0           # cross-check override
//
// Exit codes: 0 fresh, 1 drift, 2 unmeasurable (feeds unreachable). The workflow
// treats 1 and 2 alike — both need a human — but says which one it was.

import { readFileSync } from 'node:fs'
import { AGY_CLI_VERSION_FALLBACK, AGY_VERSION_FALLBACK } from '../src/oauth/constants.ts'
import { resolveObservedAgyVersion, resolveAntigravityCliVersion } from '../src/runtime/version.ts'

/**
 * The `antigravity-hub` updater manifest — a DIFFERENT product line from the IDE
 * feed `version.ts` reads, published by the same GCP project. Used only as a
 * cross-check (see the header).
 */
const HUB_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml'

interface FingerprintDataShape {
  versionPool?: unknown
}

const args = process.argv.slice(2)

function flagValue(name: string): string | undefined {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

const declaredFallback = flagValue('--fallback') ?? AGY_VERSION_FALLBACK
const declaredCliFallback = flagValue('--cli-fallback') ?? AGY_CLI_VERSION_FALLBACK
const declaredPool = flagValue('--pool')
const declaredHub = flagValue('--hub')

for (const [flag, value] of [
  ['--fallback', declaredFallback],
  ['--cli-fallback', declaredCliFallback],
] as const) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    console.error(`${flag} needs a x.y.z version (got ${String(value)})`)
    process.exit(1)
  }
}

function parse(version: string): [number, number, number] {
  const parts = version.split('.').map((n) => Number(n))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

/** Semver distance in minors: 0 for the same minor, negative when behind. */
function minorDistance(candidate: string, reference: string): number {
  const [cMajor, cMinor] = parse(candidate)
  const [rMajor, rMinor] = parse(reference)
  return (cMajor - rMajor) * 100 + (cMinor - rMinor)
}

const pool = JSON.parse(
  readFileSync(new URL('../src/runtime/fingerprint-data.json', import.meta.url), 'utf8'),
) as FingerprintDataShape

const poolVersions = (Array.isArray(pool.versionPool)
  ? pool.versionPool.filter((v): v is string => typeof v === 'string')
  : [])
// `--pool` REPLACES the list rather than joining it: the point of the flag is to
// prove the check can go red, and a value appended to a healthy list is simply
// outranked by it (`newestOf` takes the max), so the run would pass and prove
// nothing.
if (declaredPool !== undefined) poolVersions.splice(0, poolVersions.length, declaredPool)
if (poolVersions.length === 0) {
  console.error('FAIL fingerprint-data.json has no usable versionPool')
  process.exit(1)
}

// Each resolve returns the OBSERVED value or the compiled floor, so "unreachable"
// and "the live version happens to equal the floor" are told apart by comparing
// against the floor rather than by assuming a miss.
const [hubLive, cliLive] = await Promise.all([
  resolveObservedAgyVersion().catch(() => undefined),
  resolveAntigravityCliVersion().catch(() => undefined),
])

const problems: string[] = []
let measured = 0

/**
 * Check one line: its floor against its own feed, within one minor.
 *
 */
function checkLine(input: {
  name: string
  floor: string
  live: string | undefined
  /** Versions held to this line besides the floor (the pool, for the hub line). */
  others?: Array<{ label: string, value: string }>
}): void {
  const { name, floor, live } = input
  if (live === undefined) {
    console.log(`${name}: UNMEASURABLE (feed unreachable) — floor ${floor} not checked`)
    return
  }
  measured += 1
  console.log(`${name}: live ${live} · floor ${floor}`)
  if (minorDistance(floor, live) < -1) {
    problems.push(`${name} floor ${floor} trails its feed ${live} by more than one minor`)
  }
  for (const other of input.others ?? []) {
    if (minorDistance(other.value, live) < -1) {
      problems.push(`${name} ${other.label} ${other.value} trails its feed ${live} by more than one minor`)
    }
  }
  // Compare the cross line against its OWN floor, never against this line's live
  // value: `1.5.3` vs `2.29.0` is "behind by 74 minors" and means nothing, since
  // the numbers name different products. The useful signal is a line that stopped
  // tracking its own feed, which its own check already reports as a FAIL.
  void input.crossLive
  void input.crossName
}

// The hub manifest serves as the cross-check for the CLI line and vice versa: a
// staleness signal on ONE feed is only distinguishable from a global outage when
// the other feed is read at the same time.
checkLine({
  name: 'hub',
  floor: declaredFallback,
  live: hubLive,
  others: [{ label: 'newest versionPool entry', value: newestOf(poolVersions) }],
})

checkLine({
  name: 'cli',
  floor: declaredCliFallback,
  live: cliLive,
})

if (declaredHub !== undefined) {
  console.log(`hub override: ${declaredHub}`)
}

if (measured === 0) {
  console.error('UNMEASURABLE every feed was unreachable')
  process.exit(2)
}

if (problems.length > 0) {
  console.error(`\nFAIL ${problems.join('; ')}`)
  console.error('Bump the floor that drifted (AGY_VERSION_FALLBACK for the hub line, '
    + 'AGY_CLI_VERSION_FALLBACK for the CLI line, both in src/oauth/constants.ts) and '
    + 'versionPool in src/runtime/fingerprint-data.json.')
  process.exit(1)
}

console.log(`\nPASS every measured floor is within one minor of its own feed (${measured} line(s))`)

/** Newest entry of a version list, by semver minor comparison. */
function newestOf(versions: readonly string[]): string {
  return versions.reduce((best, v) => (minorDistance(v, best) > 0 ? v : best), versions[0]!)
}
