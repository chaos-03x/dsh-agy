/**
 * Proxy-aware fetch: respects the standard HTTP_PROXY / HTTPS_PROXY / NO_PROXY
 * environment variables (lowercase variants included) via undici's
 * EnvHttpProxyAgent. Applied per-request through the `dispatcher` option so the
 * plugin never mutates the host process's global dispatcher — DSH's own fetch
 * calls stay untouched.
 */

import { EnvHttpProxyAgent } from 'undici'

/**
 * Normalize an env proxy value before handing it to undici: a schemeless
 * value (`127.0.0.1:7890`) makes EnvHttpProxyAgent throw "Invalid URL" at
 * construction time — which would take the whole plugin down at import, not
 * just the proxied requests. Written-in schemes (http://, socks5://, ...)
 * pass through untouched; empty values mean "not configured".
 */
export function normalizeProxyUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
}

function readProxyEnv(name: string): string | undefined {
  return process.env[name] ?? process.env[name.toLowerCase()]
}

function buildProxyAgent(): EnvHttpProxyAgent {
  // Pass explicit values only when present; an unset variable must not leak
  // an undefined override into the agent's own env reading.
  const options: EnvHttpProxyAgent.Options = {}
  const httpProxy = normalizeProxyUrl(readProxyEnv('HTTP_PROXY'))
  if (httpProxy !== undefined) options.httpProxy = httpProxy
  const httpsProxy = normalizeProxyUrl(readProxyEnv('HTTPS_PROXY'))
  if (httpsProxy !== undefined) options.httpsProxy = httpsProxy
  const noProxy = readProxyEnv('NO_PROXY')
  if (noProxy !== undefined && noProxy.length > 0) options.noProxy = noProxy
  return new EnvHttpProxyAgent(options)
}

const agent = buildProxyAgent()

/** The proxy agent built from the environment (exported for tests). */
export const proxyAgent = agent

/** fetch() that routes through the env-configured proxy when one is set. */
export const proxiedFetch: typeof fetch = (input, init) =>
  // The Dispatcher type in undici's own types drifts from the undici-types
  // bundled with @types/node; the runtime interface is stable across versions.
  fetch(input, { ...init, dispatcher: agent as any })
