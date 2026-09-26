import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgySessionManager, impersonationHeadersFor, SESSION_AFFINITY_WINDOW_MS } from '../src/session.ts'
import { MAX_IN_FLIGHT_PER_ACCOUNT } from '../src/runtime/rotation.ts'
import { _setFingerprintDataForTest } from '../src/runtime/fingerprint.ts'
import { _clearVersionCacheForTest } from '../src/runtime/version.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import { AgyAuthError, AgyPoolBlockedError } from '../src/types.ts'
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
    expect(session!.impersonation.clientMetadata.ideType).toContain('ANTIGRAVITY')
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

  it('gives concurrent conversations independent affinity pins', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    // Conversation A starts on the active account and pins it.
    const a1 = await sessions.getSession('gemini-3-flash', undefined, 'session-A')
    expect(a1!.index).toBe(0)

    // Conversation B is steered elsewhere (its own first pick follows the shared
    // activeIndex, which A's pin does not change) and pins that account.
    await store.mutate((s) => { s.activeIndex = 1 })
    const b1 = await sessions.getSession('gemini-3-flash', undefined, 'session-B')
    expect(b1!.index).toBe(1)

    // Both pins must survive independently. With the old single-slot pin, B's
    // selection overwrote A's and A would silently migrate on its next turn.
    expect((await sessions.getSession('gemini-3-flash', undefined, 'session-A'))!.index).toBe(0)
    expect((await sessions.getSession('gemini-3-flash', undefined, 'session-B'))!.index).toBe(1)

    // A pinned account failing frees only the conversations pinned to it.
    await sessions.reportFailure('rate-limit', b1!)
    expect((await sessions.getSession('gemini-3-flash', undefined, 'session-A'))!.index).toBe(0)
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

  function quotaAccount(
    email: string,
    quota: Record<string, { remainingFraction?: number; resetTime?: string; weeklyFraction?: number; weeklyResetTime?: string }>,
  ): ManagedAccount {
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

  it('uses a below-threshold account when it is the only candidate', async () => {
    stubTokenEndpoint()
    // Pins the DECISION, not just the mechanism: a drained account is ranked last
    // and thus skipped whenever an alternative exists (the test above), but it is
    // deliberately NOT hard-blocked until it is actually empty. Refusing to use
    // the last 5% would fail the turn outright, which is worse than spending
    // quota that resets anyway. AM's `quota_protection` reserves a percentage by
    // excluding such an account outright; that is a different product decision
    // (a reserve for a shared gateway) and would be a regression for a
    // single-user plugin whose alternative is "no answer".
    const store = new InMemoryAccountStore(storage([
      quotaAccount('only@x', { google: { remainingFraction: 0.05 } }),
    ], 0))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session).toBeDefined()
    expect(session!.index).toBe(0)
  })

  it('spreads concurrent fan-out off an account that is at its in-flight cap', async () => {
    stubTokenEndpoint()
    const a = account('a@x')
    const b = account('b@x')
    const store = new InMemoryAccountStore(storage([a, b], 0))
    const sessions = new AgySessionManager({ store })

    // Saturate account 0 (the one plain ranking would choose) and confirm the next
    // unrelated conversation is steered to account 1 instead of stacking on it.
    for (let i = 0; i < MAX_IN_FLIGHT_PER_ACCOUNT; i++) sessions.noteRequestStarted(a)
    const spread = await sessions.getSession('gemini-3-flash', undefined, 'session-C')
    expect(spread!.index).toBe(1)

    // Settling frees it again. Re-seed activeIndex first: spreading rotated it to
    // 1, and ranking is deliberately biased to the active index, which would
    // otherwise mask whether the cap still excludes account 0.
    sessions.noteRequestSettled(a)
    sessions.noteRequestSettled(a)
    sessions.noteRequestSettled(a)
    await store.mutate((s) => { s.activeIndex = 0 })
    const back = await sessions.getSession('gemini-3-flash', undefined, 'session-D')
    expect(back!.index).toBe(0)
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
      // The scheduling refresh reads the summary endpoint too; an empty summary
      // means "no window information", NOT "the windows are empty".
      if (url.includes('retrieveUserQuotaSummary')) return new Response(JSON.stringify({ groups: [] }), { status: 200 })
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

  it('lands the weekly window in cachedQuota from the scheduling refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        return new Response(JSON.stringify({
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: '2099-01-01T00:00:00Z' },
                { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.02, resetTime: '2099-06-01T00:00:00Z' },
              ],
            },
            {
              displayName: 'Claude and GPT models',
              buckets: [
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2099-06-01T00:00:00Z' },
              ],
            },
          ],
        }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          models: { 'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.4, resetTime: '2098-01-01T00:00:00Z' } } },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.getSession('gemini-3.5-flash')

    const after = await store.load()
    // Both endpoints are read on the scheduling path: the per-model counter is
    // the 5-hour window and the weekly budget has no per-model representation.
    // The earlier reset wins the 5-hour field; the weekly fields are untouched
    // by the per-model merge.
    expect(after.accounts[0]!.cachedQuota?.google).toEqual({
      remainingFraction: 0.4,
      resetTime: '2098-01-01T00:00:00Z',
      weeklyFraction: 0.02,
      weeklyResetTime: '2099-06-01T00:00:00Z',
      modelCount: 1,
    })
    // The shared 3p counter carries its weekly reading to BOTH families.
    expect(after.accounts[0]!.cachedQuota?.anthropic).toEqual({
      weeklyFraction: 0.5, weeklyResetTime: '2099-06-01T00:00:00Z',
    })
    expect(after.accounts[0]!.cachedQuota?.openai).toEqual({
      weeklyFraction: 0.5, weeklyResetTime: '2099-06-01T00:00:00Z',
    })
  })

  it('keeps the last known weekly window when the summary endpoint fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('retrieveUserQuotaSummary')) throw new TypeError('fetch failed')
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          models: { 'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.7, resetTime: '2099-01-01T00:00:00Z' } } },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const spentWeek: ManagedAccount = {
      ...account('a@x'),
      cachedQuota: {
        google: {
          remainingFraction: 0.7,
          resetTime: '2099-01-01T00:00:00Z',
          weeklyFraction: 0.002,
          weeklyResetTime: '2099-06-01T00:00:00Z',
        },
      },
      cachedQuotaUpdatedAt: 1, // an expired TTL forces the refresh
    }
    const store = new InMemoryAccountStore(storage([spentWeek, account('b@x')]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    const after = await store.load()
    // A failed summary reports "unknown", not "no weekly limit": erasing the
    // reading would hand a week-exhausted account straight back to selection.
    expect(after.accounts[0]!.cachedQuota?.google?.weeklyFraction).toBe(0.002)
    expect(after.accounts[0]!.cachedQuota?.google?.weeklyResetTime).toBe('2099-06-01T00:00:00Z')
    expect(session!.index).toBe(1)
  })

  it('moves off a pinned account whose WEEKLY window is spent', async () => {
    stubTokenEndpoint()
    const store = new InMemoryAccountStore(storage([
      quotaAccount('a@x', {
        google: { remainingFraction: 0.9, weeklyFraction: 0.002, weeklyResetTime: '2099-01-01T00:00:00Z' },
      }),
      quotaAccount('b@x', {
        google: { remainingFraction: 0.8, weeklyFraction: 0.8, weeklyResetTime: '2099-01-01T00:00:00Z' },
      }),
    ]))
    const sessions = new AgySessionManager({ store })
    // Account 0 has the HEALTHIER 5-hour bucket; only the weekly window says it
    // is out of budget, which is exactly the reading that used to be invisible.
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session!.index).toBe(1)
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

  it('serves deterministic fallback headers without a fingerprint, in either mode', () => {
    // The pre-fingerprint fallback used to re-randomize platform per call in the
    // default `dynamic` mode, so one account's consecutive requests could claim
    // two different platforms. An OS that changes between two requests of one
    // session is a stronger anomaly than a stale version, so the fallback is now
    // deterministic regardless of mode — and the platform is pinned outright.
    for (const mode of ['dynamic', 'stable']) {
      vi.stubEnv('DSH_AGY_FINGERPRINT_MODE', mode)
      const first = impersonationHeadersFor(account('a@x'))
      const second = impersonationHeadersFor(account('a@x'))
      expect(first).toEqual(second)
      expect(first['User-Agent']).toMatch(/^antigravity\/\d+\.\d+\.\d+ \S+$/)
      expect(first.clientMetadata.ideType).toContain('ANTIGRAVITY')
      vi.unstubAllEnvs()
    }
  })

  it('freezes one device identity per account from the first request', async () => {
    stubTokenEndpoint()
    const acc = account('first-use@x')
    const store = new InMemoryAccountStore(storage([acc]))
    const sessions = new AgySessionManager({ store })

    expect(await sessions.getSession('gemini-3-flash')).toBeDefined()
    const after = (await store.load()).accounts[0]!
    // The identity must exist before any rate-limit: otherwise the fallback path
    // serves the first requests and the account appears to change machine.
    expect(after.fingerprint).toBeDefined()
    expect(after.fingerprintHistory?.length).toBe(1)
    expect(after.fingerprintHistory?.[0]?.reason).toBe('initial')

    const first = after.fingerprint!.userAgent
    // A second session on the same account reuses the stored identity.
    expect(await sessions.getSession('gemini-3-flash')).toBeDefined()
    expect((await store.load()).accounts[0]!.fingerprint!.userAgent).toBe(first)
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

  it('hard gates and throws AgyPoolBlockedError when the requested family is rate-limited on all accounts', async () => {
    stubTokenEndpoint()
    const a = account('a@x')
    const b = account('b@x')
    const resetAt = Date.now() + 60_000
    a.rateLimitResetTimes = { google: resetAt }
    b.rateLimitResetTimes = { google: resetAt }
    const store = new InMemoryAccountStore(storage([a, b]))
    const sessions = new AgySessionManager({ store })

    // When requested for Gemini (google family), all accounts are blocked -> throws retryable AgyPoolBlockedError
    await expect(sessions.getSession('gemini-3.5-flash')).rejects.toMatchObject({
      name: 'AgyPoolBlockedError',
      kind: 'retryable',
      blockedUntil: resetAt,
    })
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

    await expect(sessions.getSession()).rejects.toMatchObject({ name: 'AgyAuthError', kind: 'transport' })
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

  it('degrades gracefully when quota cache mutate fails and overlays fresh quota in memory', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at-quota-ok', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          models: {
            'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.8, resetTime: '2099-01-01T00:00:00Z' } },
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    // Both accounts start with stale exhausted quota (remainingFraction: 0)
    const a = {
      ...account('a@x'),
      cachedQuota: { google: { remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' } },
      cachedQuotaUpdatedAt: 1, // expired TTL
    }
    const b = {
      ...account('b@x'),
      cachedQuota: { google: { remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' } },
      cachedQuotaUpdatedAt: 1, // expired TTL
    }
    const store = new InMemoryAccountStore(storage([a, b]))
    const originalMutate = store.mutate.bind(store)
    // Mutate throws an error (e.g. disk write failure)
    store.mutate = async (fn) => {
      const storageCopy = await store.load()
      const isQuotaWrite = await (async () => {
        try {
          await fn(storageCopy)
          return Boolean(storageCopy.accounts[0]?.cachedQuota?.google?.remainingFraction === 0.8)
        } catch {
          return false
        }
      })()
      if (isQuotaWrite) {
        throw new Error('disk locked: quota write failed')
      }
      return originalMutate(fn)
    }

    const sessions = new AgySessionManager({ store })
    // getSession must NOT throw quota-exhausted — in-memory overlay provides the newly probed 0.8 headroom!
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session).toBeDefined()
    expect(session!.auth.access).toBe('at-quota-ok')
  })

  it('throws transport AgyAuthError on transient token endpoint failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response('{"error":"internal_server_error"}', { status: 500, statusText: 'Internal Server Error' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x')]))
    const sessions = new AgySessionManager({ store })

    await expect(sessions.getSession()).rejects.toMatchObject({
      name: 'AgyAuthError',
      kind: 'transport',
    })
  })

  it('switches to another enabled account within the same request after invalid_grant', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes('oauth2.googleapis.com/token')) throw new Error(`unexpected fetch: ${url}`)
      const refresh = new URLSearchParams(String(init?.body)).get('refresh_token')
      if (refresh === 'rt-revoked@x') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      }
      return new Response(JSON.stringify({ access_token: 'healthy-token', expires_in: 3600 }), { status: 200 })
    }))

    const now = Date.now()
    const revoked = { ...account('revoked@x'), cachedQuota: { google: { remainingFraction: 0.8 } }, cachedQuotaUpdatedAt: now }
    const healthy = { ...account('healthy@x'), cachedQuota: { google: { remainingFraction: 0.8 } }, cachedQuotaUpdatedAt: now }
    const store = new InMemoryAccountStore(storage([revoked, healthy]))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session?.account.email).toBe('healthy@x')
    expect(session?.auth.access).toBe('healthy-token')
    const after = await store.load()
    expect(after.accounts[0]).toMatchObject({ enabled: false, verificationRequired: true })
    expect(after.accounts[1]?.enabled).toBe(true)
  })

  it('classifies invalid_client as a permanent credential error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_client' }),
      { status: 400, statusText: 'Bad Request' },
    )))
    const sessions = new AgySessionManager({
      store: new InMemoryAccountStore(storage([account('invalid@x')])),
    })

    await expect(sessions.getSession()).rejects.toMatchObject({
      name: 'AgyAuthError',
      kind: 'invalid-credential',
    } satisfies Partial<AgyAuthError>)
  })

  it('throws quota-exhausted AgyPoolBlockedError when all accounts are quota-exhausted', async () => {
    stubTokenEndpoint()
    const resetAt = Date.now() + 12 * 60 * 60 * 1000
    const a = {
      ...account('a@x'),
      coolingDownUntil: resetAt,
      cooldownReason: 'quota-exhausted' as const,
    }
    const b = {
      ...account('b@x'),
      cachedQuota: { google: { remainingFraction: 0, resetTime: new Date(resetAt).toISOString() } },
      cachedQuotaUpdatedAt: Date.now(),
    }
    const store = new InMemoryAccountStore(storage([a, b]))
    const sessions = new AgySessionManager({ store })

    await expect(sessions.getSession('gemini-3.5-flash')).rejects.toMatchObject({
      name: 'AgyPoolBlockedError',
      kind: 'quota-exhausted',
      blockedUntil: resetAt,
    })
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
  it('is deterministic without a fingerprint, and uses the snapshot with one', () => {
    const base = account()
    const first = impersonationHeadersFor(base)
    const second = impersonationHeadersFor(base)
    expect(first['User-Agent']).toMatch(/^antigravity\//)
    // No fingerprint yet: one FIXED identity, identical on every call. This used
    // to randomize per request, which is the anomaly the stable posture removes —
    // a device that presents a different platform/SDK-client on each call is not
    // something an official client does.
    expect(second).toEqual(first)

    const fp = { deviceId: 'd', sessionToken: 's', userAgent: 'antigravity/1.0.0 windows/amd64', apiClient: 'c', clientMetadata: { ideType: 'ANTIGRAVITY' }, createdAt: 0 }
    const stable = impersonationHeadersFor({ ...base, fingerprint: fp })
    expect(stable).toEqual({
      'User-Agent': 'antigravity/1.0.0 windows/amd64',
      'X-Goog-Api-Client': 'c',
      clientMetadata: { ideType: 'ANTIGRAVITY' },
    })
    // The metadata is a BODY message and must not leak back into the headers: an
    // object value spread into a `HeadersInit` is the shape that produced the
    // comma-joined User-Agent this suite already guards against.
    expect(Object.keys(stable).sort()).toEqual(['User-Agent', 'X-Goog-Api-Client', 'clientMetadata'])
  })
})

describe('getSession transport context (issue #29)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reports a transient refresh failure as transport, not proxy_unreachable, without a proxy', async () => {
    // A bare ECONNRESET with NO proxy configured used to be reported as
    // `proxy_unreachable`, which made a healthy account look like a dead proxy
    // and (with several accounts) got it skipped un-cooldowned.
    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new TypeError('fetch failed')
      ;(error as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      throw error
    }))

    const store = new InMemoryAccountStore(storage([account('a@b.c')]))
    const sessions = new AgySessionManager({ store })

    await expect(sessions.getSession()).rejects.toMatchObject({
      name: 'AgyAuthError',
      kind: 'transport',
    })
    // The actionable cause survives into the message.
    await expect(sessions.getSession()).rejects.toThrow(/ECONNRESET/)
  })

  it('still fails closed as proxy_unreachable when the account has a proxy', async () => {
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')

    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new TypeError('fetch failed')
      ;(error as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
      throw error
    }))

    await withProxyFixture(async (proxyUrl) => {
      const proxied: ManagedAccount = { ...account('p@x'), proxy: proxyUrl }
      const store = new InMemoryAccountStore(storage([proxied]))
      const sessions = new AgySessionManager({ store })

      await expect(sessions.getSession()).rejects.toMatchObject({
        name: 'AgyAuthError',
        kind: 'transport',
        message: 'proxy_unreachable',
      })
    })
  })
})

describe('testCall routing (issue #29)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('routes the test-generation stream through the account proxy', async () => {
    const { dispatcherForAsync } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      return new Response('data: [{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}]\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await withProxyFixture(async (accountProxy) => {
      const store = new InMemoryAccountStore(storage([{ ...account('a@b.c'), proxy: accountProxy }]))
      const sessions = new AgySessionManager({ store })
      await sessions.testCall('gemini-3.6-flash-high')

      const streamCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('streamGenerateContent'))
      expect(streamCall, 'testCall must issue a streamGenerateContent request').toBeDefined()
      const dispatcher = (streamCall![1] as { dispatcher?: unknown } | undefined)?.dispatcher
      expect(dispatcher).toBe(await dispatcherForAsync(accountProxy, { streaming: true }))
    })
  })
})

describe('pinned test call (management "Test call" per account row)', () => {
  afterEach(() => vi.unstubAllGlobals())

  /**
   * Answer the token endpoint per account and record which bearer each stream
   * call carried, so the test can prove WHICH account was probed.
   *
   * The marker is decoded from the form body because `URLSearchParams`
   * percent-encodes the `@` in a real refresh token (`rt-b@x` -> `rt-b%40x`).
   * Only `streamGenerateContent` is recorded: the pool path also calls
   * `fetchAvailableModels`, which is not the call under test.
   */
  function stubStream(accounts: ManagedAccount[]): { store: InMemoryAccountStore, streams: string[] } {
    const streams: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const body = decodeURIComponent(String(init?.body ?? ''))
      if (url.includes('token')) {
        const which = body.includes('rt-b@x') ? 'b' : 'a'
        return new Response(JSON.stringify({ access_token: `at-${which}`, expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('streamGenerateContent')) {
        streams.push(String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''))
      }
      return new Response('data: [{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}]\n\ndata: [DONE]\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }))
    return { store: new InMemoryAccountStore(storage(accounts, 0)), streams }
  }

  it('tests the requested account, not the affinity/active one', async () => {
    // Regression: the clicked row's index was dropped on the way to the host, so
    // the probe ran on whichever account affinity picked (here index 0) while its
    // result was shown — and recorded — against the row the user clicked.
    const { store, streams } = stubStream([account('a@x'), account('b@x')])
    const sessions = new AgySessionManager({ store })

    const result = await sessions.testCall('gemini-3.6-flash-high', { accountIndex: 1 })
    expect(result.ok).toBe(true)
    expect(streams).toEqual(['Bearer at-b'])
  })

  it('does not move the pool cursor for a test call', async () => {
    // A one-shot probe is not "using" the account: repointing activeIndex would
    // steer the next real conversation onto the account that was merely tested.
    const { store } = stubStream([account('a@x'), account('b@x')])
    const sessions = new AgySessionManager({ store })
    await sessions.testCall('gemini-3.6-flash-high', { accountIndex: 1 })
    expect((await store.load()).activeIndex).toBe(0)
  })

  it('reports a missing or disabled pinned account instead of falling back', async () => {
    // Falling back would answer a question nobody asked and attribute the result
    // to the wrong account, which is the bug this pin exists to prevent.
    const { store } = stubStream([account('a@x'), { ...account('b@x'), enabled: false }])
    const sessions = new AgySessionManager({ store })
    const missing = await sessions.testCall('gemini-3.6-flash-high', { accountIndex: 9 })
    expect(missing.ok).toBe(false)
    expect(missing.error).toMatch(/not found/)

    const disabled = await sessions.testCall('gemini-3.6-flash-high', { accountIndex: 1 })
    expect(disabled.ok).toBe(false)
    expect(disabled.error).toMatch(/disabled/)
  })

  it('still ranks the pool when no index is given', async () => {
    const { store, streams } = stubStream([account('a@x'), account('b@x')])
    const sessions = new AgySessionManager({ store })
    const result = await sessions.testCall('gemini-3.6-flash-high')
    expect(result.ok).toBe(true)
    expect(streams).toHaveLength(1)
  })
})

describe('project-healing routing (issue #29)', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('routes loadCodeAssist through the account proxy', async () => {
    const { dispatcherForAsync } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')

    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('loadCodeAssist')) {
        return new Response(JSON.stringify({ cloudaicompanionProject: { id: 'proj-healed' } }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchSpy)

    await withProxyFixture(async (accountProxy) => {
      const store = new InMemoryAccountStore(storage([
        { ...account('a@b.c'), projectId: undefined, proxy: accountProxy },
      ]))
      const sessions = new AgySessionManager({ store })
      const resolved = await sessions.getSession('gemini-3.6-flash-high')

      expect(resolved?.account.projectId).toBe('proj-healed')
      const healCall = fetchSpy.mock.calls.find((call) => String(call[0]).includes('loadCodeAssist'))
      expect(healCall, 'project healing must issue a loadCodeAssist request').toBeDefined()
      const dispatcher = (healCall![1] as { dispatcher?: unknown } | undefined)?.dispatcher
      expect(dispatcher).toBe(await dispatcherForAsync(accountProxy))
    })
  })
})

describe('proxyless transport failover (issue #29)', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Token endpoint resets transiently for accounts whose refresh token starts with a bad prefix. */
  function resetFor(badPrefixes: string[]) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        const refreshToken = new URLSearchParams(String(init?.body)).get('refresh_token') ?? ''
        if (badPrefixes.some((prefix) => refreshToken.startsWith(prefix))) {
          const error = new TypeError('fetch failed')
          ;(error as { cause?: unknown }).cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
          throw error
        }
        return new Response(JSON.stringify({ access_token: 'at-ok', expires_in: 3600 }), { status: 200 })
      }
      return new Response(JSON.stringify({ models: {} }), { status: 200 })
    })
  }

  it('falls over to a healthy account when a proxyless account has a transient failure', async () => {
    // Regression: reporting a bare reset as proxy_unreachable/rethrowing it made a
    // multi-account DIRECT pool lose failover entirely (issue #29).
    vi.stubGlobal('fetch', resetFor(['rt-a']))
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    const session = await sessions.getSession('gemini-3.6-flash-high')
    expect(session, 'must fail over rather than abort on one transient reset').toBeDefined()
    expect(session!.account.email).toBe('b@x')
  })

  it('reports the real transport cause when every proxyless account fails', async () => {
    // Must not degrade into "no account configured" (a bare `undefined` return)
    // nor mislabel the network error as a proxy failure.
    vi.stubGlobal('fetch', resetFor(['rt-a', 'rt-b']))
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })

    await expect(sessions.getSession('gemini-3.6-flash-high')).rejects.toMatchObject({
      name: 'AgyAuthError',
      kind: 'transport',
    })
    await expect(sessions.getSession('gemini-3.6-flash-high')).rejects.toThrow(/ECONNRESET/)
  })

  it('does not write a cooldown that would mislabel the pool as rate-limited', async () => {
    vi.stubGlobal('fetch', resetFor(['rt-a']))
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')], 0))
    const sessions = new AgySessionManager({ store })
    await sessions.getSession('gemini-3.6-flash-high')

    const after = await store.load()
    // A cooldown here would surface as AgyPoolBlockedError -> RATE_LIMIT for what
    // is a plain network error, and would block the only account in a solo pool.
    expect(after.accounts[0]!.coolingDownUntil).toBeUndefined()
    expect(after.accounts[0]!.cooldownReason).toBeUndefined()
  })
})

/**
 * Kept last on purpose: it clears the version feed caches, and the 750 ms bounded
 * resolve its hang forces would otherwise be paid again by every later
 * rate-limit test in this file.
 */
describe('fingerprint version freshness', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('never freezes a new fingerprint onto a random pool version', async () => {
    // Whatever version is written here is the account's User-Agent for the
    // lifetime of that fingerprint. The only way this path reaches
    // `generateFingerprint` without a version is the bounded resolve giving up
    // (750 ms) — the slow-or-blocked-feed cold start — and that function's own
    // default then picks a RANDOM `versionPool` entry, which could freeze an
    // account onto a two-minor-old client. The pool is forced to a single stale
    // entry and the feed HANGS, so the 750 ms race is what actually decides and a
    // regression cannot pass by luck.
    _clearVersionCacheForTest()
    _setFingerprintDataForTest({
      versionPool: ['1.22.2'],
      platforms: ['darwin/arm64'],
      sdkClients: ['google-cloud-sdk vscode/1.96.0'],
      ideTypes: ['ANTIGRAVITY'],
    })
    try {
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
        }
        // Accept and never answer. Rejecting fast would NOT reproduce the case: the
        // public resolver applies the pinned fallback itself, so a fast failure
        // never reaches `generateFingerprint` without a version.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
      }))
      const store = new InMemoryAccountStore(storage([account('a@x')]))
      const sessions = new AgySessionManager({ store })
      const session = await sessions.getSession('gemini-3-flash')

      // Strip the identity that first use just created, so the assertion exercises
      // the rate-limit creation path. Leaving it in place made this test vacuous:
      // the first-use path (`getSession`) already passes `currentAgyVersion()`
      // explicitly, and with a fingerprint present `consecutive` is 1, so nothing
      // was generated here at all and the random-pool default was never reached.
      await store.mutate((draft) => {
        delete draft.accounts[0]!.fingerprint
        delete draft.accounts[0]!.fingerprintHistory
      })
      await sessions.reportFailure('rate-limit', session!, { model: 'gemini-3-flash' })

      const fp = (await store.load()).accounts[0]!.fingerprint!
      expect(fp.userAgent).not.toContain('1.22.2')
      expect(fp.userAgent).toMatch(/^antigravity\/\d+\.\d+\.\d+ darwin\/arm64$/)
    } finally {
      _setFingerprintDataForTest(undefined)
      vi.unstubAllGlobals()
    }
  }, 5_000)

  it('probes the version feeds through the failing account egress', async () => {
    // The feeds belong to no account, but the request still egresses the host: a
    // per-account-proxy user must not leak the real IP on the failure path. The
    // boot-time probe already routed this way; this one was left on the env/direct
    // route, which is the drift `probeFetch` now prevents.
    _clearVersionCacheForTest()
    const probed: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      probed.push((init as { dispatcher?: unknown } | undefined)?.dispatcher)
      // Never answer: the bounded resolve gives up, and all we assert is WHICH
      // egress carried the attempt.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }))

    // A REAL loopback listener: `proxiedFetch` TCP-fast-fails before it reaches
    // `fetch`, so a closed port would never exercise the routing at all.
    const { dispatcherForAsync } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')
    await withProxyFixture(async (proxyUrl) => {
      const store = new InMemoryAccountStore(storage([{ ...account('a@x'), proxy: proxyUrl }]))
      const sessions = new AgySessionManager({ store })
      const session = await sessions.getSession('gemini-3-flash')
      await sessions.reportFailure('rate-limit', session!, { model: 'gemini-3-flash' })

      expect(probed.length).toBeGreaterThan(0)
      expect(probed[0]).not.toBeUndefined()
      expect(probed[0]).toBe(await dispatcherForAsync(proxyUrl))
    })
  }, 5_000)
})
