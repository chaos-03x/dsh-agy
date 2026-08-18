/**
 * Exchange an authorization code for agy tokens, then resolve identity and
 * project via the Code Assist backend (userinfo + loadCodeAssist, multi-endpoint
 * fallback, best-effort).
 */

import type { TokenExchangeFailure, TokenExchangeResult } from '../types.ts'
import { calculateTokenExpiry } from './auth.ts'
import {
  AGY_ENDPOINT_FALLBACKS,
  OAUTH_TOKEN_URL,
  OAUTH_USERINFO_URL,
  getAgyBootstrapClientMetadata,
  getAgyBootstrapUserAgent,
  resolveAgyClientCredentials,
} from './constants.ts'
import { decodeState } from './pkce.ts'
import { proxiedFetch } from '../proxy.ts'

const FETCH_TIMEOUT_MS = 10_000

interface OAuthState {
  verifier: string
  projectId?: string
}

interface TokenPayload {
  access_token: string
  expires_in?: number
  refresh_token?: string
}

interface UserInfo {
  email?: string
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await proxiedFetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

interface LoadCodeAssistData {
  cloudaicompanionProject?: unknown
  subscriptionInfo?: unknown
}

/** Build the metadata payload shared by loadCodeAssist and onboardUser.
 * Only `ideType` is sent: `platform`/`pluginType` values are rejected by the
 * backend's enum validation (verified live: INVALID_ARGUMENT on "MACOS"), and
 * the official clients send ideType alone (OmniRoute capture). */
function bootstrapMetadata(): Record<string, string> {
  return { ideType: 'ANTIGRAVITY' }
}

function extractProjectId(data: LoadCodeAssistData): string {
  const project = data.cloudaicompanionProject
  if (typeof project === 'string' && project) return project
  const record = project as { id?: string } | undefined
  return record && typeof record.id === 'string' && record.id ? record.id : ''
}

/**
 * Extract the subscription tier id used for onboardUser, mirroring OmniRoute's
 * codeAssistSubscription: paid → current → default allowed → legacy-tier.
 */
export function extractOnboardTierId(subscriptionInfo: unknown): string {
  const subscription = (subscriptionInfo ?? {}) as Record<string, unknown>
  const tierOf = (value: unknown, field: 'name' | 'id'): string | null => {
    const record = value as Record<string, unknown> | undefined
    const picked = record?.[field]
    return typeof picked === 'string' && picked.trim() ? picked.trim() : null
  }

  const paidId = tierOf(subscription.paidTier, 'id')
  if (paidId) return paidId

  const ineligible = Array.isArray(subscription.ineligibleTiers) && subscription.ineligibleTiers.length > 0
  if (!ineligible) {
    const currentId = tierOf(subscription.currentTier, 'id')
    if (currentId) return currentId
  }

  if (Array.isArray(subscription.allowedTiers)) {
    for (const tierValue of subscription.allowedTiers) {
      const tier = tierValue as Record<string, unknown>
      if (tier.isDefault) {
        const defaultId = tierOf(tier, 'id')
        if (defaultId) return defaultId
      }
    }
  }

  const currentId = tierOf(subscription.currentTier, 'id')
  if (currentId) return currentId
  return 'legacy-tier'
}

/** Resolve project id + tier id via loadCodeAssist across fallback endpoints. */
export async function loadCodeAssist(accessToken: string): Promise<{ projectId: string; tierId: string }> {
  const errors: string[] = []
  const loadHeaders: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getAgyBootstrapUserAgent(),
    'Client-Metadata': getAgyBootstrapClientMetadata(),
  }

  for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
    try {
      const url = `${baseEndpoint}/v1internal:loadCodeAssist`
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: loadHeaders,
        body: JSON.stringify({ metadata: bootstrapMetadata() }),
      })

      if (!response.ok) {
        const message = await response.text().catch(() => '')
        errors.push(`loadCodeAssist ${response.status} at ${baseEndpoint}${message ? `: ${message}` : ''}`)
        continue
      }

      const data = (await response.json()) as LoadCodeAssistData
      const projectId = extractProjectId(data)
      if (projectId) {
        return { projectId, tierId: extractOnboardTierId(data.subscriptionInfo) }
      }
      errors.push(`loadCodeAssist missing project id at ${baseEndpoint}`)
    } catch (error) {
      errors.push(
        `loadCodeAssist error at ${baseEndpoint}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { projectId: '', tierId: 'legacy-tier' }
}

/**
 * Onboard a new account (no Cloud Code project yet): POST onboardUser with the
 * tier id, then retry loadCodeAssist. Mirrors OmniRoute's postExchange flow
 * (bounded inline onboarding, 10 attempts × 5s).
 */
export async function onboardAndDiscoverProject(
  accessToken: string,
  tierId: string,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<{ projectId: string; tierId: string }> {
  // Bounded onboarding: 3 attempts with jittered delay (3-7s). Fixed-rhythm
  // long retry loops read as scripted automation to the upstream (OmniRoute
  // #9939 ban-safety hardening capped 10x5s to 3x3-7s).
  const maxAttempts = options.maxAttempts ?? 3
  const retryDelayMs = options.retryDelayMs ?? 3000 + Math.floor(Math.random() * 4000)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': getAgyBootstrapUserAgent(),
    'Client-Metadata': getAgyBootstrapClientMetadata(),
  }
  const metadata = bootstrapMetadata()

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      for (const baseEndpoint of AGY_ENDPOINT_FALLBACKS) {
        const response = await fetchWithTimeout(`${baseEndpoint}/v1internal:onboardUser`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ tier_id: tierId, metadata }),
        })
        if (!response.ok) continue
        const result = (await response.json()) as { done?: boolean }
        if (result.done === true) {
          const discovered = await loadCodeAssist(accessToken)
          if (discovered.projectId) return discovered
        }
      }
    } catch {
      // transient — retry
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
  }

  return { projectId: '', tierId }
}

/** Full bootstrap for a fresh account: discover the project, onboarding if needed. */
export async function bootstrapAccount(
  accessToken: string,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): Promise<{ projectId: string; tierId: string }> {
  const discovered = await loadCodeAssist(accessToken)
  if (discovered.projectId) return discovered
  return onboardAndDiscoverProject(accessToken, discovered.tierId, options)
}

/** Resolve the account's Cloud Code project id via loadCodeAssist across fallback endpoints. */
export async function fetchProjectID(accessToken: string): Promise<string> {
  return (await loadCodeAssist(accessToken)).projectId
}

/**
 * Exchange the authorization code (from the loopback callback) for access/refresh
 * tokens, resolve the email, and discover the project id.
 * @param code - the `code` query parameter from the redirect.
 * @param state - the `state` query parameter (encodes verifier + projectId).
 * @param redirectUri - must match the authorize() redirectUri.
 */
export async function exchangeAntigravity(
  code: string,
  state: string,
  redirectUri: string,
  expectedVerifier?: string,
): Promise<TokenExchangeResult> {
  try {
    const { verifier, projectId } = decodeState<OAuthState>(state)
    if (!verifier) {
      return { type: 'failed', error: 'Missing PKCE verifier in state' }
    }
    // The caller issued this authorization URL (the CLI holds the verifier;
    // the web entry stores it per state). A state from a different login — or
    // one fabricated by an attacker — must not be exchangeable into the store.
    if (expectedVerifier && verifier !== expectedVerifier) {
      return { type: 'failed', error: 'State does not match the issued authorization' }
    }

    const startTime = Date.now()
    const { clientId, clientSecret } = resolveAgyClientCredentials()
    const tokenResponse = await proxiedFetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Accept: '*/*',
        'User-Agent': getAgyBootstrapUserAgent(),
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      return { type: 'failed', error: errorText }
    }

    const tokenPayload = (await tokenResponse.json()) as TokenPayload

    const userInfoResponse = await proxiedFetch(`${OAUTH_USERINFO_URL}?alt=json`, {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
        'User-Agent': getAgyBootstrapUserAgent(),
      },
    })
    const userInfo: UserInfo = userInfoResponse.ok
      ? ((await userInfoResponse.json()) as UserInfo)
      : {}

    const refreshToken = tokenPayload.refresh_token
    if (!refreshToken) {
      return { type: 'failed', error: 'Missing refresh token in response' }
    }

    const effectiveProjectId = projectId || (await bootstrapAccount(tokenPayload.access_token)).projectId

    return {
      type: 'success',
      refresh: `${refreshToken}|${effectiveProjectId || ''}`,
      access: tokenPayload.access_token,
      expires: calculateTokenExpiry(startTime, tokenPayload.expires_in),
      email: userInfo.email,
      projectId: effectiveProjectId || '',
      clientId,
    }
  } catch (error) {
    const failure: TokenExchangeFailure = {
      type: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    return failure
  }
}
