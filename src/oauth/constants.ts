/**
 * Antigravity (agy) OAuth and API constants.
 *
 * The client id/secret below are the public Google consumer-OAuth credentials
 * shipped inside the Antigravity desktop product and its `agy` CLI; they are
 * embedded in many public tools (see NOTICE.md). They are not secrets owned by
 * this project.
 */

import { proxiedFetch } from '../proxy.ts'
import { isProxyRouted } from '../types.ts'
import type { AccountRouting } from '../types.ts'
import { HUB_VERSION_FALLBACK } from '../ua-profile-types.ts'

export const AGY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export const AGY_CLIENT_SECRET = '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'

/**
 * Effective OAuth client credentials: AGY_CLIENT_ID / AGY_CLIENT_SECRET env
 * overrides win when set (BYO OAuth app escape hatch, mirrors pi-antigravity);
 * otherwise the embedded public Antigravity credentials are used.
 */
export function resolveAgyClientCredentials(overrideClientId?: string): { clientId: string; clientSecret: string } {
  if (overrideClientId) {
    if (overrideClientId === AGY_CLIENT_ID) {
      return { clientId: AGY_CLIENT_ID, clientSecret: AGY_CLIENT_SECRET }
    }
    return {
      clientId: overrideClientId,
      clientSecret: process.env.AGY_CLIENT_SECRET || AGY_CLIENT_SECRET,
    }
  }
  return {
    clientId: process.env.AGY_CLIENT_ID || AGY_CLIENT_ID,
    clientSecret: process.env.AGY_CLIENT_SECRET || AGY_CLIENT_SECRET,
  }
}

/** Required scopes. `openid` must NOT be added: it routes Google into the hanging
 * `firstparty/nativeapp` consent for this client (verified by OmniRoute). */
export const AGY_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo'

/** Default loopback callback used by the standalone CLI listener (fixed port, like opencode). */
export const AGY_DEFAULT_REDIRECT_URI = 'http://localhost:51121/oauth-callback'

/**
 * Antigravity API endpoints. The daily runtime host (no .sandbox suffix) is the
 * live endpoint for consumer OAuth accounts — cloudcode-pa.googleapis.com
 * answers RESOURCE_EXHAUSTED for them (verified by live probe), while the
 * daily host answers 200. Order matters: first reachable non-429/403/503 wins.
 */
export const AGY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
export const AGY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
export const AGY_ENDPOINT_DAILY_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
export const AGY_ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com'

/** Runtime/bootstrap endpoint fallback order (daily first, mirroring OmniRoute). */
export const AGY_ENDPOINT_FALLBACKS: readonly string[] = [
  AGY_ENDPOINT_DAILY,
  AGY_ENDPOINT_PROD,
  AGY_ENDPOINT_DAILY_SANDBOX,
  AGY_ENDPOINT_AUTOPUSH,
]

/**
 * Statuses that mean "this endpoint is not usable for this attempt"; skip to the
 * next one in the chain. 429/403 = rate/quota/entitlement wall, 503 = capacity
 * rejection (e.g. "No capacity available for model ..."). A 503 skipped here
 * still reaches the caller when every endpoint fails, where the classifier marks
 * it transient and the adapter surfaces it as a retryable SERVER error.
 */
export const AGY_ENDPOINT_SKIP_STATUSES = new Set([429, 403, 503])

/** Routing of the requests being tried (see {@link AccountRouting}). */
export type AgyFallbackOptions = Pick<AccountRouting, 'proxyUrl'>
/**
 * Try each runtime endpoint in order, skipping unusable ones (429/403/503/network).
 * Returns the first other response (2xx or a real error like 400/401); when
 * every endpoint is unusable, returns the last skipped response so the caller's
 * classifier can still produce a meaningful error (a returned 503 becomes a
 * retryable SERVER failure rather than being swallowed here).
 *
 * When every endpoint fails at the network level, the LAST error is rethrown so
 * its cause survives (a generic "all endpoints failed" hid DNS/TLS/timeout).
 */
export async function fetchAgyFirstOk(
  urlPath: string,
  init: RequestInit,
  fetchImpl: typeof fetch = proxiedFetch,
  options: AgyFallbackOptions = {},
): Promise<Response> {
  let lastSkipped: Response | null = null
  let lastNetworkError: unknown
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}${urlPath}`, init)
      if (!AGY_ENDPOINT_SKIP_STATUSES.has(response.status)) return response
      // Prefer keeping a 429 or 503 response from earlier production endpoints
      // rather than letting the internal autopush sandbox 403 (which always fails for
      // consumer accounts with "no license") overwrite the real rate-limit/capacity signal.
      if (!lastSkipped || (baseEndpoint !== AGY_ENDPOINT_AUTOPUSH && (response.status === 429 || response.status === 503))) {
        lastSkipped = response
      }
    } catch (error) {
      lastNetworkError = error
      // Fail-closed only while an explicit per-account proxy is in effect: the
      // request must not be retried on another endpoint or go direct.
      if (isProxyRouted(options)) {
        const { isProxyUnreachableError } = await import('../proxy.ts')
        if (isProxyUnreachableError(error)) throw error
      }
      // network error — try the next endpoint
    }
  }
  if (lastSkipped) return lastSkipped
  if (lastNetworkError !== undefined) throw lastNetworkError
  throw new Error('all agy endpoints failed')
}

/**
 * Pinned Antigravity version, used only until the runtime resolver has published
 * a fresh one (see {@link setResolvedAgyVersion}).
 *
 * A stale version string is the most detectable fingerprint anomaly, so this
 * value is a cold-start floor, not the version anything should normally send.
 * It tracks the release feed's newest entry; refresh it when the feed moves.
 *
 * NAMESPACE: this is the **hub** line, the product this client presents
 * as by default (`src/ua-profile.ts`, `docs/official-identity.json`). The three
 * Antigravity lines are separate version namespaces — IDE `2.x`/`1.2x`, hub
 * `2.2x`, CLI `1.5.x` — so comparing them numerically is meaningless, and mixing
 * them advertises a version that does not exist for the product named.
 *
 * A version from the WRONG line is not merely stale: measured 2026-11-09, an
 * `antigravity/hub/` string carrying `1.5.3` is answered with the "no longer
 * supported" notice on generation AND returns only ONE quota group. The CLI line
 * has its own slot ({@link currentAgyVersion} is the hub slot; the CLI profile
 * reads the CLI feed through `ua-profile.ts`).
 */
export const AGY_VERSION_FALLBACK = '2.29.0'
export const AGY_HUB_CHANGELIST = '1003475615'

/**
 * `ClientMetadata.platform` value: the proto enum NAME, as protobuf-JSON emits it.
 *
 * The official enumeration is `PLATFORM_UNSPECIFIED | DARWIN_AMD64 | DARWIN_ARM64
 * | LINUX_AMD64 | LINUX_ARM64 | WINDOWS_AMD64` (read from the installed official
 * CLI's own descriptor). The earlier `"MACOS"` that this backend rejected with
 * `INVALID_ARGUMENT` was an invalid *value*, not a forbidden field — a
 * distinction that mattered, because it had been read as "send `ideType` only".
 */
export const AGY_PLATFORM_ENUM = 'DARWIN_ARM64'

/**
 * Newest Antigravity version the runtime resolver has observed, or undefined
 * before its first success.
 *
 * Deliberately lives in this module — the dependency leaf — rather than in
 * `runtime/version.ts`. `oauth/` must not import `runtime/` (AGENTS.md), and the
 * edge already runs the other way: `runtime/version.ts` imports THIS file. So the
 * resolver publishes here and every User-Agent builder reads here.
 *
 * This shape is the fix for a real defect: the version used to be a function
 * parameter, and all six bootstrap call sites silently took the default, pinning
 * every control-plane request to the stale fallback while the data plane used the
 * resolved version — one process presenting two different clients. Reading a
 * shared value makes that drift unrepresentable rather than merely discouraged.
 */
let resolvedAgyVersion: string | undefined

/** Publish a freshly resolved version for every User-Agent builder. */
export function setResolvedAgyVersion(version: string | undefined): void {
  resolvedAgyVersion = version
}

/** Version a User-Agent should advertise: the resolved one, else the pinned floor. */
export function currentAgyVersion(): string {
  return resolvedAgyVersion ?? AGY_VERSION_FALLBACK
}

/**
 * The hub desktop app's User-Agent: `antigravity/hub/<ver> (<tokens>)`.
 *
 * The SHAPE and the `cl=` token are upstream's, not invented here: the installed
 * app spawns its language server with `--override_user_agent_name antigravity
 * --subclient_type hub --override_ide_version <app version>`, the binary's own
 * diagnostic format is `%s/%s (%s)`, and the parenthesized vocabulary
 * (`aidev_client`, `os_type=`, `arch=`, `cl=`) is its string blob.
 *
 * MEASURED 2026-11-09 on one account, one model, one prompt, one session id per
 * probe, each version repeated three times, varying only the version inside this
 * shape:
 *
 *   2.6.0 / 2.7.0 / 2.8.0 / 2.9.0 / 2.10.0 / 2.15.0 / 2.20.0 / 2.25.0 /
 *   2.28.2 / 2.29.0 / 3.0.0        -> 200 + finishReason, quota 2 groups
 *   2.1.0 / 2.2.0 / 2.4.0 / 2.5.0  -> 200 + retirement notice, quota 1 group
 *   1.5.3 (the CLI line)           -> 200 + retirement notice, quota 1 group
 *
 * Two consequences that are easy to get wrong: the gate is PER-VERSION and not
 * monotonic (2.0.0 and 2.3.0 are served while 2.1/2.2/2.4/2.5 are not), and the
 * version LINE matters beyond servability — a `1.x` value inside this shape also
 * drops the `Gemini Models` quota group.
 */
export function agyHubUserAgent(
  version = currentHubVersion(),
  platform = 'darwin/arm64',
): string {
  const [rawOs = 'darwin', arch = 'arm64'] = platform.split('/')
  // `os_type=` carries the operating system's name, a different vocabulary from
  // the UA's Go-style `darwin/arm64` token — the same distinction the CLI shape
  // makes. `darwin` is not the spelling measured on this field, so it is mapped.
  const osType = rawOs === 'darwin' ? 'macos' : rawOs
  return `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_HUB_CHANGELIST})`
}

/**
 * Newest hub-app version the runtime resolver has observed.
 *
 * A SEPARATE slot from {@link resolvedAgyVersion} would be redundant here — this
 * module has ONE hub slot now — but it is kept as a distinct NAME so callers read
 * intent rather than a bare variable, and so the CLI line can never be published
 * into it by accident (see `ua-profile.ts`).
 */
let resolvedHubVersion: string | undefined

/** Publish a freshly resolved hub version for the hub UA builder. */
export function setResolvedHubVersion(version: string | undefined): void {
  resolvedHubVersion = version
  // The bootstrap builder reads `resolvedAgyVersion`, so keep the two in step:
  // there is ONE hub version in this process, and two slots holding different
  // numbers is exactly the drift this module exists to make unrepresentable.
  resolvedAgyVersion = version
}

/**
 * Newest version the runtime resolver has observed on the **CLI** feed.
 *
 * A THIRD slot, and it is not redundant: the hub manifest and the CLI releases
 * are different products with disjoint numbering, and both are live at once
 * (`resolveObservedAgyVersion` reads the hub first, `resolveAntigravityCliVersion`
 * the CLI). Without this, `currentAgyVersion()` — the hub slot — became the CLI
 * profile's version too, so selecting the CLI profile emitted
 * `antigravity/cli/<hub version>`: a hub number inside a CLI shape, exactly the
 * line mismatch that retires the request.
 */
let resolvedCliVersion: string | undefined

/** Publish a freshly resolved CLI-line version. */
export function setResolvedCliVersion(version: string | undefined): void {
  resolvedCliVersion = version
}

/**
 * Cold-start floor for the **CLI** line.
 *
 * A SEPARATE constant from {@link AGY_VERSION_FALLBACK} because that one is the
 * HUB line's floor. Reusing it here made the CLI profile advertise
 * `antigravity/cli/<hub version>` whenever its feed had not been read yet — a hub
 * number inside a CLI shape, i.e. precisely the mismatch that retires the request
 * and drops the Gemini quota group. This value tracks the LIVE CLI release feed
 * (what ships to every user), not whatever `agy --version` reports on one
 * machine, and `pnpm run verify:version-freshness` checks it against that feed
 * on every run.
 */
export const AGY_CLI_VERSION_FALLBACK = '1.5.3'

/** Version the CLI UA should advertise: the observed CLI one, else its own floor. */
export function currentCliVersion(): string {
  return resolvedCliVersion ?? AGY_CLI_VERSION_FALLBACK
}

/** Version the hub UA should advertise: the observed one, else the floor. */
export function currentHubVersion(): string {
  return resolvedHubVersion ?? resolvedAgyVersion ?? HUB_VERSION_FALLBACK
}

/**
 * UA used for the control-plane/bootstrap calls (loadCodeAssist/onboardUser,
 * model discovery, the quota summary probe, OAuth exchange).
 *
 * NOT its own template — it renders the ACTIVE UA PROFILE, so the bootstrap
 * identity and the generation identity cannot disagree. A fixed template with a
 * borrowed version was a real defect twice over: the version came from the CLI
 * line while the shape was the hub's, and on THIS channel that mismatch is
 * functional rather than cosmetic — it decides whether `retrieveUserQuotaSummary`
 * returns the `Gemini Models` group at all (see `ua-profile.ts`).
 */
export function getAgyBootstrapUserAgent(version?: string): string {
  return renderActiveProfileUserAgent(version)
}

/**
 * Injection seam for the profile renderer.
 *
 * Set once by `ua-profile.ts` when it loads, which is guaranteed before any
 * bootstrap request: every caller of this function sits behind the session
 * runtime, and that runtime imports the profile store. Until it is set, the
 * hub builder with its own live version is used — a valid identity, and the
 * same one the default profile would produce.
 */
let profileRenderer: ((version?: string) => string) | undefined

/** Called by `ua-profile.ts` to bind the active-profile renderer. */
export function setProfileUserAgentRenderer(renderer: ((version?: string) => string) | undefined): void {
  profileRenderer = renderer
}

/** Render through the bound profile, or the default hub identity. */
function renderActiveProfileUserAgent(version?: string): string {
  if (profileRenderer) return profileRenderer(version)
  return agyHubUserAgent(version ?? currentHubVersion())
}

/**
 * The CLI's own User-Agent: `antigravity/cli/<version> (<tokens>)`.
 *
 * MEASURED (2026-11-08, live `streamGenerateContent` against both daily and
 * prod, alternating the shape on ONE account at one version so only the shape
 * varied):
 *
 *   antigravity/cli/1.5.2 ...  -> 200, a real answer
 *   antigravity/1.5.2 darwin/arm64 -> 200, "This version of Antigravity is no
 *                                     longer supported. ..." as ordinary text
 *
 * That short form is the data-plane gate: the backend accepts it as a client but
 * refuses to serve it, and the refusal is an HTTP-200 plain-text notice carrying
 * NO `finishReason` — so `parse.ts`'s completeness guard reports it as "stream
 * terminated prematurely". `os_type`/`arch` are unvalidated (measured); the shape
 * is what matters.
 */
export function agyCliUserAgent(version = currentCliVersion(), platform = 'darwin/arm64'): string {
  const [rawOs = 'darwin', arch = 'arm64'] = platform.split('/')
  // The UA's own platform TOKEN is Go-style (`darwin/arm64`), while `os_type=`
  // carries the operating system's name (`macos`) — two vocabularies for one
  // fact. The `macos` spelling is the one measured accepted.
  const osType = rawOs === 'darwin' ? 'macos' : rawOs
  return `antigravity/cli/${version} (aidev_client; os_type=${osType}; arch=${arch}; auth_method=consumer)`
}

/**
 * The client User-Agent, as the version feeds and non-generation probes send it.
 *
 * A THIN ALIAS of {@link agyHubUserAgent}, not a second template: the hub
 * shape is the only non-CLI shape this client emits, and keeping two copies of
 * that template is how the two drift into different `cl=` values or platform
 * spellings. Callers that want the CLI shape ask {@link agyCliUserAgent}.
 */
export function antigravityUserAgent(version = currentAgyVersion(), platform = 'darwin/arm64'): string {
  return agyHubUserAgent(version, platform)
}

/**
 * `ClientMetadata.ideType` value.
 *
 * `ANTIGRAVITY` is retained rather than switched to the enumeration's newer
 * `GEMINI_CLI`: the CLI's own `IdeType` is injected through its auth provider and
 * has not been captured, so the established working value is kept and the
 * alternative recorded (`docs/official-identity.json`) rather than guessed at.
 */
export const AGY_IDE_TYPE = 'ANTIGRAVITY'
