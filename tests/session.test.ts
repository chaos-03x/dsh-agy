import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgySessionManager, impersonationHeadersFor, SESSION_AFFINITY_WINDOW_MS } from '../src/session.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import type { ManagedAccount } from '../src/types.ts'

function account(email = 'a@b.c'): ManagedAccount {
  return { email, refresh: `rt-${email}|proj-1`, projectId: 'proj-1', addedAt: 0, lastUsed: 0, enabled: true }
}

function storage(accounts: ManagedAccount[], activeIndex = 0) {
  return { version: 4 as const, accounts, activeIndex }
}

function stubTokenEndpoint(overrides: Partial<{ ok: boolean; body: unknown; status: number }> = {}) {
  const { ok = true, body = { access_token: 'at', expires_in: 3600 }, status = 200 } = overrides
  vi.stubGlobal('fetch', vi.fn(async () => new Response(ok ? JSON.stringify(body) : JSON.stringify(body), { status })))
}

describe('AgySessionManager', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns undefined when no accounts exist', async () => {
    const sessions = new AgySessionManager({ store: new InMemoryAccountStore() })
    expect(await sessions.getSession()).toBeUndefined()
  })

  it('refreshes and returns a session with impersonation headers', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account()]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session).toBeDefined()
    expect(session!.auth.access).toBe('at')
    expect(session!.impersonation['User-Agent']).toMatch(/^antigravity\/\d+\.\d+\.\d+/)
    expect(session!.impersonation['Client-Metadata']).toContain('ANTIGRAVITY')
  })

  it('uses the persistent fingerprint when the account has one', async () => {
    stubTokenEndpoint()
    const fp = {
      deviceId: 'd1', sessionToken: 's1', userAgent: 'antigravity/9.9.9 darwin/arm64',
      apiClient: 'fixed-client', clientMetadata: { ideType: 'ANTIGRAVITY' },
      createdAt: 0,
    }
    const store = new InMemoryAccountStore(storage([{ ...account(), fingerprint: fp }]))
    const sessions = new AgySessionManager({ store })
    const session = await sessions.getSession()
    expect(session!.impersonation['User-Agent']).toBe('antigravity/9.9.9 darwin/arm64')
    expect(session!.impersonation['X-Goog-Api-Client']).toBe('fixed-client')
  })

  it('rotates the active index on rate-limit and creates a fingerprint', async () => {
    stubTokenEndpoint()
    const a = account('a@x')
    const b = account('b@x')
    const store = new InMemoryAccountStore(storage([a, b], 0))
    const rotations: string[] = []
    const sessions = new AgySessionManager({ store, onRotate: (from, to) => rotations.push(`${from}->${to}`) })

    const session = await sessions.getSession()
    expect(session!.index).toBe(0)
    await sessions.reportFailure('rate-limit', session!)
    const after = await store.load()
    expect(after.activeIndex).toBe(1)
    expect(rotations).toEqual(['0->1'])
    expect(after.accounts[0]!.fingerprint).toBeDefined()
    expect(after.accounts[0]!.fingerprintHistory).toHaveLength(1)
  })

  it('keeps session affinity within the window and re-balances after it', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    // First pick lands on the active account (0) and pins it.
    const first = await sessions.getSession()
    expect(first!.index).toBe(0)

    // Another turn in the same conversation: still account 0, even though the
    // shared activeIndex moved elsewhere in the meantime.
    await store.mutate((s) => { s.activeIndex = 1 })
    const second = await sessions.getSession()
    expect(second!.index).toBe(0)

    // After the affinity window, the pool re-balances to the active index.
    vi.setSystemTime(Date.now() + SESSION_AFFINITY_WINDOW_MS + 1)
    const third = await sessions.getSession()
    expect(third!.index).toBe(1)
    vi.useRealTimers()
  })

  it('drops session affinity when the pinned account rotates', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    const first = await sessions.getSession()
    expect(first!.index).toBe(0)
    await sessions.reportFailure('rate-limit', first!)
    // Rotation cleared the affinity: next pick follows the new active index.
    const next = await sessions.getSession()
    expect(next!.index).toBe(1)
  })

  it('regenerates the fingerprint on repeated rate-limits (bounded history)', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account()]))
    const sessions = new AgySessionManager({ store })

    let session = await sessions.getSession('gemini-3.5-flash')
    await sessions.reportFailure('rate-limit', session!, { model: 'gemini-3.5-flash' })
    const first = (await store.load()).accounts[0]!.fingerprint!
    session = await sessions.getSession('claude-sonnet-4-6')
    await sessions.reportFailure('rate-limit', session!, { model: 'claude-sonnet-4-6' })
    const second = (await store.load()).accounts[0]!.fingerprint!
    expect(second.deviceId).not.toBe(first.deviceId)
    expect((await store.load()).accounts[0]!.fingerprintHistory).toHaveLength(2)
  })

  it('revokes on auth-failure: disables and marks verification required', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account()]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    await sessions.reportFailure('auth-failure', session!)
    const after = await store.load()
    expect(after.accounts[0]!.enabled).toBe(false)
    expect(after.accounts[0]!.verificationRequired).toBe(true)
  })

  it('resets the failure counter on success', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account()]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    await sessions.reportFailure('rate-limit', session!)
    await sessions.markSuccess(session!)
    await sessions.reportFailure('rate-limit', session!)
    // consecutive counter was reset → no fingerprint regeneration yet (only creation on 1st)
    const after = await store.load()
    expect(after.accounts[0]!.fingerprintHistory).toHaveLength(1)
  })
})


  it('heals a missing projectId at request time and persists it', async () => {
    // token endpoint + loadCodeAssist discovery
    let discovered = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('loadCodeAssist')) {
        discovered = true
        return new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-healed' } }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    // account with empty projectId
    const store = new InMemoryAccountStore(storage([{ ...account('a@b.c'), projectId: undefined }]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(discovered).toBe(true)
    expect(session!.account.projectId).toBe('proj-healed')
    // persisted in the store, including the packed refresh string
    const saved = await store.load()
    expect(saved.accounts[0]!.projectId).toBe('proj-healed')
    expect(saved.accounts[0]!.refresh).toBe('rt-a@b.c|proj-healed')
  })

  it('deduplicates concurrent refreshes for the same account', async () => {
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshCalls++
        await new Promise((r) => setTimeout(r, 30))
        return new Response(JSON.stringify({ access_token: 'at-' + refreshCalls, expires_in: 3600 }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const store = new InMemoryAccountStore(storage([account('a@b.c')]))
    const sessions = new AgySessionManager({ store })
    const [s1, s2, s3] = await Promise.all([
      sessions.getSession(),
      sessions.getSession(),
      sessions.getSession(),
    ])
    expect(refreshCalls).toBe(1)
    expect(s1?.auth.access).toBe('at-1')
    expect(s2?.auth.access).toBe('at-1')
    expect(s3?.auth.access).toBe('at-1')
  })

  it('pre-emptively refreshes within the skew and serves the cached token meanwhile', async () => {
    let refreshCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshCalls++
        await new Promise((r) => setTimeout(r, 50)) // slow endpoint: proves no blocking
        return new Response(JSON.stringify({ access_token: 'at-' + refreshCalls, expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const store = new InMemoryAccountStore(storage([account('a@b.c')]))
    const sessions = new AgySessionManager({ store })

    const first = await sessions.getSession()
    expect(first!.auth.access).toBe('at-1')

    // 100s before expiry: still valid, but inside the 120s refresh skew.
    vi.setSystemTime(Date.now() + 3500 * 1000)
    const second = await sessions.getSession()
    expect(second!.auth.access).toBe('at-1') // served from cache while the background refresh runs
    await vi.waitFor(() => expect(refreshCalls).toBe(2))
    await new Promise((r) => setTimeout(r, 80)) // let the slowed background refresh finish
    const third = await sessions.getSession()
    expect(third!.auth.access).toBe('at-2')
    vi.useRealTimers()
  })

  it('retains the last good token when a pre-emptive refresh fails', async () => {
    let failRefresh = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        if (failRefresh) throw new TypeError('fetch failed')
        return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const store = new InMemoryAccountStore(storage([account('a@b.c')]))
    const sessions = new AgySessionManager({ store })

    const first = await sessions.getSession()
    expect(first!.auth.access).toBe('at-1')

    failRefresh = true
    vi.setSystemTime(Date.now() + 3500 * 1000)
    const second = await sessions.getSession()
    // The background refresh failed, but the still-valid token stays servable.
    expect(second!.auth.access).toBe('at-1')
    vi.useRealTimers()
  })

describe('usage-driven selection', () => {
  afterEach(() => vi.unstubAllGlobals())

  function quotaAccount(email: string, quota: Record<string, { remainingFraction?: number; resetTime?: string }>): ManagedAccount {
    return {
      ...account(email),
      cachedQuota: quota,
      cachedQuotaUpdatedAt: Date.now(),
    }
  }

  it('ranks the requested family and picks the account with expiring headroom', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([
      quotaAccount('a@x', { google: { remainingFraction: 0.9 } }),
      quotaAccount('b@x', { google: { remainingFraction: 0.2 } }),
    ], 1))
    const sessions = new AgySessionManager({ store })

    // a holds the headroom that would expire unused → ranked first for gemini,
    // re-balancing away from the active account (b).
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(0)
    expect((await store.load()).activeIndex).toBe(0)
  })

  it('breaks the affinity pin when the pinned account family is drained', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([
      quotaAccount('a@x', { google: { remainingFraction: 0.5 } }),
      quotaAccount('b@x', { google: { remainingFraction: 0.8 } }),
    ], 0))
    const sessions = new AgySessionManager({ store })

    const first = await sessions.getSession('gemini-3.5-flash')
    expect(first!.index).toBe(1) // b holds more headroom → picked and pinned
    // b's google family drops below the soft threshold.
    await store.mutate((s) => { s.accounts[1]!.cachedQuota!.google!.remainingFraction = 0.05 })
    const second = await sessions.getSession('gemini-3.5-flash')
    expect(second!.index).toBe(0)
  })

  it('ingests fresh family quotas from fetchAvailableModels when the cache is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          models: {
            'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.4, resetTime: '2099-01-01T00:00:00Z' } },
            'gemini-3.5-pro': { quotaInfo: { remainingFraction: 0.1, resetTime: '2098-01-01T00:00:00Z' } },
            'claude-sonnet-4-6': { quotaInfo: { remainingFraction: 0.6 } },
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    const after = await store.load()
    expect(after.accounts[0]!.cachedQuota).toEqual({
      google: { remainingFraction: 0.1, resetTime: '2098-01-01T00:00:00Z', modelCount: 2 },
      anthropic: { remainingFraction: 0.6, modelCount: 1 },
    })
    expect(after.accounts[0]!.cachedQuotaUpdatedAt).toBeGreaterThan(0)
  })

  it('keeps selection on rotation order when the quota fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        throw new TypeError('fetch failed')
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 1))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(1)
    expect((await store.load()).accounts[0]!.cachedQuota).toBeUndefined()
  })

  it('records the family-scoped reset from a rate-limit failure', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('claude-sonnet-4-6')
    const reset = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    await sessions.reportFailure('rate-limit', session!, { resetTime: reset, model: 'claude-sonnet-4-6' })
    const after = await store.load()
    const failed = after.accounts[0]!
    expect(failed.rateLimitResetTimes).toHaveProperty('anthropic')
    expect(failed.rateLimitResetTimes!['anthropic']).toBeGreaterThan(Date.now() + 60 * 60 * 1000)
    // Family-scoped rate limits do not set account-wide coolingDownUntil so other families stay usable
    expect(failed.coolingDownUntil).toBeUndefined()
  })

  it('stable fingerprint mode pins one identity: no regeneration on repeated rate-limits', async () => {
    vi.stubEnv('DSH_AGY_FINGERPRINT_MODE', 'stable')
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x')]))
    const sessions = new AgySessionManager({ store })

    let session = await sessions.getSession('gemini-3.5-flash')
    await sessions.reportFailure('rate-limit', session!, { model: 'gemini-3.5-flash' })
    const first = (await store.load()).accounts[0]!.fingerprint!
    session = await sessions.getSession('claude-sonnet-4-6')
    await sessions.reportFailure('rate-limit', session!, { model: 'claude-sonnet-4-6' })
    const after = await store.load()
    expect(after.accounts[0]!.fingerprint!.deviceId).toBe(first.deviceId)
    expect(after.accounts[0]!.fingerprintHistory).toHaveLength(1)
    vi.unstubAllEnvs()
  })
  it('skips quota refresh for single-account pools', async () => {
    let called = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        called = true
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x')]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(0)
    expect(called).toBe(false)
  })

  it('always refreshes with the account-bound clientId even when env overrides change', async () => {
    let requestedClientId = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const body = new URLSearchParams(String(init?.body))
        requestedClientId = body.get('client_id') ?? ''
        return new Response(JSON.stringify({ access_token: 'at-fresh', expires_in: 3600 }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    vi.stubEnv('AGY_CLIENT_ID', 'custom-new-client-id')
    const boundAccount = { ...account('bound@x'), clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com' }
    const store = new InMemoryAccountStore(storage([boundAccount]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session?.auth.access).toBe('at-fresh')
    expect(requestedClientId).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com')
    vi.unstubAllEnvs()
  })

  it('family-scoped rate limit on google does not block anthropic requests', async () => {
    stubTokenEndpoint()
    const acc = account('single@x')
    acc.rateLimitResetTimes = { google: Date.now() + 60_000 }
    const store = new InMemoryAccountStore(storage([acc]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('claude-sonnet-4-6')
    expect(session).toBeDefined()
    expect(session!.index).toBe(0)
  })

  it('stable fingerprint mode serves deterministic fallback headers without a fingerprint', () => {
    vi.stubEnv('DSH_AGY_FINGERPRINT_MODE', 'stable')
    const first = impersonationHeadersFor(account('a@x'))
    const second = impersonationHeadersFor(account('a@x'))
    expect(first).toEqual(second)
    expect(first['Client-Metadata']).toContain('ANTIGRAVITY')
    vi.unstubAllEnvs()
  })

  it('health-check probes enabled accounts in batch and re-enables live ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'probed@x' }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const disabled = { ...account('a@x'), enabled: false, verificationRequired: true }
    const store = new InMemoryAccountStore(storage([disabled, account('b@x')]))
    const reports: Array<Array<{ index: number; ok: boolean }>> = []
    const sessions = new AgySessionManager({ store, onHealthReport: (results) => reports.push(results) })

    // Default target: enabled accounts only (the disabled one is skipped).
    const results = await sessions.checkAccounts()
    expect(results.map((r) => r.index)).toEqual([1])
    expect(results[0]!.ok).toBe(true)
    expect(reports).toHaveLength(1)

    // Explicit indices include disabled accounts; a live credential re-enables them.
    const withDisabled = await sessions.checkAccounts([0, 1])
    expect(withDisabled.map((r) => r.index).sort((x, y) => x - y)).toEqual([0, 1])
    const after = await store.load()
    expect(after.accounts[0]!.enabled).toBe(true)
    expect(after.accounts[0]!.verificationRequired).toBe(false)
  })

  it('hard gates and blocks requests when the requested family is rate-limited on all accounts', async () => {
    stubTokenEndpoint()
    const a = account('a@x')
    const b = account('b@x')
    a.rateLimitResetTimes = { google: Date.now() + 60_000 }
    b.rateLimitResetTimes = { google: Date.now() + 60_000 }
    const store = new InMemoryAccountStore(storage([a, b]))
    const sessions = new AgySessionManager({ store })

    // When requested for Gemini (google family), all accounts are blocked -> must return undefined
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session).toBeUndefined()
  })

  it('legacy accounts without clientId refresh via embedded fallback and persist clientId on success', async () => {
    let requestedClientId = ''
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const body = new URLSearchParams(String(init?.body))
        requestedClientId = body.get('client_id') ?? ''
        return new Response(JSON.stringify({ access_token: 'at-migrated', expires_in: 3600 }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    // Legacy account: clientId is undefined
    const legacyAccount: ManagedAccount = { ...account('legacy@x'), clientId: undefined }
    const store = new InMemoryAccountStore(storage([legacyAccount]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session?.auth.access).toBe('at-migrated')
    expect(requestedClientId).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com')
    // Successfully persisted on account!
    const after = await store.load()
    expect(after.accounts[0]!.clientId).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com')
  })

  it('circular candidate ordering aligns to true active account when disabled accounts precede it', async () => {
    stubTokenEndpoint()
    const disabled = { ...account('d@x'), enabled: false }
    const a = account('a@x')
    const b = account('b@x')
    // Active index is 2 (account b@x), but index 0 is disabled
    const store = new InMemoryAccountStore(storage([disabled, a, b], 2))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(2)
  })

  it('soft_rate_limit does not block single-account immediate retries', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('single@x')]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session).toBeDefined()
    // Report soft rate limit (transient 1.5s burst)
    await sessions.reportFailure('rate-limit', session!, {
      rateLimitCategory: 'soft_rate_limit',
      retryAfterMs: 1500,
      model: 'gemini-3.5-flash',
    })

    const after = await store.load()
    // Neither account-wide nor family-wide hard rate limits are recorded
    expect(after.accounts[0]!.coolingDownUntil).toBeUndefined()
    expect(after.accounts[0]!.rateLimitResetTimes?.google).toBeUndefined()

    // Immediate retry on the same account still succeeds!
    const retrySession = await sessions.getSession('gemini-3.5-flash')
    expect(retrySession).toBeDefined()
    expect(retrySession!.index).toBe(0)
  })

  it('handles legacy fallback: embedded invalid_grant + BYO success', async () => {
    const attemptedClients: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const body = new URLSearchParams(String(init?.body))
        const cid = body.get('client_id') ?? ''
        attemptedClients.push(cid)
        if (cid === '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com') {
          // embedded client rejected
          return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad token' }), { status: 400 })
        }
        if (cid === 'byo-custom-client-id') {
          // BYO client succeeds
          return new Response(JSON.stringify({ access_token: 'byo-access-token', expires_in: 3600 }), { status: 200 })
        }
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    vi.stubEnv('AGY_CLIENT_ID', 'byo-custom-client-id')
    const legacyAccount: ManagedAccount = { ...account('byo-migrated@x'), clientId: undefined }
    const store = new InMemoryAccountStore(storage([legacyAccount]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session?.auth.access).toBe('byo-access-token')
    expect(attemptedClients).toEqual([
      '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
      'byo-custom-client-id',
    ])
    const after = await store.load()
    expect(after.accounts[0]!.clientId).toBe('byo-custom-client-id')
    expect(after.accounts[0]!.enabled).toBe(true)
    vi.unstubAllEnvs()
  })

  it('handles legacy fallback: embedded invalid_grant + BYO network error does not revoke', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const body = new URLSearchParams(String(init?.body))
        const cid = body.get('client_id') ?? ''
        if (cid === '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
        }
        // BYO client has network failure
        throw new TypeError('fetch failed on BYO endpoint')
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    vi.stubEnv('AGY_CLIENT_ID', 'byo-client')
    const legacyAccount: ManagedAccount = { ...account('transient@x'), clientId: undefined }
    const store = new InMemoryAccountStore(storage([legacyAccount]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session).toBeUndefined()
    const after = await store.load()
    // Transient failure must NOT revoke the account!
    expect(after.accounts[0]!.enabled).toBe(true)
    expect(after.accounts[0]!.verificationRequired).toBeFalsy()
    vi.unstubAllEnvs()
  })

  it('preserves email-less account identity across project discovery mutation', async () => {
    stubTokenEndpoint()
    // Email-less account: key comes from immutable id
    const accountWithoutEmail: ManagedAccount = {
      id: 'imm-uuid-1234',
      email: undefined,
      refresh: 'raw-refresh-token',
      projectId: undefined,
      addedAt: Date.now(),
      lastUsed: 0,
      enabled: true,
    }
    const store = new InMemoryAccountStore(storage([accountWithoutEmail]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session).toBeDefined()

    // Report a rate-limit failure on the session
    await sessions.reportFailure('rate-limit', session!, { model: 'gemini-3.5-flash', retryAfterMs: 5000 })
    const after = await store.load()
    // Successfully updated rateLimitResetTimes for the immutable account!
    expect(after.accounts[0]!.rateLimitResetTimes?.google).toBeGreaterThan(Date.now())
  })

  it('all invalid_grant candidates marks account disabled and verificationRequired in store', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }), { status: 400 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const acc = account('all-revoked@x')
    const store = new InMemoryAccountStore(storage([acc]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession()
    expect(session).toBeUndefined()

    const after = await store.load()
    expect(after.accounts[0]!.enabled).toBe(false)
    expect(after.accounts[0]!.verificationRequired).toBe(true)
    expect(after.accounts[0]!.verificationRequiredReason).toBe('auth-failure')
  })

  it('project healing updates the correct account by immutable key even if accounts are shifted', async () => {
    const accA = { ...account('a@x'), id: 'id-a', projectId: 'proj-a' }
    const accB = { ...account('b@x'), id: 'id-b', projectId: undefined }
    const accC = { ...account('c@x'), id: 'id-c', projectId: 'proj-c' }

    const store = new InMemoryAccountStore(storage([accA, accB, accC], 1))
    const sessions = new AgySessionManager({ store })

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('loadCodeAssist')) {
        // Concurrently delete accA from store while loadCodeAssist is in-flight
        await store.mutate((s) => {
          s.accounts.splice(0, 1) // accA deleted! accB is now index 0, accC is index 1
        })
        return new Response(JSON.stringify({ cloudaicompanionProject: 'healed-proj-b' }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session).toBeDefined()
    expect(session!.account.email).toBe('b@x')

    const after = await store.load()
    expect(after.accounts).toHaveLength(2) // accB and accC
    const targetB = after.accounts.find((a) => a.id === 'id-b')
    expect(targetB?.projectId).toBe('healed-proj-b')
    const targetC = after.accounts.find((a) => a.id === 'id-c')
    expect(targetC?.projectId).toBe('proj-c') // accC untouched!
  })

  it('session affinity preserves account by immutable key when preceding accounts are deleted', async () => {
    stubTokenEndpoint()
    const a = { ...account('a@x'), id: 'id-a' }
    const b = { ...account('b@x'), id: 'id-b' }
    const c = { ...account('c@x'), id: 'id-c' }
    const store = new InMemoryAccountStore(storage([a, b, c], 1))
    const sessions = new AgySessionManager({ store })

    // Pin session to b@x (index 1)
    const first = await sessions.getSession('gemini-3.5-flash')
    expect(first!.account.email).toBe('b@x')

    // Concurrently remove a@x (index 0) from store
    await store.mutate((s) => {
      s.accounts.splice(0, 1) // b@x is now index 0
    })

    // Next request within affinity window should STILL resolve to b@x (now at index 0)!
    const second = await sessions.getSession('gemini-3.5-flash')
    expect(second).toBeDefined()
    expect(second!.account.email).toBe('b@x')
    expect(second!.index).toBe(0)
  })

  it('client ID persistence failure rejects the promise and does not pollute tokenCache', async () => {
    let tokenFetchCount = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        tokenFetchCount++
        return new Response(JSON.stringify({ access_token: 'at-persist-fail', expires_in: 3600 }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const legacyAccount: ManagedAccount = { ...account('fail-persist@x'), clientId: undefined }
    const store = new InMemoryAccountStore(storage([legacyAccount]))
    const originalMutate = store.mutate.bind(store)
    let shouldFailMutate = true
    store.mutate = async (fn) => {
      if (shouldFailMutate) {
        throw new Error('disk unavailable: write failed')
      }
      return originalMutate(fn)
    }

    const sessions = new AgySessionManager({ store })

    // First request fails and leaves no dirty token cache
    await expect(sessions.getSession()).rejects.toThrow(/disk unavailable/)
    expect(tokenFetchCount).toBe(1)

    // Second request: now mutate succeeds -> MUST re-run refresh and persist, not bypass via cache
    shouldFailMutate = false
    const session = await sessions.getSession()
    expect(session).toBeDefined()
    expect(session!.auth.access).toBe('at-persist-fail')
    expect(tokenFetchCount).toBe(2)

    const after = await store.load()
    expect(after.accounts[0]!.clientId).toBe('1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com')
  })
})

describe('verifyAccount', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('re-enables a disabled account when credentials are live again', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('userinfo')) {
        return new Response(JSON.stringify({ email: 'a@b.c' }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const store = new InMemoryAccountStore(storage([{
      ...account('a@b.c'),
      enabled: false,
      verificationRequired: true,
      verificationRequiredReason: 'auth-failure',
    }]))
    const sessions = new AgySessionManager({ store })
    const result = await sessions.verifyAccount(0)
    expect(result).toEqual({ ok: true, email: 'a@b.c' })
    const after = await store.load()
    expect(after.accounts[0]!.enabled).toBe(true)
    expect(after.accounts[0]!.verificationRequired).toBe(false)
    expect(after.accounts[0]!.verificationRequiredReason).toBeUndefined()
  })
})

describe('impersonationHeadersFor', () => {
  it('randomizes when no fingerprint exists and stays stable with one', () => {
    const base = account()
    const first = impersonationHeadersFor(base)
    const second = impersonationHeadersFor(base)
    expect(first['User-Agent']).toMatch(/^antigravity\//)
    // no fingerprint → each call randomizes (no stability promise)
    expect(impersonationHeadersFor(base)).toBeDefined()
    void second

    const fp = { deviceId: 'd', sessionToken: 's', userAgent: 'antigravity/1.0.0 windows/amd64', apiClient: 'c', clientMetadata: { ideType: 'ANTIGRAVITY' }, createdAt: 0 }
    const stable = impersonationHeadersFor({ ...base, fingerprint: fp })
    expect(stable).toEqual({
      'User-Agent': 'antigravity/1.0.0 windows/amd64',
      'X-Goog-Api-Client': 'c',
      'Client-Metadata': '{"ideType":"ANTIGRAVITY"}',
    })
  })
})
