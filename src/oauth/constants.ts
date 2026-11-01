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
 * NAMESPACE: this is the **Antigravity CLI** line (`google-antigravity/antigravity-cli`),
 * not the IDE or hub line, because that is the product this client claims to be
 * (`docs/official-identity.json`). The three lines are separate version
 * namespaces — IDE `2.0.0`, hub `2.15.1`, CLI `1.2.9` — so comparing them
 * numerically is meaningless and mixing them advertises a version that does not
 * exist for the product we name.
 */
export const AGY_VERSION_FALLBACK = '2.25.0'
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

/** Electron-style UA used for bootstrap calls (loadCodeAssist/onboardUser). */
export function getAgyBootstrapUserAgent(version = currentAgyVersion()): string {
  return `antigravity/hub/${version} (aidev_client; os_type=darwin; arch=arm64; cl=${AGY_HUB_CHANGELIST})`
}

/**
 * Short-form client User-Agent: `antigravity/<version> <platform>`.
 *
 * Used where the full Electron string would be inappropriate but the request
 * must still not self-identify as this tool (e.g. the version feeds, which the
 * official client ecosystem also polls).
 */
export function antigravityUserAgent(version = currentAgyVersion(), platform = 'darwin/arm64'): string {
  const [osType = 'darwin', arch = 'arm64'] = platform.split('/')
  return `antigravity/hub/${version} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_HUB_CHANGELIST})`
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
