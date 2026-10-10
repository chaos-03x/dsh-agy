import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeState, encodeState, generatePkcePair } from '../src/oauth/pkce.ts'
import {
  accessTokenExpired,
  calculateTokenExpiry,
  formatRefreshParts,
  parseRefreshParts,
} from '../src/oauth/auth.ts'
import {
  AGY_VERSION_FALLBACK,
  antigravityUserAgent,
  currentAgyVersion,
  getAgyBootstrapUserAgent,
  setResolvedAgyVersion,
} from '../src/oauth/constants.ts'
import { resolveAntigravityVersion, resolveAntigravityVersionBounded, resolveObservedAgyVersion, _clearVersionCacheForTest } from '../src/runtime/version.ts'
import { authorizeAntigravity } from '../src/oauth/authorize.ts'
import { bootstrapAccount, exchangeAntigravity, extractOnboardTierId } from '../src/oauth/exchange.ts'
import {
  AgyTokenRefreshError,
  parseOAuthErrorPayload,
  refreshAccessToken,
} from '../src/oauth/refresh.ts'
import {
  CREDENTIAL_BLOB_PREFIX,
  decodeCredentialBlob,
  encodeCredentialBlob,
} from '../src/oauth/blob.ts'
import {
  AGY_ENDPOINT_DAILY,
  AGY_ENDPOINT_PROD,
  AGY_ENDPOINT_SKIP_STATUSES,
  fetchAgyFirstOk,
} from '../src/oauth/constants.ts'

describe('pkce', () => {
  it('generates a verifier and matching S256 challenge', async () => {
    const { verifier, challenge } = generatePkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // challenge = base64url(sha256(verifier))
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(verifier).digest('base64url')
    expect(challenge).toBe(expected)
  })

  it('round-trips state through base64url encode/decode', () => {
    const payload = { verifier: 'abc123', projectId: 'proj-1' }
    const encoded = encodeState(payload)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeState(encoded)).toEqual(payload)
  })
})

describe('auth token parts', () => {
  it('packs and unpacks refresh parts', () => {
    expect(formatRefreshParts({ refreshToken: 'r', projectId: 'p' })).toBe('r|p')
    expect(formatRefreshParts({ refreshToken: 'r', projectId: 'p', managedProjectId: 'm' })).toBe('r|p|m')
    expect(formatRefreshParts({ refreshToken: 'r' })).toBe('r|')
    expect(parseRefreshParts('r|p|m')).toEqual({
      refreshToken: 'r',
      projectId: 'p',
      managedProjectId: 'm',
    })
    expect(parseRefreshParts('r|')).toEqual({ refreshToken: 'r', projectId: undefined, managedProjectId: undefined })
    expect(parseRefreshParts('')).toEqual({ refreshToken: undefined, projectId: undefined, managedProjectId: undefined })
  })

  it('detects expired access tokens with buffer', () => {
    const now = Date.now()
    expect(accessTokenExpired({ access: '', expires: now + 5000, refresh: 'r' })).toBe(true)
    expect(accessTokenExpired({ access: 'a', expires: now + 120_000, refresh: 'r' })).toBe(false)
    expect(accessTokenExpired({ access: 'a', expires: now + 30_000, refresh: 'r' })).toBe(true)
  })

  it('calculates expiry with malformed-input fallbacks', () => {
    const t = 1_000_000
    expect(calculateTokenExpiry(t, 3600)).toBe(t + 3_600_000)
    expect(calculateTokenExpiry(t, undefined)).toBe(t + 3_600_000)
    expect(calculateTokenExpiry(t, 0)).toBe(t)
    expect(calculateTokenExpiry(t, NaN)).toBe(t)
  })
})

describe('authorizeAntigravity', () => {
  it('builds a Google auth URL with required params', async () => {
    const { url, verifier, projectId, state: rawState } = await authorizeAntigravity('http://localhost:51121/oauth-callback', 'proj-x')
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(parsed.searchParams.get('client_id')).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com')
    expect(parsed.searchParams.get('response_type')).toBe('code')
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:51121/oauth-callback')
    expect(parsed.searchParams.get('scope')).toContain('cloud-platform')
    expect(parsed.searchParams.get('scope')).not.toContain('openid')
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
    expect(verifier).toBeTruthy()
    expect(projectId).toBe('proj-x')

    const state = decodeState<{ verifier: string; projectId: string }>(parsed.searchParams.get('state')!)
    expect(state.verifier).toBe(verifier)
    expect(state.projectId).toBe('proj-x')
    expect(parsed.searchParams.get('state')).toBe(rawState)
  })
})

describe('exchangeAntigravity', () => {
  const redirectUri = 'http://localhost:51121/oauth-callback'

  function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      for (const [needle, handler] of Object.entries(routes)) {
        if (url.includes(needle)) return handler(init)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes the whole exchange (token, userinfo, bootstrap) over the account proxy', async () => {
    // Issue #29 class: `login --proxy` stored a proxy while the exchange itself
    // still went direct, leaking the host's real IP during login.
    const { dispatcherForAsync } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')
    const seen: Array<{ url: string; dispatcher: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      seen.push({ url, dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher })
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      return new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-1' } }), { status: 200 })
    }))

    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })

    await withProxyFixture(async (proxyUrl) => {
      const result = await exchangeAntigravity('code123', state, redirectUri, verifier, { proxyUrl })
      expect(result.type).toBe('success')

      // Every request the exchange issued must carry the account dispatcher.
      expect(seen.length).toBeGreaterThanOrEqual(3)
      const expected = await dispatcherForAsync(proxyUrl)
      for (const call of seen) {
        expect(call.dispatcher, `not proxied: ${call.url}`).toBe(expected)
      }
    })
  })

  it('exchanges code, resolves email and project id', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
      'googleapis.com/oauth2/v1/userinfo': () =>
        new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 }),
      'cloudcode-pa.googleapis.com/v1internal:loadCodeAssist': () =>
        new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-1' } }), { status: 200 }),
    })

    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('success')
    if (result.type !== 'success') return
    expect(result.access).toBe('at')
    expect(result.refresh).toBe('rt|proj-1')
    expect(result.email).toBe('user@example.com')
    expect(result.projectId).toBe('proj-1')
    expect(result.expires).toBeGreaterThan(Date.now())
  })

  it('falls back to a string project id from loadCodeAssist', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
      'googleapis.com/oauth2/v1/userinfo': () => new Response('{}', { status: 200 }),
      'loadCodeAssist': () => new Response(JSON.stringify({ cloudaicompanionProject: 'proj-str' }), { status: 200 }),
    })
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('success')
    if (result.type !== 'success') return
    expect(result.projectId).toBe('proj-str')
  })

  it('rejects a state whose verifier does not match the issued one', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    const result = await exchangeAntigravity('code123', state, redirectUri, 'a-different-verifier')
    expect(result.type).toBe('failed')
    if (result.type === 'failed') expect(result.error).toMatch(/State does not match/)
  })

  it('fails when the token endpoint rejects', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () =>
        new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }),
    })
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('failed')
  })

  it('fails when the token response lacks a refresh token', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () =>
        new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }),
      'googleapis.com/oauth2/v1/userinfo': () => new Response('{}', { status: 200 }),
    })
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('failed')
    if (result.type === 'failed') expect(result.error).toContain('Missing refresh token')
  })

  it('surfaces the transport cause instead of a bare "fetch failed" (issue #108)', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    // undici rejects every transport failure as `TypeError: fetch failed` with
    // the actionable code on `cause`; printing only `error.message` is what
    // made issue #108's screenshot information-free.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
      })
    }))
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('failed')
    if (result.type !== 'failed') return
    expect(result.error).toContain('fetch failed')
    expect(result.error).toContain('UND_ERR_SOCKET')
    expect(result.transport).toBe(true)
  })

  it('flags a proxy fast-fail as transport so the CLI can hint at the remedy', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    vi.stubGlobal('fetch', vi.fn(async () => {
      const err = new Error('[Proxy Fast-Fail] Proxy unreachable: http://127.0.0.1:7890') as Error & { code?: string; errorCode?: string }
      err.code = 'PROXY_UNREACHABLE'
      err.errorCode = 'proxy_unreachable'
      throw err
    }))
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('failed')
    if (result.type !== 'failed') return
    expect(result.transport).toBe(true)
  })

  it('does not flag a malformed token response as transport — no proxy fixes it', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () => new Response('not json', { status: 200 }),
    })
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('failed')
    if (result.type !== 'failed') return
    expect(result.transport).toBeFalsy()
  })

  it('keeps the login when userinfo fails — the refresh token is already minted (issue #108)', async () => {
    const { verifier } = generatePkcePair()
    const state = encodeState({ verifier, projectId: '' })
    mockFetch({
      'oauth2.googleapis.com/token': () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
      'googleapis.com/oauth2/v1/userinfo': () => {
        throw new TypeError('fetch failed')
      },
      'loadCodeAssist': () =>
        new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-1' } }), { status: 200 }),
    })
    const result = await exchangeAntigravity('code123', state, redirectUri)
    expect(result.type).toBe('success')
    if (result.type !== 'success') return
    // The credential survives; only the email is unknown.
    expect(result.refresh).toBe('rt|proj-1')
    expect(result.email).toBeUndefined()
  })
})

describe('parseOAuthErrorPayload', () => {
  it('handles string errors, object errors, and descriptions', () => {
    expect(parseOAuthErrorPayload(JSON.stringify({ error: 'invalid_grant' }))).toEqual({
      code: 'invalid_grant',
    })
    expect(parseOAuthErrorPayload(JSON.stringify({ error: 'invalid_grant', error_description: 'bad' }))).toEqual({
      code: 'invalid_grant',
      description: 'bad',
    })
    expect(parseOAuthErrorPayload(JSON.stringify({ error: { status: 'UNAUTHENTICATED', message: 'nope' } }))).toEqual({
      code: 'UNAUTHENTICATED',
      description: 'nope',
    })
    expect(parseOAuthErrorPayload('not json')).toEqual({ description: 'not json' })
    expect(parseOAuthErrorPayload(undefined)).toEqual({})
  })
})

describe('refreshAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockTokenFetch(response: Response) {
    vi.stubGlobal('fetch', vi.fn(async () => response))
  }

  it('refreshes and preserves project parts', async () => {
    mockTokenFetch(
      new Response(JSON.stringify({ access_token: 'at2', expires_in: 3600 }), { status: 200 }),
    )
    const result = await refreshAccessToken({ access: 'old', expires: 1, refresh: 'rt|proj-1' })
    expect(result.type).toBe('success')
    if (result.type !== 'success') return
    expect(result.auth.access).toBe('at2')
    expect(result.auth.refresh).toBe('rt|proj-1')
    expect(result.auth.expires).toBeGreaterThan(Date.now())
  })

  it('reports revocation on invalid_grant', async () => {
    mockTokenFetch(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
    const result = await refreshAccessToken({ access: 'old', expires: 1, refresh: 'rt' })
    expect(result.type).toBe('revoked')
  })

  it('reports failed with a typed error for other failures', async () => {
    mockTokenFetch(new Response(JSON.stringify({ error: 'rate_limit_exceeded' }), { status: 429 }))
    const result = await refreshAccessToken({ access: 'old', expires: 1, refresh: 'rt' })
    expect(result.type).toBe('failed')
    if (result.type !== 'failed') return
    expect(result.error).toBeInstanceOf(AgyTokenRefreshError)
    expect(result.error.status).toBe(429)
    expect(result.error.code).toBe('rate_limit_exceeded')
  })
})

describe('credential blob', () => {
  it('round-trips a blob with provider binding', () => {
    const blob = encodeCredentialBlob('agy', { access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
    expect(blob.startsWith(CREDENTIAL_BLOB_PREFIX)).toBe(true)
    expect(blob).toMatch(/^[A-Za-z0-9._-]+$/)
    const decoded = decodeCredentialBlob(blob)
    expect(decoded.provider).toBe('agy')
    expect(decoded.tokens.access_token).toBe('at')
    expect(decoded.tokens.refresh_token).toBe('rt')
  })

  it('rejects wrong prefix, tampered payload, and provider mismatch', () => {
    expect(() => decodeCredentialBlob('garbage')).toThrow(/invalid format/)
    expect(() => decodeCredentialBlob(CREDENTIAL_BLOB_PREFIX + '!!!')).toThrow(/not base64url/)
    const other = encodeCredentialBlob('codex', { access_token: 'at' })
    expect(() => decodeCredentialBlob(other)).toThrow(/provider mismatch/)
    expect(() => encodeCredentialBlob('agy', {})).toThrow(/access_token/)
  })
})

describe('bootstrap UA version freshness', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setResolvedAgyVersion(undefined)
  })

  /**
   * Regression test for pinned control-plane versions.
   *
   * The resolved version used to be a function PARAMETER, and all six bootstrap
   * call sites omitted it, so every control-plane request advertised the stale
   * fallback while the generation path advertised the resolved version — one
   * process presenting two different clients. The default now reads a published
   * shared value, which makes that drift unrepresentable.
   */
  it('advertises the published version, not a per-call default', () => {
    setResolvedAgyVersion('9.9.9')
    expect(getAgyBootstrapUserAgent()).toContain('Antigravity/9.9.9')
    // The short form used by the version feeds agrees with the bootstrap form.
    expect(antigravityUserAgent()).toBe('antigravity/9.9.9 darwin/arm64')
  })

  it('falls back to the pinned floor before any version is resolved', () => {
    setResolvedAgyVersion(undefined)
    expect(getAgyBootstrapUserAgent()).toContain(`Antigravity/${AGY_VERSION_FALLBACK}`)
    expect(currentAgyVersion()).toBe(AGY_VERSION_FALLBACK)
  })

  it('publishes the resolved version for every User-Agent builder', async () => {
    setResolvedAgyVersion(undefined)
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('antigravity-auto-updater')) {
        return new Response(JSON.stringify([{ version: '1.2.3' }, { version: '1.20.1' }]), { status: 200 })
      }
      return new Response(JSON.stringify({ tag_name: '1.19.0' }), { status: 200 })
    }) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

    expect(await resolveAntigravityVersion(fetchImpl)).toBe('1.19.0')
    // Resolution must reach the bootstrap UA without any call site passing it.
    expect(getAgyBootstrapUserAgent()).toContain('Antigravity/1.19.0')
    expect(antigravityUserAgent()).toBe('antigravity/1.19.0 darwin/arm64')
  })

  it('reports nothing observed when the feeds yield nothing', async () => {
    // The freshness gate compares the compiled fallback against what the feeds
    // actually said, so "unobserved" must be distinguishable from "the live
    // version equals the fallback" — the latter is the healthy case.
    _clearVersionCacheForTest()
    const dead = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    expect(await resolveObservedAgyVersion(dead)).toBeUndefined()

    // An observation whose value equals the fallback is still an observation,
    // not a fallback substitution.
    _clearVersionCacheForTest()
    const same = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.includes('antigravity-auto-updater')
        ? new Response(JSON.stringify([{ version: AGY_VERSION_FALLBACK }]), { status: 200 })
        : new Response(JSON.stringify({ tag_name: AGY_VERSION_FALLBACK }), { status: 200 })
    }) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    expect(await resolveObservedAgyVersion(same)).toBe(AGY_VERSION_FALLBACK)
  })

  it('probes through the fetch it is given, and gives up instead of hanging', async () => {
    // The CLI login and the plugin boot both warm the version through a BOUNDED
    // resolve, and both pass their own egress (the login proxy / the pool's
    // representative account) — the feeds belong to no account, so the caller has
    // to decide the route. The timeout matters as much as the value: a login that
    // blocked on an unreachable feed would be worse than a stale version.
    //
    // The value reaching a User-Agent is the neighbouring test's subject; this one
    // is about the ROUTE, which is why it asserts the resolve rather than the
    // published slot (that slot is monotonic per process, so a lower test value
    // would be refused by design and prove nothing).
    _clearVersionCacheForTest()
    const routed = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('antigravity-auto-updater')) {
        return new Response(JSON.stringify([{ version: '1.21.0' }]), { status: 200 })
      }
      return new Response(JSON.stringify({ tag_name: '1.21.0' }), { status: 200 })
    }) as unknown as (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

    expect(await resolveAntigravityVersionBounded(1_000, routed)).toBe('1.21.0')
    // Every request went through the injected fetch, never the global one.
    expect(routed).toHaveBeenCalled()

    // A feed that accepts and never answers must still return control.
    _clearVersionCacheForTest()
    const silent = vi.fn(async () => await new Promise<Response>(() => {})) as unknown as
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    const startedAt = Date.now()
    expect(await resolveAntigravityVersionBounded(50, silent)).toBeUndefined()
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('bootstrapAccount', () => {
  afterEach(() => vi.unstubAllGlobals())

  function mockFetch(routes: Record<string, (init?: RequestInit) => Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      for (const [needle, handler] of Object.entries(routes)) {
        if (url.includes(needle)) return handler(init)
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
  }

  it('extracts tier ids paid → current → default → legacy', () => {
    expect(extractOnboardTierId({ paidTier: { id: 'paid-tier' } })).toBe('paid-tier')
    expect(extractOnboardTierId({ currentTier: { id: 'current-tier' } })).toBe('current-tier')
    expect(extractOnboardTierId({
      ineligibleTiers: ['x'],
      allowedTiers: [{ id: 'default-tier', isDefault: true }],
    })).toBe('default-tier')
    expect(extractOnboardTierId({})).toBe('legacy-tier')
  })

  it('onboards a fresh account and discovers the project', async () => {
    let onboardCalls = 0
    mockFetch({
      'loadCodeAssist': () => {
        // First call (pre-onboard): no project. Later calls: project exists.
        return onboardCalls > 0
          ? new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-onboarded' }, subscriptionInfo: { currentTier: { id: 'free-tier' } } }), { status: 200 })
          : new Response(JSON.stringify({ subscriptionInfo: { currentTier: { id: 'free-tier' } } }), { status: 200 })
      },
      'onboardUser': () => {
        onboardCalls += 1
        return new Response(JSON.stringify({ done: true }), { status: 200 })
      },
    })

    const result = await bootstrapAccount('at')
    expect(result.projectId).toBe('proj-onboarded')
    expect(result.tierId).toBe('free-tier')
    expect(onboardCalls).toBe(1)
  })

  it('returns empty project when onboarding never succeeds', async () => {
    mockFetch({
      'loadCodeAssist': () => new Response(JSON.stringify({}), { status: 200 }),
      'onboardUser': () => new Response(JSON.stringify({ done: false }), { status: 200 }),
    })
    const result = await bootstrapAccount('at', { maxAttempts: 1, retryDelayMs: 10 })
    expect(result.projectId).toBe('')
  })
})

describe('endpoint fallback (fetchAgyFirstOk)', () => {
  it('treats 503 as a skip status so a capacity-rejected endpoint falls through', async () => {
    expect(AGY_ENDPOINT_SKIP_STATUSES.has(503)).toBe(true)
    expect(AGY_ENDPOINT_SKIP_STATUSES.has(429)).toBe(true)
    expect(AGY_ENDPOINT_SKIP_STATUSES.has(403)).toBe(true)
    expect(AGY_ENDPOINT_SKIP_STATUSES.has(500)).toBe(false)

    const calls: string[] = []
    // fetchImpl is injected: no global stub, no real network.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith(AGY_ENDPOINT_DAILY)) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'No capacity available', status: 'UNAVAILABLE' } }),
          { status: 503 },
        )
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {}, fetchImpl)
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[0]!.startsWith(AGY_ENDPOINT_DAILY)).toBe(true)
    expect(calls[1]!.startsWith(AGY_ENDPOINT_PROD)).toBe(true)
  })

  it('returns the last skipped 503 when every endpoint rejects on capacity', async () => {
    const fetchImpl = (async () => new Response('no capacity', { status: 503 })) as unknown as typeof fetch
    const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {}, fetchImpl)
    // Intended: the caller's classifier sees the 503 and Fix A surfaces SERVER.
    expect(response.status).toBe(503)
  })

  // Issue #29 (2): with no explicit proxy, a transient socket failure on one
  // endpoint must fall through to the next instead of aborting the whole chain.
  it('falls through to the next endpoint on a direct transient socket failure', async () => {
    const calls: string[] = []
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith(AGY_ENDPOINT_DAILY)) {
        const error = new TypeError('fetch failed')
        ;(error as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
        throw error
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {}, fetchImpl)
    expect(response.status).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.startsWith(AGY_ENDPOINT_PROD)).toBe(true)
  })

  it('surfaces the last endpoint failure instead of a generic message', async () => {
    const fetchImpl = (async () => {
      const error = new TypeError('fetch failed')
      ;(error as { cause?: unknown }).cause = Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })
      throw error
    }) as unknown as typeof fetch

    await expect(
      fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {}, fetchImpl),
    ).rejects.toThrow(/ENOTFOUND|fetch failed/)
  })

  it('still fails closed when an explicit account proxy is active', async () => {
    const calls: string[] = []
    const unreachable = Object.assign(new Error('[Proxy Fast-Fail] Proxy unreachable: http://127.0.0.1:1'), {
      code: 'PROXY_UNREACHABLE',
      errorCode: 'proxy_unreachable',
      statusCode: 503,
    })
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      throw unreachable
    }) as unknown as typeof fetch

    await expect(
      fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {}, fetchImpl, { proxyUrl: 'http://127.0.0.1:9' }),
    ).rejects.toThrow(/unreachable/i)
    // Fail-closed: never fall back to another endpoint (that would risk a
    // direct connection leaking the account's real IP).
    expect(calls).toHaveLength(1)
  })
})
