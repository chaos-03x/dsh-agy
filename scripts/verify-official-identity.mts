/**
 * Re-measure the official-identity record (`docs/official-identity.json`).
 *
 * Why this exists: the record's whole claim to authority is that it is
 * RE-MEASURABLE. The three community projects this client was originally
 * compared against are leads, not references — they disagree with each other,
 * they invent headers that exist in neither official binary, and they are frozen
 * at whatever version they were written against. A reference object must be
 * (a) the product we claim to be and (b) checkable at will. That is the installed
 * official artifact plus its release feed, which is what this script reads.
 *
 * It also pins OUR side of the contract: the values compiled into this package
 * must still agree with the record, so the record cannot rot into a document
 * nobody reads while the code drifts away from it.
 *
 * Exit codes: 0 = every check held, 1 = drift, 2 = could not measure.
 * Not run in CI by default: it needs the official artifact installed locally.
 * On a machine without it, the binary checks report "unmeasurable" and skip.
 *
 *   pnpm run verify:official-identity
 *   pnpm run verify:official-identity -- --cli /path/to/agy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

import {
  AGY_CLI_VERSION_FALLBACK,
  AGY_ENDPOINT_FALLBACKS,
  AGY_IDE_TYPE,
  AGY_PLATFORM_ENUM,
  AGY_VERSION_FALLBACK,
} from '../src/oauth/constants.ts'

const record = JSON.parse(readFileSync(new URL('../docs/official-identity.json', import.meta.url), 'utf8')) as {
  version: {
    claimedLine: string
    installed: { value: string }
    feed: { latest: string; url: string }
    namespacesAreDisjoint: Record<string, string>
  }
  clientMetadata: { enums: Record<string, string[]>; ours: { ideType: { value: string }; platform: { value: string } } }
  userAgentProfiles?: { default?: string }
  version: {
    claimedLine: string
    installed: { value: string }
    feed: { latest: string; url: string }
    namespacesAreDisjoint: Record<string, string>
    hubProfileFallback?: string
  }
  endpoints: { baseUrls: string[]; knownDeviations?: { extraInOurs?: { host?: string }; missingFromOurs?: { host?: string } } }
  headers: { absentFromBothBinaries: { names: string[] }; presentInCli: Record<string, unknown> }
}

const args = process.argv.slice(2)
function flagValue(name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const failures: string[] = []
function fail(message: string): void {
  failures.push(message)
  console.log(`FAIL ${message}`)
}
function ok(message: string): void {
  console.log(`ok   ${message}`)
}

// ---------------------------------------------------------------- our side

console.log('--- compiled values vs the record ---')

// The compiled fallback belongs to the line the ACTIVE UA PROFILE draws from, not
// to a single global "claimed product": the credentials are the CLI's while the
// identity presented on the wire is switchable (see `ua-profile.ts`). So the
// assertion is "the fallback matches the DEFAULT profile's line", which is what
// the record's `userAgentProfiles.default` names.
const defaultProfile = (record.userAgentProfiles?.default ?? 'electron')
const fallbackLine = AGY_VERSION_FALLBACK.split('.')[0]
// Each line's own feed entry, so a mismatch names the value it should have been.
const lineFeed = defaultProfile === 'cli' ? record.version.feed.latest : record.version.hubProfileFallback
if (typeof lineFeed !== 'string') {
  fail(
    `record has no version to compare against for the default UA profile "${defaultProfile}"; ` +
      'add `version.hubProfileFallback` (or `version.feed.latest` for the CLI profile)',
  )
} else if (fallbackLine !== lineFeed.split('.')[0]) {
  fail(
    `AGY_VERSION_FALLBACK is ${AGY_VERSION_FALLBACK} but the default profile "${defaultProfile}" draws from line ` +
      `${lineFeed.split('.')[0]}.x (recorded value ${lineFeed}); the fallback must name a version on THAT line, ` +
      'because a number from the other line is retired on the data plane AND drops the Gemini quota group',
  )
} else {
  ok(`AGY_VERSION_FALLBACK ${AGY_VERSION_FALLBACK} is on the default profile's line (${defaultProfile}, ${lineFeed.split('.')[0]}.x)`)
}

// The CLI line has its OWN floor, and it must name a CLI-line release: reusing
// the hub floor here is what made the CLI profile emit `antigravity/cli/2.28.2`.
const cliMajor = record.version.feed.latest.split('.')[0]
if (AGY_CLI_VERSION_FALLBACK.split('.')[0] !== cliMajor) {
  fail(
    `AGY_CLI_VERSION_FALLBACK is ${AGY_CLI_VERSION_FALLBACK} but the CLI feed latest is ${record.version.feed.latest}; ` +
      'the CLI shape must carry a CLI-line version or the data plane retires it',
  )
} else {
  ok(`AGY_CLI_VERSION_FALLBACK ${AGY_CLI_VERSION_FALLBACK} is on the CLI line (${cliMajor}.x)`)
}

// The version pool must stay inside ONE namespace. This is the check that would
// have caught the original defect, where the pool held IDE 2.x numbers while the
// rest of the client was drifting toward the CLI line.
const pool = JSON.parse(
  readFileSync(new URL('../src/runtime/fingerprint-data.json', import.meta.url), 'utf8'),
) as { versionPool?: string[] }
// The pool belongs to the DEFAULT profile's line, for the same reason the
// fallback does. A pool spanning two lines advertises a version that does not
// exist for the product named beside it.
const major = (typeof lineFeed === 'string' ? lineFeed : AGY_VERSION_FALLBACK).split('.')[0]
const offLine = (pool.versionPool ?? []).filter((v) => v.split('.')[0] !== major)
if (offLine.length > 0) {
  fail(
    `fingerprint-data.json versionPool mixes namespaces: ${offLine.join(', ')} are not ${major}.x versions. ` +
      `The IDE (${record.version.namespacesAreDisjoint['ide']}) and hub (${record.version.namespacesAreDisjoint['hub']}) ` +
      `lines are different products, so a pool spanning them advertises a version that does not exist for "${defaultProfile}".`,
  )
} else {
  ok(`versionPool is ${major}.x only (${(pool.versionPool ?? []).join(', ')})`)
}

for (const [field, value] of [
  ['IdeType', AGY_IDE_TYPE],
  ['Platform', AGY_PLATFORM_ENUM],
] as const) {
  const allowed = record.clientMetadata.enums[field] ?? []
  if (!allowed.includes(value)) {
    fail(`${field} value ${value} is not in the official enum (${allowed.join(' | ')})`)
  } else {
    ok(`${field} ${value} is a member of the official enum`)
  }
}

// A host we use that the artifact does not name is allowed ONLY when the record
// declares it. The point is not that the two lists must be identical — it is that
// a divergence must be a recorded decision, not an inheritance from another
// implementation that nobody re-checked.
const declared = new Set(
  [record.endpoints.knownDeviations?.extraInOurs?.host, record.endpoints.knownDeviations?.missingFromOurs?.host]
    .filter((host): host is string => typeof host === 'string'),
)
const unknownEndpoint = AGY_ENDPOINT_FALLBACKS.filter(
  (url) => !record.endpoints.baseUrls.includes(url) && !declared.has(url),
)
if (unknownEndpoint.length > 0) {
  fail(
    `AGY_ENDPOINT_FALLBACKS contains hosts absent from the record and undeclared in ` +
      `endpoints.knownDeviations: ${unknownEndpoint.join(', ')}. Add the host to the record, or declare the deviation.`,
  )
} else {
  ok(`all ${AGY_ENDPOINT_FALLBACKS.length} fallback endpoints are recorded (named or declared)`)
}

// ------------------------------------------------------------- the artifact

console.log('\n--- installed official CLI ---')

const cliPath = flagValue('--cli') ?? '/usr/local/bin/agy'
if (!existsSync(cliPath)) {
  console.log(`skip binary checks: ${cliPath} is not installed (unmeasurable, not a failure)`)
} else {
  try {
    const version = execFileSync(cliPath, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim()
    if (version === record.version.installed.value) {
      ok(`installed CLI is ${version}, matching the record`)
    } else {
      console.log(
        `warn installed CLI is ${version} but the record says ${record.version.installed.value}. ` +
          'Re-read the artifact and update the record (a new release may have changed the identity surface).',
      )
    }
  } catch (error) {
    console.log(`skip version check: ${cliPath} --version failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // The absence claims are the load-bearing ones: every header in this list is a
  // shape we must NOT send. Re-checking them against the artifact is what keeps
  // the list from being quietly re-populated by a future contributor reading a
  // blog post.
  const binary = readFileSync(cliPath)
  for (const name of record.headers.absentFromBothBinaries.names) {
    if (binary.includes(Buffer.from(name, 'utf8'))) {
      fail(
        `header "${name}" IS present in ${cliPath}, but the record lists it as absent. ` +
          'Re-read the artifact: the identity surface changed, and the "invented header" conclusion may no longer hold.',
      )
    } else {
      ok(`"${name}" is still absent from the artifact`)
    }
  }
  for (const name of Object.keys(record.headers.presentInCli)) {
    if (!binary.includes(Buffer.from(name, 'utf8'))) {
      fail(`header "${name}" is recorded as present in the CLI but was not found`)
    } else {
      ok(`"${name}" is still present in the artifact`)
    }
  }
}

// --------------------------------------------------------------- the feed

console.log('\n--- release feed ---')

let live: string | undefined
try {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(record.version.feed.url, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json' },
    })
    if (response.ok) {
      const payload = (await response.json()) as { tag_name?: string }
      live = payload.tag_name
    }
  } finally {
    clearTimeout(timer)
  }
} catch {
  live = undefined
}

if (live === undefined) {
  console.log('UNMEASURABLE the CLI release feed could not be read')
} else if (live === record.version.feed.latest) {
  ok(`feed latest is still ${live}`)
} else {
  console.log(
    `warn feed latest is ${live} but the record says ${record.version.feed.latest}. ` +
      'Update version.feed.latest in docs/official-identity.json (and AGY_VERSION_FALLBACK if the minor moved).',
  )
}

// ------------------------------------------------------------------ verdict

console.log('')
if (failures.length > 0) {
  console.log(`FAILED ${failures.length} check(s) against docs/official-identity.json`)
  process.exit(1)
}
console.log('official identity record is consistent with the compiled values and the artifact')
