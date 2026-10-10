/**
 * Proxy-aware fetch: per-account proxy (http/https/socks5) + env fallback.
 * - account.proxy present => per-account dispatcher (fail-closed, not affected by NO_PROXY)
 * - otherwise => EnvHttpProxyAgent (honours HTTP_PROXY/HTTPS_PROXY/NO_PROXY)
 * Applied per-request via dispatcher option so the host's global dispatcher stays untouched.
 */

import { EnvHttpProxyAgent, ProxyAgent } from 'undici'
import { createConnection } from 'node:net'
import { isProxyRouted } from './types.ts'
import type { AccountRouting } from './types.ts'
import { redactCredentials } from './redact.ts'

const envAgent = new EnvHttpProxyAgent()

/**
 * Streaming variant of the env agent. A generation stream may legitimately stay
 * silent for minutes mid-turn (reasoning), and undici's `bodyTimeout` is a
 * per-gap inactivity timer — the 30s control-plane value kills such a turn.
 * Only generation uses this agent; every other call keeps the short bound.
 */
const envStreamingAgent = new EnvHttpProxyAgent({ bodyTimeout: 0 })

/** The env proxy agent (exported for tests). */
export const proxyAgent = envAgent

/** The streaming env proxy agent (exported for tests). */
export const proxyStreamingAgent = envStreamingAgent

// ── Dispatcher cache, keyed `normalizedProxyUrl|stream` ──
// Entries live for the process, so the cache size tracks the number of DISTINCT
// proxy URLs in use rather than the account count. (It previously claimed to be
// "bounded by MAX_ACCOUNTS=10" — a constant nothing enforced.)
const dispatcherCache = new Map<string, any>()

// ── Proxy URL normalization ──
const SUPPORTED = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])

function defaultPort(protocol: string): string {
  if (protocol === 'https:') return '443'
  if (protocol === 'socks5:' || protocol === 'socks5h:') return '1080'
  return '8080'
}

export function normalizeProxyUrl(proxyUrl: string): string {
  let raw = proxyUrl.trim()
  if (!raw) throw new Error('[proxy] empty proxy URL')
  // alias socks:// -> socks5://
  if (raw.toLowerCase().startsWith('socks://')) raw = 'socks5://' + raw.slice('socks://'.length)
  // strip family marker before parse, re-append after
  const familyMatch = raw.match(/\?family=(ipv4|ipv6)$/)
  const familySuffix = familyMatch ? familyMatch[0] : ''
  const baseRaw = familySuffix ? raw.slice(0, -familySuffix.length) : raw

  let parsed: URL
  try {
    parsed = new URL(baseRaw)
  } catch {
    throw new Error(`[proxy] invalid proxy URL: ${proxyUrlForLogs(proxyUrl)}`)
  }
  // normalize socks5h -> socks5 (remote DNS, same agent)
  let protocol = parsed.protocol.toLowerCase()
  if (protocol === 'socks5h:') protocol = 'socks5:'
  if (!SUPPORTED.has(protocol) && protocol !== 'socks5:') {
    // allow socks5h already normalized
    if (!SUPPORTED.has(parsed.protocol.toLowerCase())) {
      throw new Error(`[proxy] unsupported protocol: ${parsed.protocol}`)
    }
  }
  // ensure protocol is one of http/https/socks5
  if (!['http:', 'https:', 'socks5:'].includes(protocol)) {
    throw new Error(`[proxy] unsupported protocol: ${parsed.protocol}`)
  }
  if (!parsed.hostname) throw new Error('[proxy] missing host')

  let port = parsed.port
  if (!port) port = defaultPort(protocol)
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('[proxy] invalid port')
  }
  // Build auth from the DECODED credentials. `URL.username`/`password` return the
  // percent-ENCODED substrings (not decoded, despite what the older comment here
  // claimed), so encoding them again double-encodes: `p@ss` became `p%2540ss`,
  // which the proxy decodes to the literal `p%40ss` and rejects. Decoding first
  // also makes this function idempotent, which matters because a stored proxy URL
  // is normalized again on every request.
  const auth = parsed.username
    ? `${encodeURIComponent(decodeURIComponent(parsed.username))}${parsed.password ? `:${encodeURIComponent(decodeURIComponent(parsed.password))}` : ''}@`
    : ''
  const normalizedBase = `${protocol}//${auth}${parsed.hostname}:${port}`
  return familySuffix ? `${normalizedBase}${familySuffix}` : normalizedBase
}

export function proxyUrlForLogs(proxyUrl: string): string {
  try {
    // handle family suffix
    const fam = proxyUrl.match(/\?family=(ipv4|ipv6)$/)
    const base = fam ? proxyUrl.slice(0, -fam[0].length) : proxyUrl
    const u = new URL(base)
    // A scheme-less `user:pass@host` parses "successfully" as the non-special
    // scheme `user:` with an empty host, which would render as `user://:8080` —
    // a misleading string in the very error message meant to explain the input.
    // Fall through to the redacting fallback instead of reporting a host that
    // was never in the input.
    if (!u.hostname) return redactCredentials(proxyUrl)
    const port = u.port || defaultPort(u.protocol)
    return `${u.protocol}//${u.hostname}:${port}`
  } catch {
    // Unparseable input is exactly the case that still holds credentials: this
    // value is embedded in `normalizeProxyUrl`'s error message, which reaches the
    // GUI and stderr. Returning the raw input leaked `user:pass` there, so the
    // fallback redacts instead of echoing.
    return redactCredentials(proxyUrl)
  }
}

// ── Proxy unreachable detection (mirrors OmniRoute proxyFetch.ts:30) ──
const PROXY_UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

function isLoopbackUrl(url: string | URL): boolean {
  try {
    const u = typeof url === 'string' ? new URL(url as string) : (url as URL)
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '::ffff:127.0.0.1'
  } catch {
    return false
  }
}

export function isProxyUnreachableError(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; cur && depth < 5 && !seen.has(cur); depth++) {
    seen.add(cur)
    if (cur && typeof cur === 'object') {
      const code = (cur as { code?: unknown }).code
      if (typeof code === 'string' && PROXY_UNREACHABLE_CODES.has(code)) return true
      const errorCode = (cur as { errorCode?: unknown }).errorCode
      if (errorCode === 'proxy_unreachable' || errorCode === 'PROXY_UNREACHABLE') return true
      const statusCode = (cur as { statusCode?: unknown }).statusCode
      if (statusCode === 503) {
        const m = (cur as { message?: unknown }).message
        if (typeof m === 'string' && m.includes('Proxy unreachable')) return true
      }
      const msg = (cur as { message?: unknown }).message
      if (typeof msg === 'string') {
        if (msg.includes('proxy_unreachable') || msg.includes('PROXY_UNREACHABLE')) return true
        for (const c of PROXY_UNREACHABLE_CODES) {
          if (msg.includes(c)) return true
        }
      }
    }
    cur = (cur as { cause?: unknown })?.cause
    // Also handle AggregateError.errors (undici Happy Eyeballs)
    if (!cur && (err as { errors?: unknown })?.errors && depth === 0) {
      const errs = (err as { errors?: unknown[] }).errors
      if (Array.isArray(errs)) {
        for (const e of errs) if (isProxyUnreachableError(e)) return true
      }
    }
  }
  return false
}

export function tagProxyUnreachable<T>(err: T): T {
  if (isProxyUnreachableError(err)) {
    const e = err as unknown as Error & { code?: string; errorCode?: string }
    e.code = 'PROXY_UNREACHABLE'
    e.errorCode = 'proxy_unreachable'
  }
  return err
}

// ── Fast-fail TCP reachability (2s, 30s healthy / 2s unhealthy cache) ──
const FAST_FAIL_TIMEOUT_MS = 2000
const HEALTHY_TTL_MS = 30_000
const UNHEALTHY_TTL_MS = 2000
type HealthEntry = { healthy: boolean; at: number; ttl: number }
const healthCache = new Map<string, HealthEntry>()
const healthInflight = new Map<string, Promise<boolean>>()

function tcpCheck(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.setTimeout(timeoutMs)
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

export async function isProxyReachable(proxyUrl: string, timeoutMs = FAST_FAIL_TIMEOUT_MS): Promise<boolean> {
  const key = normalizeProxyUrl(proxyUrl)
  const cached = healthCache.get(key)
  if (cached && Date.now() - cached.at < cached.ttl) return cached.healthy
  const existing = healthInflight.get(key)
  if (existing) return existing
  let url: URL
  try {
    const base = key.replace(/\?family=(ipv4|ipv6)$/, '')
    url = new URL(base)
  } catch {
    healthCache.set(key, { healthy: false, at: Date.now(), ttl: UNHEALTHY_TTL_MS })
    return false
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  const port = Number(url.port || defaultPort(url.protocol))
  const probe = tcpCheck(host, port, timeoutMs).then((healthy) => {
    healthCache.set(key, { healthy, at: Date.now(), ttl: healthy ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS })
    return healthy
  })
  healthInflight.set(key, probe)
  try {
    return await probe
  } finally {
    if (healthInflight.get(key) === probe) healthInflight.delete(key)
  }
}

export function _clearProxyHealthCacheForTest(): void {
  healthCache.clear()
  healthInflight.clear()
}

// ── Dispatcher creation (cached) ──
/**
 * Decoded proxy credentials. `URL.username`/`password` are the percent-ENCODED
 * substrings, and undici decodes them only where it parses the URI itself: the
 * HTTP tunnel path builds `proxy-authorization` from decoded values, but the
 * SOCKS5 sub-path forwards `opts.username`/`opts.password` VERBATIM to the auth
 * subnegotiation, so an encoded `p%40ss` would reach the proxy literally and be
 * rejected. Decoding here is what makes both paths see the real credentials.
 */
function decodedProxyAuth(proxyUrl: string): { username?: string; password?: string } {
  try {
    const u = new URL(proxyUrl)
    if (!u.username) return {}
    return {
      username: decodeURIComponent(u.username),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    }
  } catch {
    return {}
  }
}

function createHttpDispatcher(proxyUrl: string, dispatcherOpts: Record<string, unknown>): any {
  const clean = proxyUrl.replace(/\?family=(ipv4|ipv6)$/, '')
  return new ProxyAgent({
    uri: clean,
    // tunnel all (http+https) via CONNECT, same as OmniRoute
    proxyTunnel: true,
    ...decodedProxyAuth(clean),
    ...dispatcherOpts,
  } as any)
}

/**
 * Dispatcher options. `bodyTimeout` is undici's per-gap inactivity timer, not a
 * total transfer budget: it fires when NO bytes arrive for that long. The
 * control-plane calls want the short bound, but a generation stream may
 * legitimately stay silent for minutes mid-turn (reasoning), so streaming runs
 * with the timer disabled — the SSE read loop's own idle watchdog
 * (`resolveStreamIdleTimeoutMs`, default `DEFAULT_STREAM_IDLE_TIMEOUT_MS`,
 * `adapter/parse.ts`) bounds a stalled body instead, which this timer could not
 * tell apart from reasoning anyway.
 *
 * `keepAliveTimeout`/`keepAliveMaxTimeout` deliberately stay at 1ms and are NOT
 * loosened for streaming: undici applies them only when `pipelining` is
 * non-zero, and `pipelining: 0` forces every connection to reset on completion,
 * so they are inert here. They are kept at the conservative value spec #8 asks
 * for rather than being replaced by a setting that would never take effect.
 *
 * SOCKS5 exception (measured against undici 7.29): the socks sub-path drops
 * these options — the per-origin pool behind its Socks5ProxyAgent accepts only
 * pipelining/connections/connect — so on a socks5:// proxy both call classes
 * run at undici's defaults (~300s per-gap) and the streaming `bodyTimeout: 0`
 * guarantee above does NOT hold. There is no option channel to change that.
 */
const DISPATCHER_OPTS = {
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
  connectTimeout: 10_000,
  keepAliveTimeout: 1,
  keepAliveMaxTimeout: 1,
  pipelining: 0,
} as const

/** Streaming dispatcher options: same bounds, minus the body inactivity timer. */
const STREAMING_DISPATCHER_OPTS = { ...DISPATCHER_OPTS, bodyTimeout: 0 } as const

/** Shape shared by both dispatcher option sets. */
export type DispatcherOpts = { -readonly [K in keyof typeof DISPATCHER_OPTS]: number }

/** Resolved dispatcher options for a call class (exported as the source of truth). */
export function dispatcherOptsFor(streaming: boolean): DispatcherOpts {
  return streaming ? STREAMING_DISPATCHER_OPTS : DISPATCHER_OPTS
}

function dispatcherCacheKey(normalized: string, streaming: boolean): string {
  return streaming ? `${normalized}|stream` : normalized
}

export async function dispatcherForAsync(
  proxyUrl?: string,
  options: { streaming?: boolean } = {},
): Promise<any | undefined> {
  const streaming = options.streaming === true
  if (!proxyUrl) return (streaming ? envStreamingAgent : envAgent) as any
  const normalized = normalizeProxyUrl(proxyUrl)
  const key = dispatcherCacheKey(normalized, streaming)
  const cached = dispatcherCache.get(key)
  if (cached) return cached
  const dispatcher = createHttpDispatcher(normalized, dispatcherOptsFor(streaming) as any)
  dispatcherCache.set(key, dispatcher)
  return dispatcher
}

export function _clearDispatcherCacheForTest(): void {
  dispatcherCache.clear()
}

function getTargetUrlString(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  try {
    if (input instanceof URL) return input.toString()
    if (typeof (input as Request).url === 'string') return (input as Request).url
  } catch {
    // ignore
  }
  return ''
}

/** Options accepted by proxiedFetch; `streaming` selects the long-silence dispatcher. */
export interface ProxiedFetchOptions {
  proxyUrl?: string
  /**
   * True for a generation stream (long model silences are normal). Selects a
   * dispatcher without the per-gap body inactivity timer.
   */
  streaming?: boolean
}

/** fetch() that respects per-account proxyUrl (when given) otherwise env. */
export const proxiedFetch = async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1] & { proxyUrl?: string },
  opts?: ProxiedFetchOptions,
): Promise<Response> => {
  const proxyUrl = (opts as any)?.proxyUrl ?? (init as any)?.proxyUrl
  const streaming = opts?.streaming === true
  // Normalize init without proxyUrl leakage
  const cleanInit = { ...init } as any
  if (cleanInit.proxyUrl) delete cleanInit.proxyUrl
  if (!proxyUrl) {
    return fetch(input, { ...cleanInit, dispatcher: (streaming ? envStreamingAgent : envAgent) as any })
  }
  // Loopback bypass: per-account proxy must never intercept OAuth loopback callback (spec 1)
  const targetStr = getTargetUrlString(input)
  if (targetStr && isLoopbackUrl(targetStr)) {
    return fetch(input, cleanInit as RequestInit)
  }
  // Fast-fail pre-check (skip for env path)
  try {
    const reachable = await isProxyReachable(proxyUrl)
    if (!reachable) {
      const err = new Error(`[Proxy Fast-Fail] Proxy unreachable: ${proxyUrlForLogs(proxyUrl)}`) as Error & { code?: string; errorCode?: string; statusCode?: number }
      err.code = 'PROXY_UNREACHABLE'
      err.errorCode = 'proxy_unreachable'
      ;(err as any).statusCode = 503
      throw err
    }
  } catch (e) {
    if ((e as any)?.errorCode === 'proxy_unreachable') throw e
    // normalization failure -> throw
    if (e instanceof Error && e.message.startsWith('[proxy]')) throw e
  }

  let dispatcher: any
  try {
    dispatcher = await dispatcherForAsync(proxyUrl, { streaming })
  } catch (e) {
    throw tagProxyUnreachable(e)
  }
  try {
    return await fetch(input, { ...cleanInit, dispatcher })
  } catch (err) {
    // Tag proxy unreachable so caller can classify
    throw tagProxyUnreachable(err)
  }
}

// Keep named export for tests that assert instanceof
export { envAgent as _envAgentForTest }

/**
 * Bind one account's routing to a fetch implementation.
 *
 * The single entry point every account-scoped call uses (generation, test call,
 * model/quota discovery, project healing, import enrichment). Threading a bare
 * `proxyUrl` at each site is what let six call sites drift and silently route a
 * proxied account over the host's real IP, so the invariant is enforced here
 * instead of by review (AGENTS.md "Proxy Routing").
 */
export function accountFetch(routing: AccountRouting | undefined): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    proxiedFetch(input, init, {
      ...(routing?.proxyUrl ? { proxyUrl: routing.proxyUrl } : {}),
      ...(routing?.streaming ? { streaming: true } : {}),
    })) as typeof fetch
}

/**
 * Fetch for a POOL-LEVEL probe: a request that belongs to no single account
 * (the Antigravity release feeds) but still egresses the host.
 *
 * `undefined` means the env/direct route, which is also where an unproxied
 * account's traffic goes. Given a URL it routes there, so a per-account-proxy
 * user does not leak the real IP on a boot-time or failure-path probe. Both
 * probe sites (plugin boot, the rate-limit fingerprint path) go through here so
 * the routing rule cannot drift between them.
 */
export function probeFetch(proxyUrl: string | undefined): typeof fetch {
  return proxyUrl === undefined || proxyUrl === '' ? proxiedFetch : accountFetch({ proxyUrl })
}

/**
 * Wrap a fetch implementation with a TOTAL wall-clock budget.
 *
 * The dispatcher's `bodyTimeout`/`headersTimeout` are per-GAP timers, not a
 * total budget, and `fetchAvailableModels` tries four endpoints in series — so
 * a slow network can hold a caller for minutes (worst case ~4 x (10s connect +
 * 30s headers)). Anything gating a user-visible RPC needs a real ceiling.
 *
 * Composed with `AbortSignal.any` rather than replacing the caller's signal, so
 * an explicit abort still wins.
 *
 * @param fetchImpl - the routed fetch to wrap.
 * @param ms - total budget in milliseconds.
 * @returns a fetch that fails once the budget expires.
 */
export function withTotalTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const budget = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, budget]) : budget
    return fetchImpl(input, { ...init, signal })
  }) as typeof fetch
}

/** Whether these requests are pinned to an explicit per-account proxy. */
export { isProxyRouted }
