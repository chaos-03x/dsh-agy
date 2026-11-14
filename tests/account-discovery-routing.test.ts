import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AgyAdapter, MODEL_LIST_CACHE_TTL_MS } from '../src/adapter/adapter.ts'
import { resetDiscoveredTieredModels } from '../src/adapter/catalog.ts'
import { mergeModelCatalog } from '../src/adapter/models.ts'
import { AgySessionManager, isModelSupportedByAccount } from '../src/session.ts'
import { InMemoryAccountStore } from '../src/store/accounts.ts'
import type { ManagedAccount } from '../src/types.ts'

const hydrogen = 'gemini-4-hydrogen'
const low = `${hydrogen}-low`
const high = `${hydrogen}-high`
const sessionRequest = (model: string, effort?: string): GenerateOptions => ({
  provider: 'agy', model, ...(effort ? { reasoningEffort: effort } : {}),
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
}) as GenerateOptions
const account = (id: string, ids: string[]): ManagedAccount => ({
  id, email: `${id}@example.invalid`, refresh: `synthetic-${id}|project`, projectId: 'project',
  addedAt: 0, lastUsed: 0, enabled: true, cachedModels: ids, cachedQuota: {}, cachedQuotaUpdatedAt: Date.now(),
})
const fakeFetch = (dynamic: unknown) => vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('fetchAvailableModels')) return new Response(JSON.stringify(dynamic), { status: 200 })
  if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 })
  if (url.includes('streamGenerateContent')) return new Response('data: [DONE]\n\n', { status: 200 })
  return new Response('', { status: 404 })
})
afterEach(() => { resetDiscoveredTieredModels(); vi.unstubAllGlobals(); vi.useRealTimers() })

function makeHarness(accounts: ManagedAccount[]) {
  const store = new InMemoryAccountStore({ version: 4, accounts, activeIndex: 0 })
  let adapter!: AgyAdapter
  const sessions = new AgySessionManager({ store, modelEvidenceFor: (current) => adapter.discoveredModelsFor(current) })
  const selections: number[] = []
  adapter = new AgyAdapter({
    getSession: async (model, conversation, exact) => {
      const result = await sessions.getSession(model, undefined, conversation, exact)
      if (model && result) selections.push(result.index)
      return result
    },
    reportFailure: async () => {},
  })
  return { adapter, sessions, store, selections }
}

describe('account-scoped discovery and exact routes', () => {
  it.each(['xhigh', 'max'])('chooses an account that actually advertises standalone %s', async (extra) => {
    const native = 'gemini-3.8-flash-tiered'
    const wire = `gemini-3.8-flash-${extra}`
    mergeModelCatalog({ models: { [native]: {}, [wire]: {} } })
    const { adapter, selections } = makeHarness([account('native-only', [native]), account('extra', [wire])])
    vi.stubGlobal('fetch', fakeFetch({ models: {} }))
    for await (const _chunk of adapter.stream(sessionRequest(wire))) void _chunk
    expect(selections).toEqual([1])
  })

  it('uses newer successful discovery instead of the same account’s older fresh quota cache', async () => {
    const a = account('a', [low])
    const { adapter, sessions } = makeHarness([a])
    vi.stubGlobal('fetch', fakeFetch({ models: { [low]: {}, [high]: {} } }))
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(true)
    const picked = await sessions.getSession(high, undefined, 'test-conversation', true)
    expect(picked?.index).toBe(0)
    expect(adapter.discoveredModelsFor(a)?.sort()).toEqual([high, low].sort())
    for await (const _chunk of adapter.stream(sessionRequest(hydrogen, 'high'))) void _chunk
  })

  it('rejects a tier removed by a newer discovery instead of trusting the old cache', async () => {
    const a = account('a', [low, high])
    const { adapter, sessions } = makeHarness([a])
    vi.stubGlobal('fetch', fakeFetch({ models: { [low]: {}, [`${hydrogen}-medium`]: {} } }))
    await adapter.listAllModels(true)
    expect(await sessions.getSession(high, undefined, 'synthetic', true)).toBeUndefined()
    expect((await sessions.getSession(low, undefined, 'synthetic', true))?.index).toBe(0)
  })

  it('ages cached model IDs by their own observation time, not the quota time', () => {
    const a = account('a', [low])
    const now = Date.now()
    expect(isModelSupportedByAccount({ ...a, cachedModelsUpdatedAt: now, cachedQuotaUpdatedAt: 1 }, high, true)).toBe(false)
    expect(isModelSupportedByAccount({ ...a, cachedModelsUpdatedAt: now - MODEL_LIST_CACHE_TTL_MS - 1, cachedQuotaUpdatedAt: now }, high, true)).toBe(true)
    expect(isModelSupportedByAccount({ ...a, cachedModelsUpdatedAt: now + 60_000, cachedQuotaUpdatedAt: now }, high, true)).toBe(true)
  })

  it('does not reuse model evidence across credentials, accounts, projects or proxies', async () => {
    const a = account('a', [low])
    const { adapter } = makeHarness([a])
    vi.stubGlobal('fetch', fakeFetch({ models: { [low]: {}, [high]: {} } }))
    await adapter.listAllModels(true)
    expect(adapter.discoveredModelsFor(a)).toContain(high)
    expect(adapter.discoveredModelsFor(account('b', [low]))).toBeUndefined()
    expect(adapter.discoveredModelsFor({ ...a, refresh: 'different-synthetic-refresh' })).toBeUndefined()
    expect(adapter.discoveredModelsFor({ ...a, projectId: 'other-project' })).toBeUndefined()
    expect(adapter.discoveredModelsFor({ ...a, proxy: 'http://synthetic.invalid:8123' })).toBeUndefined()
  })

  it('does not override newer account probes or present old fallback data as fresh', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const a = account('a', [low])
    const { adapter } = makeHarness([a])
    vi.stubGlobal('fetch', fakeFetch({ models: { [low]: {}, [high]: {} } }))
    await adapter.listAllModels(true)
    expect(adapter.discoveredModelsFor(a)).toContain(high)
    const newerQuota = { ...a, cachedQuotaUpdatedAt: Date.now() + 1 }
    expect(adapter.discoveredModelsFor(newerQuota)).toBeUndefined()
    const newerModels = { ...a, cachedModelsUpdatedAt: Date.now() + 1 }
    expect(adapter.discoveredModelsFor(newerModels)).toBeUndefined()
    const olderModelsWithNewQuota = { ...a, cachedModelsUpdatedAt: Date.now() - 1, cachedQuotaUpdatedAt: Date.now() + 1 }
    expect(adapter.discoveredModelsFor(olderModelsWithNewQuota)).toContain(high)
    vi.setSystemTime(Date.now() + MODEL_LIST_CACHE_TTL_MS + 1)
    expect(adapter.discoveredModelsFor(a)).toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic discovery outage') }))
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(true)
    expect(adapter.discoveredModelsFor(a)).toBeUndefined()
  })
})
