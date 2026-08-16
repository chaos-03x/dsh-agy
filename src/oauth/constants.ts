/**
 * Antigravity (agy) OAuth and API constants.
 *
 * The client id/secret below are the public Google consumer-OAuth credentials
 * shipped inside the Antigravity desktop product and its `agy` CLI; they are
 * embedded in many public tools (see NOTICE.md). They are not secrets owned by
 * this project.
 */

import { proxiedFetch } from '../proxy.ts'

export const AGY_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'

export const AGY_CLIENT_SECRET = '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'

/**
 * Effective OAuth client credentials: AGY_CLIENT_ID / AGY_CLIENT_SECRET env
 * overrides win when set (BYO OAuth app escape hatch, mirrors pi-antigravity);
 * otherwise the embedded public Antigravity credentials are used.
 */
export function resolveAgyClientCredentials(): { clientId: string; clientSecret: string } {
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
 * daily host answers 200. Order matters: first reachable non-429/403 wins.
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

/** Statuses that mean "this endpoint is not usable for this account"; skip to the next. */
export const AGY_ENDPOINT_SKIP_STATUSES = new Set([429, 403])

/**
 * Try each runtime endpoint in order, skipping unusable ones (429/403/network).
 * Returns the first other response (2xx or a real error like 400/401); when
 * every endpoint is unusable, returns the last skipped response so the caller's
 * classifier can still produce a meaningful error.
 */
export async function fetchAgyFirstOk(
  urlPath: string,
  init: RequestInit,
  fetchImpl: typeof fetch = proxiedFetch,
): Promise<Response> {
  let lastSkipped: Response | null = null
  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const response = await fetchImpl(`${baseEndpoint}${urlPath}`, init)
      if (!AGY_ENDPOINT_SKIP_STATUSES.has(response.status)) return response
      lastSkipped = response
    } catch {
      // network error — try the next endpoint
    }
  }
  if (lastSkipped) return lastSkipped
  throw new Error('all agy endpoints failed')
}

/** Default Antigravity client version used in User-Agent strings; overridden by the
 * runtime version fetcher (see runtime/fingerprint.ts). */
export const AGY_VERSION_FALLBACK = '1.18.3'

/** Electron-style UA used for bootstrap calls (loadCodeAssist/onboardUser). */
export function getAgyBootstrapUserAgent(version = AGY_VERSION_FALLBACK): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${version} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`
}

/** Client-Metadata payload for bootstrap calls — ideType only (backend enum
 * validation rejects freely-added platform/pluginType; AGENTS.md invariant). */
export function getAgyBootstrapClientMetadata(): string {
  return '{"ideType":"ANTIGRAVITY"}'
}
