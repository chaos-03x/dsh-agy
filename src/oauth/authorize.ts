/** Build the Antigravity OAuth authorization URL with PKCE and project metadata. */

import {
  AGY_SCOPES,
  OAUTH_AUTHORIZE_URL,
  resolveAgyClientCredentials,
} from './constants.ts'
import { encodeState, generatePkcePair } from './pkce.ts'

export interface AntigravityAuthorization {
  url: string
  verifier: string
  projectId: string
  /** Raw state payload embedded in the URL (for server-side binding). */
  state: string
}

/**
 * Build the Google OAuth authorization URL for the Antigravity client.
 * The `state` payload carries the PKCE verifier and an optional project id so a
 * headless callback can be pasted back verbatim.
 * @param redirectUri - loopback callback URI (harness webServer route or CLI listener).
 * @param projectId - optional Antigravity project id to bind this login to.
 */
export async function authorizeAntigravity(
  redirectUri: string,
  projectId = '',
): Promise<AntigravityAuthorization> {
  const { verifier, challenge } = generatePkcePair()

  const url = new URL(OAUTH_AUTHORIZE_URL)
  const { clientId } = resolveAgyClientCredentials()
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', AGY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  const state = encodeState({ verifier, projectId: projectId || '' })
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')

  return { url: url.toString(), verifier, projectId: projectId || '', state }
}
