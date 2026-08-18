/**
 * Refresh an agy access token, handling Google's varied error payload shapes and
 * marking revocation (`invalid_grant`) distinctly so callers can drop the account.
 */

import type { OAuthAuthDetails } from '../types.ts'
import { calculateTokenExpiry, formatRefreshParts, parseRefreshParts } from './auth.ts'
import { AGY_CLIENT_ID, OAUTH_TOKEN_URL, resolveAgyClientCredentials } from './constants.ts'
import { proxiedFetch } from '../proxy.ts'

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string
        status?: string
        message?: string
      }
  error_description?: string
}

export class AgyTokenRefreshError extends Error {
  code?: string
  description?: string
  status: number
  statusText: string

  constructor(options: {
    message: string
    code?: string
    description?: string
    status: number
    statusText: string
  }) {
    super(options.message)
    this.name = 'AgyTokenRefreshError'
    this.code = options.code
    this.description = options.description
    this.status = options.status
    this.statusText = options.statusText
  }
}

/** Parse Google token-endpoint error payloads, tolerating varied shapes. */
export function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) return {}

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload
    if (!payload || typeof payload !== 'object') {
      return { description: text }
    }

    let code: string | undefined
    if (typeof payload.error === 'string') {
      code = payload.error
    } else if (payload.error && typeof payload.error === 'object') {
      code = payload.error.status ?? payload.error.code
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message }
      }
    }

    const description = payload.error_description
    if (description) return { code, description }

    if (payload.error && typeof payload.error === 'object' && payload.error.message) {
      return { code, description: payload.error.message }
    }

    return { code }
  } catch {
    return { description: text }
  }
}

export type RefreshResult =
  | { type: 'success'; auth: OAuthAuthDetails; clientId: string }
  | { type: 'revoked' }
  | { type: 'failed'; error: AgyTokenRefreshError }

/**
 * Refresh the access token for an account. `revoked` means Google rejected the
 * refresh token (`invalid_grant`) — the account must be re-authenticated.
 * For legacy accounts without a stored clientId, embedded credentials are tried
 * first with an env-override fallback before treating invalid_grant as fatal.
 */
export async function refreshAccessToken(auth: OAuthAuthDetails, options?: { clientId?: string }): Promise<RefreshResult> {
  const parts = parseRefreshParts(auth.refresh)
  if (!parts.refreshToken) {
    return { type: 'failed', error: new AgyTokenRefreshError({
      message: 'Missing refresh token',
      status: 400,
      statusText: 'Bad Request',
    }) }
  }

  // Candidate client IDs to try: explicit stored clientId first; for legacy
  // accounts, try embedded first, then env override (if distinct).
  const candidateIds = options?.clientId
    ? [options.clientId]
    : Array.from(new Set([AGY_CLIENT_ID, process.env.AGY_CLIENT_ID].filter((id): id is string => Boolean(id && id.length > 0))))

  let revokedCount = 0
  let transientFailure: RefreshResult | undefined

  for (const currentClientId of candidateIds) {
    try {
      const startTime = Date.now()
      const { clientId, clientSecret } = resolveAgyClientCredentials(currentClientId)
      const response = await proxiedFetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: parts.refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => undefined)
        const { code, description } = parseOAuthErrorPayload(errorText)
        const details = [code, description ?? errorText].filter(Boolean).join(': ')
        const baseMessage = `Agy token refresh failed (${response.status} ${response.statusText})`
        const message = details ? `${baseMessage} - ${details}` : baseMessage

        if (code === 'invalid_grant') {
          revokedCount++
          continue // try next candidate if available before revoking
        }

        transientFailure = {
          type: 'failed',
          error: new AgyTokenRefreshError({
            message,
            code,
            description: description ?? errorText,
            status: response.status,
            statusText: response.statusText,
          }),
        }
        continue
      }
      const payload = (await response.json()) as {
        access_token: string
        expires_in?: number
        refresh_token?: string
      }

      const refreshedParts = {
        refreshToken: payload.refresh_token ?? parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
      }

      return {
        type: 'success',
        auth: {
          access: payload.access_token,
          expires: calculateTokenExpiry(startTime, payload.expires_in),
          refresh: formatRefreshParts(refreshedParts),
        },
        clientId,
      }
    } catch (error) {
      transientFailure = {
        type: 'failed',
        error: new AgyTokenRefreshError({
          message: error instanceof Error ? error.message : 'Unknown refresh error',
          status: 0,
          statusText: 'Network Error',
        }),
      }
    }
  }

  // If any candidate encountered a transient / inconclusive error, do NOT revoke.
  if (transientFailure) return transientFailure
  // Only if ALL candidates were definitively rejected with invalid_grant, revoke.
  if (revokedCount === candidateIds.length) return { type: 'revoked' }

  return {
    type: 'failed',
    error: new AgyTokenRefreshError({
      message: 'Token refresh failed on all candidate client IDs',
      status: 400,
      statusText: 'Bad Request',
    }),
  }
}
