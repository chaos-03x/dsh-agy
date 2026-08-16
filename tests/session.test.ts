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

    let session = await sessions.getSession()
    await sessions.reportFailure('rate-limit', session!)
    const first = (await store.load()).accounts[0]!.fingerprint!
    session = await sessions.getSession()
    await sessions.reportFailure('rate-limit', session!)
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

    const store = new InMemoryAccountStore(storage([account('a@x')]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(0)
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
    // Precise cooldown from the reported reset (capped at 30min), not the fixed 5min window.
    expect(failed.coolingDownUntil).toBeGreaterThan(Date.now() + 29 * 60 * 1000)
  })

  it('stable fingerprint mode pins one identity: no regeneration on repeated rate-limits', async () => {
    vi.stubEnv('DSH_AGY_FINGERPRINT_MODE', 'stable')
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x')]))
    const sessions = new AgySessionManager({ store })

    let session = await sessions.getSession()
    await sessions.reportFailure('rate-limit', session!)
    const first = (await store.load()).accounts[0]!.fingerprint!
    session = await sessions.getSession()
    await sessions.reportFailure('rate-limit', session!)
    const after = await store.load()
    expect(after.accounts[0]!.fingerprint!.deviceId).toBe(first.deviceId)
    expect(after.accounts[0]!.fingerprintHistory).toHaveLength(1)
    vi.unstubAllEnvs()
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
