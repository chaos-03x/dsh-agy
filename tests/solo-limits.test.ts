import { describe, expect, it, vi } from 'vitest'
import { AgySessionManager } from '../src/session.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import { isLimitsStale, LIMITS_CACHE_TTL_MS } from '../src/runtime/quota.ts'
import type { ManagedAccount } from '../src/types.ts'

function account(email = 'a@b.c'): ManagedAccount {
  return { email, refresh: `rt-${email}|proj-1`, projectId: 'proj-1', addedAt: 0, lastUsed: 0, enabled: true }
}
function storage(accounts: ManagedAccount[], activeIndex = 0) {
  return { version: 4 as const, accounts, activeIndex }
}

/** Stub the summary endpoint, and record whether it was called. */
function stubSummary(calls: string[], groups: unknown = [{
  displayName: 'Gemini Models',
  buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.16, resetTime: '2026-09-23T19:29:55Z' }],
}]) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
    }
    if (url.includes('retrieveUserQuotaSummary')) {
      return new Response(JSON.stringify({ groups }), { status: 200 })
    }
    if (url.includes('fetchAvailableModels')) {
      return new Response(JSON.stringify({ models: { 'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.4 } } } }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

describe('solo-account limits', () => {
  it('fills cachedLimits with ONE enabled account', async () => {
    // Regression: `refreshLimits` exists because the SCHEDULING quota refresh is
    // gated on `eligible.length > 1` — measuring a solo account's quota could
    // block the only account (verified: a measured zero-remaining family raises
    // AgyPoolBlockedError with no fallback). That gate left `cachedLimits` empty
    // forever for a single account, so the limits card read "not measured yet"
    // permanently. The display refresh must therefore work at any pool size.
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())

    const after = await store.load()
    expect(calls.some((url) => url.includes('retrieveUserQuotaSummary'))).toBe(true)
    expect(after.accounts[0]!.cachedLimits?.groups[0]?.windows[0]).toEqual({
      bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.16, resetTime: '2026-09-23T19:29:55Z',
    })
  })

  it('NEVER writes cachedQuota, which is what keeps a solo account unblockable', async () => {
    // The whole safety argument for ungating the display refresh: it must not
    // touch the cache that `rankPoolCandidates` turns into `blockedUntil`.
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())

    const after = await store.load()
    expect(after.accounts[0]!.cachedQuota).toBeUndefined()
    expect(after.accounts[0]!.cachedQuotaUpdatedAt).toBeUndefined()
    // And the request path still resolves rather than raising a pool error.
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session?.account.email).toBe('solo@x')
  })

  it('keeps selection working when the family is measured at zero', async () => {
    // The failure mode that motivated the gate, pinned so the display refresh can
    // never be "simplified" into writing cachedQuota.
    const calls: string[] = []
    stubSummary(calls)
    const solo = {
      ...account('solo@x'),
      cachedQuota: { google: { remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' } },
      cachedQuotaUpdatedAt: Date.now(),
    }
    const store = new InMemoryAccountStore(storage([solo]))
    const sessions = new AgySessionManager({ store })
    // Baseline: a measured-zero scheduling quota DOES block, which is exactly why
    // the display path must stay out of it.
    await expect(sessions.getSession('gemini-3.5-flash')).rejects.toThrow(/exhausted quota/)
  })

  it('does not re-probe while fresh, and refreshes once stale', async () => {
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())
    const first = calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length
    expect(first).toBe(1)

    // A second call within the TTL must not hit the network again.
    await sessions.refreshLimits(await store.load())
    expect(calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length).toBe(1)

    // Age the snapshot past the TTL: now it re-probes.
    await store.mutate((s) => {
      s.accounts[0]!.cachedLimits = { groups: s.accounts[0]!.cachedLimits!.groups, updatedAt: Date.now() - LIMITS_CACHE_TTL_MS - 1 }
    })
    await sessions.refreshLimits(await store.load())
    expect(calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length).toBe(2)
  })

  it('force re-probes INSIDE the TTL, which is what an explicit refresh needs', async () => {
    // The toolbar's Refresh button is the only caller allowed to do this: without
    // it, clicking Refresh while the snapshot was still fresh could not deliver
    // anything newer, so "give me the latest numbers now" was unanswerable.
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())
    const probed = (): number => calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length
    expect(probed()).toBe(1)

    // Still fresh, so the TTL path skips it and reports the skip.
    const skipped = await sessions.refreshLimits(await store.load())
    expect(probed()).toBe(1)
    expect(skipped).toEqual({ measured: [], failed: [], skipped: 1 })

    // Force is the one thing that spends the call inside the TTL.
    const beforeForce = await store.load()
    const forced = await sessions.refreshLimits(beforeForce, { force: true })
    expect(probed()).toBe(2)
    // Keyed by the store-assigned account id, not the email: `accountKey` prefers
    // `id` so two accounts sharing an email cannot collide.
    expect(forced.measured).toEqual([beforeForce.accounts[0]!.id])
    expect(forced.failed).toEqual([])
    expect(forced.skipped).toBe(0)
  })

  it('reports a failed probe instead of leaving the caller unable to tell', async () => {
    // The defect this closes: a forced refresh that failed wrote no cache and no
    // timestamp, so the click looked inert — "probed and failed" and "was still
    // fresh" were indistinguishable from the UI. The result must separate them.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('retrieveUserQuotaSummary')) throw new TypeError('fetch failed')
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    const loaded = await store.load()
    const result = await sessions.refreshLimits(loaded, { force: true })
    expect(result.measured).toEqual([])
    expect(result.failed).toEqual([loaded.accounts[0]!.id])
    expect(result.skipped).toBe(0)
  })

  it('force still never writes cachedQuota', async () => {
    // The safety argument must survive the new bypass: `force` changes WHICH
    // accounts are probed, never WHERE the result lands. Writing `cachedQuota`
    // here would let a forced refresh block a solo account outright.
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('solo@x')]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load(), { force: true })
    const after = await store.load()
    expect(after.accounts[0]!.cachedQuota).toBeUndefined()
    expect(after.accounts[0]!.cachedQuotaUpdatedAt).toBeUndefined()
    expect(after.accounts[0]!.cachedLimits?.groups).toHaveLength(1)
  })

  it('indices narrow WHICH accounts are probed (the per-account refresh button)', async () => {
    // One card's refresh must not probe the whole pool through several proxies:
    // naming an index constrains the target set exactly like `force` does, and
    // changes nothing about WHERE the result lands (`cachedLimits` only — see
    // the force test above, whose argument this inherits).
    const calls: string[] = []
    stubSummary(calls)
    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x'), account('c@x')]))
    const sessions = new AgySessionManager({ store })
    const loaded = await store.load()

    const solo = await sessions.refreshLimits(loaded, { force: true, indices: [1] })
    expect(calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length).toBe(1)
    expect(solo.measured).toEqual([loaded.accounts[1]!.id])
    expect(solo.skipped).toBe(0)
    // Only the NAMED account learned anything.
    const after = await store.load()
    expect(after.accounts[1]!.cachedLimits).toBeDefined()
    expect(after.accounts[0]!.cachedLimits).toBeUndefined()
    expect(after.accounts[2]!.cachedLimits).toBeUndefined()

    // A disabled account is not switched back on by being named: the candidate
    // set is emptied by the enabled filter (not the TTL), so nothing is skipped.
    await store.mutate((s) => {
      s.accounts[1]!.enabled = false
      s.accounts[0]!.cachedLimits = undefined
    })
    calls.length = 0
    const disabled = await sessions.refreshLimits(await store.load(), { force: true, indices: [1] })
    expect(calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length).toBe(0)
    expect(disabled.measured).toEqual([])
    expect(disabled.skipped).toBe(0)
  })

  it('leaves previous windows intact when the probe fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('retrieveUserQuotaSummary')) throw new TypeError('fetch failed')
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const existing = {
      ...account('solo@x'),
      cachedLimits: { groups: [{ name: 'old', windows: [] }], updatedAt: 1 },
    }
    const store = new InMemoryAccountStore(storage([existing]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())
    // A failed probe must not erase what was already known.
    expect((await store.load()).accounts[0]!.cachedLimits?.groups[0]?.name).toBe('old')
  })

  it('shares ONE in-flight summary probe per account between the display and scheduling paths', async () => {
    // #54 item 1: since #48 both paths read `retrieveUserQuotaSummary` for the
    // same account in one cycle, so a stale multi-account pool paid two round
    // trips per account. `quotaRefreshInFlight` de-duplicated within the
    // scheduling path; `refreshLimits` did not consult it.
    // RED (pre-fix): 4 summary calls for a two-account pool. GREEN: 2.
    const calls: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 })
      }
      if (url.includes('retrieveUserQuotaSummary')) {
        // Held open so the two paths genuinely overlap.
        await gate
        return new Response(JSON.stringify({
          groups: [{
            displayName: 'Gemini Models',
            buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.16, resetTime: '2026-09-23T19:29:55Z' }],
          }],
        }), { status: 200 })
      }
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({ models: { 'gemini-3.5-flash': { quotaInfo: { remainingFraction: 0.4 } } } }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const store = new InMemoryAccountStore(storage([account('a@x'), account('b@x')]))
    const sessions = new AgySessionManager({ store })
    const loaded = await store.load()
    const summaryCalls = (): number => calls.filter((url) => url.includes('retrieveUserQuotaSummary')).length
    const modelCalls = (): number => calls.filter((url) => url.includes('fetchAvailableModels')).length

    const limits = sessions.refreshLimits(loaded, { force: true })
    const session = sessions.getSession('gemini-3.5-flash')
    // Wait until BOTH paths have started: `fetchAvailableModels` is only called by
    // the scheduling path, and it is issued alongside that path's summary probe.
    for (let i = 0; i < 200 && (modelCalls() < 2 || summaryCalls() < 2); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(modelCalls()).toBe(2)
    // WHILE the first probe per account is still in flight, the other path joins
    // it instead of paying a second round trip.
    expect(summaryCalls()).toBe(2)

    release()
    await limits
    await session

    expect(summaryCalls()).toBe(2)
    const after = await store.load()
    // Sharing the probe must not change WHERE a result lands: the display path
    // still fills `cachedLimits`, the scheduling path still fills `cachedQuota`.
    expect(after.accounts.every((a) => a.cachedLimits?.groups.length === 1)).toBe(true)
    expect(after.accounts.every((a) => a.cachedQuota?.google?.remainingFraction === 0.16)).toBe(true)
  })

  it('treats an absent or non-numeric snapshot as stale', () => {
    expect(isLimitsStale(account())).toBe(true)
    expect(isLimitsStale({ ...account(), cachedLimits: { groups: [], updatedAt: Number.NaN } })).toBe(true)
    expect(isLimitsStale({ ...account(), cachedLimits: { groups: [], updatedAt: Date.now() } })).toBe(false)
  })

  it('lifts a false quota-exhausted park when the display probe measures quota remaining', async () => {
    // A SOLO pool never runs the scheduling refresh (the >1 gate), so the display
    // probe is the ONLY evidence that can contradict a false park. A burst 429
    // whose body merely said "quota" parks a healthy account for up to a day;
    // opening the accounts page measures and heals it instead of leaving the
    // 冷却至 badge up until the cooldown expires while every run reports
    // "quota exhausted".
    const calls: string[] = []
    stubSummary(calls)
    const parked = {
      ...account('solo@x'),
      coolingDownUntil: Date.now() + 20 * 60 * 60 * 1000,
      cooldownReason: 'quota-exhausted' as const,
      cooldownSetAt: Date.now() - 60_000,
    }
    const store = new InMemoryAccountStore(storage([parked]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())

    const after = await store.load()
    expect(after.accounts[0]!.coolingDownUntil).toBeUndefined()
    expect(after.accounts[0]!.cooldownReason).toBeUndefined()
    expect(after.accounts[0]!.cooldownSetAt).toBeUndefined()
    // And the healed account serves again.
    const session = await sessions.getSession('gemini-3.5-flash')
    expect(session?.account.email).toBe('solo@x')
  })

  it('keeps a park the fresh measurement CONFIRMS (a spent window with a future reset)', async () => {
    // The lift must never turn a real exhaustion back into a hammering loop: a
    // weekly bucket at 0 with its reset still ahead is exactly what the park is
    // for, whatever the burst 429 said.
    const calls: string[] = []
    stubSummary(calls, [{
      displayName: 'Gemini Models',
      buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: null },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0, resetTime: '2099-01-01T00:00:00Z' },
      ],
    }])
    const parked = {
      ...account('solo@x'),
      coolingDownUntil: Date.now() + 3_600_000,
      cooldownReason: 'quota-exhausted' as const,
      cooldownSetAt: Date.now() - 60_000,
    }
    const store = new InMemoryAccountStore(storage([parked]))
    const sessions = new AgySessionManager({ store })
    await sessions.refreshLimits(await store.load())

    const after = await store.load()
    expect(after.accounts[0]!.coolingDownUntil).toBeGreaterThan(Date.now())
    expect(after.accounts[0]!.cooldownReason).toBe('quota-exhausted')
  })
})
