import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { resetDiscoveredTieredModels } from '../src/adapter/catalog.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { listAgyModels, mergeModelCatalog, ModelDiscoveryCache, resolveAgyModel } from '../src/adapter/models.ts'
import { resolveWireModel, toAgyRequestBody } from '../src/adapter/translate.ts'
import { isModelSupportedByAccount } from '../src/session.ts'

const hydrogen = 'gemini-4-hydrogen'
const request = (model: string, effort?: string, maxTokens?: number): GenerateOptions => ({
  provider: 'agy', model, ...(effort ? { reasoningEffort: effort } : {}),
  ...(maxTokens === undefined ? {} : { maxTokens }),
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
}) as GenerateOptions
const models = (base: string, sizes: Record<string, number>) => ({
  models: Object.fromEntries(Object.entries(sizes).map(([effort, maxTokens]) => [`${base}-${effort}`, { maxTokens }])),
})
const ok = (data: unknown) => vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })) as unknown as typeof fetch
const unavailable = vi.fn(async () => { throw new Error('synthetic discovery failure') }) as unknown as typeof fetch

afterEach(() => { resetDiscoveredTieredModels(); vi.unstubAllGlobals() })

describe('Codex review feedback regressions', () => {
  it('drops Claude budgets that lack a larger output cap or violate the floor', () => {
    mergeModelCatalog(models('claude-opus-5-5', { medium: 1048576, high: 1048576 }))
    for (const [budget, cap] of [[4096, 2048], [2048, 2048], [4096, undefined], [1000, 4096]] as const) {
      const body = toAgyRequestBody(request('claude-opus-5-5-medium', 'high', cap), { claudeBudgetFor: () => budget })
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
    }
    const valid = toAgyRequestBody(request('claude-opus-5-5-medium', 'high', 4096), { claudeBudgetFor: () => 1024 })
    expect(valid.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true })
  })

  it('guards default and Claude-specific budgets without limiting Gemini', () => {
    mergeModelCatalog(models('claude-opus-5-5', { medium: 1048576, high: 1048576 }))
    const defaultBudget = toAgyRequestBody(request('claude-opus-5-5-medium', undefined, 2048), { claudeBudgetFor: () => 4096 })
    expect(defaultBudget.request.generationConfig?.thinkingConfig).toBeUndefined()
    const claudeBudget = toAgyRequestBody(request('claude-opus-5-5-medium', 'high', 4096), { claudeBudgetFor: () => 1024 })
    expect(claudeBudget.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 1024, includeThoughts: true })
    mergeModelCatalog(models(hydrogen, { medium: 1048576, high: 1048576 }))
    const gemini = toAgyRequestBody(request(hydrogen, 'high', 2048), { thinkingBudgetFor: () => 4096 })
    expect(gemini.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 4096, includeThoughts: true })
  })

  it('preserves Claude special budgets for synthetic and concrete model selections', () => {
    const base = 'claude-opus-5-5'
    mergeModelCatalog(models(base, { medium: 1048576, high: 1048576 }))
    for (const model of [base, `${base}-medium`]) {
      for (const effort of [undefined, 'high']) {
        for (const budget of [-1, 0, 1024, 63999]) {
          const body = toAgyRequestBody(request(model, effort, 64000), { claudeBudgetFor: () => budget })
          expect(body.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: budget, includeThoughts: true })
        }
      }
    }
  })

  it('does not apply Gemini budget settings to Claude, whether or not Claude has a budget', () => {
    const base = 'claude-opus-5-5'
    mergeModelCatalog(models(base, { medium: 1048576, high: 1048576 }))
    for (const model of [base, `${base}-medium`]) {
      for (const effort of [undefined, 'high']) {
        const unrelated = { tieredBudgetFor: () => 4096, thinkingBudgetFor: () => 8192 }
        const configured = toAgyRequestBody(request(model, effort, 64000), { ...unrelated, claudeBudgetFor: () => 0 })
        expect(configured.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: true })
        const unset = toAgyRequestBody(request(model, effort, 64000), unrelated)
        expect(unset.request.generationConfig?.thinkingConfig).toBeUndefined()
      }
    }
    mergeModelCatalog(models(hydrogen, { medium: 1048576, high: 1048576 }))
    const geminiConfig = { tieredBudgetFor: () => 4096, thinkingBudgetFor: () => 8192, claudeBudgetFor: () => 0 }
    expect(toAgyRequestBody(request(hydrogen, undefined, 64000), geminiConfig).request.generationConfig?.thinkingConfig)
      .toEqual({ thinkingBudget: 4096, includeThoughts: true })
    expect(toAgyRequestBody(request(hydrogen, 'high', 64000), geminiConfig).request.generationConfig?.thinkingConfig)
      .toEqual({ thinkingBudget: 8192, includeThoughts: true })
  })

  it('passes Claude budgets through the adapter without borrowing Gemini settings', async () => {
    const base = 'claude-opus-5-5'
    mergeModelCatalog(models(base, { medium: 1048576, high: 1048576 }))
    const selections: Array<{ model?: string; exact?: boolean }> = []
    const adapter = new AgyAdapter({
      getSession: async (model, _conversation, exact) => {
        selections.push({ model, exact })
        return {
          auth: { access: 'synthetic-token', refresh: 'synthetic-refresh', expires: Date.now() + 60_000 },
          account: { refresh: 'synthetic-refresh', projectId: 'synthetic-project', addedAt: 0, lastUsed: 0 }, index: 0,
          impersonation: { 'User-Agent': 'test', 'X-Goog-Api-Client': 'test', clientMetadata: {} },
        }
      },
      reportFailure: async () => {},
      claudeBudgetFor: () => 0,
      tieredBudgetFor: () => 4096,
      thinkingBudgetFor: () => 8192,
    })
    let body: { model: string; request: { generationConfig?: { thinkingConfig?: unknown } } } | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return new Response('data: [DONE]\n\n', { status: 200 })
    }))
    for await (const _chunk of adapter.stream(request(`${base}-medium`, 'high', 64000))) void _chunk
    expect(selections).toEqual([{ model: `${base}-high`, exact: true }])
    expect(body?.model).toBe(`${base}-high`)
    expect(body?.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: true })
  })

  it('uses the same validator for existing id-bound Claude models', () => {
    for (const budget of [-1, 0, 1024, 63999]) {
      const body = toAgyRequestBody(request('claude-opus-4-6-thinking', undefined, 64000), { claudeBudgetFor: () => budget })
      expect(body.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: budget, includeThoughts: true })
    }
    for (const budget of [-2, 1, 512, 1023, 1024.5, 64000]) {
      const body = toAgyRequestBody(request('claude-opus-4-6-thinking', undefined, 64000), { claudeBudgetFor: () => budget })
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
    }
  })

  it('rejects invalid Claude values and special budgets without a sufficient output cap', () => {
    const base = 'claude-opus-5-5'
    mergeModelCatalog(models(base, { medium: 1048576, high: 1048576 }))
    for (const budget of [-2, 1, 512, 1023, 1024.5, 64000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const body = toAgyRequestBody(request(base, undefined, 64000), { claudeBudgetFor: () => budget })
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
    }
    for (const budget of [-1, 0, 1024]) {
      const body = toAgyRequestBody(request(base, undefined, undefined), { claudeBudgetFor: () => budget })
      expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
    }
    const equal = toAgyRequestBody(request(base, undefined, 1024), { claudeBudgetFor: () => 1024 })
    expect(equal.request.generationConfig?.thinkingConfig).toBeUndefined()
    expect(equal.request.generationConfig?.maxOutputTokens).toBe(1024)
  })

  it('keeps explicit off and session-title paths independent of saved Claude budgets', () => {
    const base = 'claude-opus-5-5'
    mergeModelCatalog(models(base, { medium: 1048576, high: 1048576 }))
    const context = { claudeBudgetFor: () => -1, tieredBudgetFor: () => 4096, thinkingBudgetFor: () => 8192 }
    for (const effort of ['none', 'off']) {
      expect(toAgyRequestBody(request(base, effort, 64000), context).request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    }
    const title = { ...request(base, 'high', 64000), purpose: 'session-title' } as GenerateOptions
    expect(toAgyRequestBody(title, context).request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
  })

  it('retains the same account’s last successful discovery when fetching fails', async () => {
    const cache = new ModelDiscoveryCache()
    vi.stubGlobal('fetch', unavailable)
    const first = await listAgyModels('token-a', 'project', ok(models(hydrogen, { low: 80000, high: 160000 })), { cache })
    expect(first.some((item) => item.id === hydrogen)).toBe(true)
    const fallback = await listAgyModels('token-a', 'project', unavailable, { cache })
    expect(fallback.some((item) => item.id === hydrogen)).toBe(true)
    expect(resolveWireModel(hydrogen, 'high')).toBe(`${hydrogen}-high`)
    expect(resolveAgyModel('agy', hydrogen).context?.contextWindow).toBe(80000)
  })

  it('never serves another account’s cached discovery after a failed fetch', async () => {
    const cache = new ModelDiscoveryCache()
    vi.stubGlobal('fetch', unavailable)
    await listAgyModels('token-a', 'project', ok(models(hydrogen, { low: 80000, high: 160000 })), { cache })
    const other = await listAgyModels('token-b', 'project', unavailable, { cache })
    expect(other.some((item) => item.id === hydrogen)).toBe(false)
    expect(resolveWireModel(hydrogen, 'high')).toBe(hydrogen)
    const firstAgain = await listAgyModels('token-a', 'project', unavailable, { cache })
    expect(firstAgain.some((item) => item.id === hydrogen)).toBe(true)
    expect(resolveWireModel(hydrogen, 'high')).toBe(`${hydrogen}-high`)
  })

  it('reuses an explicit account scope after token refresh but not after scope changes', async () => {
    const cache = new ModelDiscoveryCache()
    vi.stubGlobal('fetch', unavailable)
    await listAgyModels('old-token', 'project', ok(models(hydrogen, { low: 80000, high: 160000 })), { cache, scope: 'opaque-a' })
    const same = await listAgyModels('new-token', 'project', unavailable, { cache, scope: 'opaque-a' })
    expect(same.some((item) => item.id === hydrogen)).toBe(true)
    const changed = await listAgyModels('new-token', 'project', unavailable, { cache, scope: 'opaque-other-egress' })
    expect(changed.some((item) => item.id === hydrogen)).toBe(false)
  })

  it('uses account and project scope in the adapter across token refresh', async () => {
    let refresh = 'fake-account-a', access = 'token-a', project = 'project'
    const proxy: string | undefined = undefined
    let shouldFail = false
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (shouldFail) throw new Error('synthetic discovery failure')
      return new Response(JSON.stringify(models(hydrogen, { low: 80000, high: 160000 })), { status: 200 })
    }))
    const adapter = new AgyAdapter({
      getSession: async () => ({
        auth: { access, refresh, expires: 100 },
        account: { refresh, projectId: project, proxy, addedAt: 0, lastUsed: 0 }, index: 0,
        impersonation: { 'User-Agent': 'test', 'X-Goog-Api-Client': 'test', clientMetadata: {} },
      }),
      reportFailure: async () => {},
    })
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(true)
    access = 'new-token-a'; shouldFail = true
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(true)
    project = 'other-project'
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(false)
    project = 'project'; refresh = 'fake-account-b'; access = 'token-b'
    expect((await adapter.listAllModels(true)).some((item) => item.id === hydrogen)).toBe(false)
    expect(resolveWireModel(hydrogen, 'high')).toBe(hydrogen)
  })

  it('discards an in-flight discovery when account activation changes', async () => {
    let release!: () => void, started!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    let call = 0, refresh = 'fake-account-a'
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (++call === 1) {
        started(); await blocked
        return new Response(JSON.stringify(models(hydrogen, { high: 160000, xhigh: 200000 })), { status: 200 })
      }
      return new Response(JSON.stringify(models(hydrogen, { low: 80000, medium: 120000 })), { status: 200 })
    }))
    const adapter = new AgyAdapter({
      getSession: async () => ({
        auth: { access: 'fake-token', refresh, expires: 100 },
        account: { refresh, projectId: 'project', addedAt: 0, lastUsed: 0 }, index: 0,
        impersonation: { 'User-Agent': 'test', 'X-Goog-Api-Client': 'test', clientMetadata: {} },
      }),
      reportFailure: async () => {},
    })
    const oldRequest = adapter.listAllModels(true)
    await firstStarted
    refresh = 'fake-account-b'; adapter.invalidateModelCache()
    const newRequest = adapter.listAllModels(true)
    release()
    await Promise.all([oldRequest, newRequest])
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((item) => item.id)).toEqual(['low', 'medium'])
    expect(() => resolveWireModel(hydrogen, 'high')).toThrow(/high/i)
  })

  it('forgets a stale snapshot after an authoritative empty response', async () => {
    const cache = new ModelDiscoveryCache()
    vi.stubGlobal('fetch', unavailable)
    await listAgyModels('token-a', 'project', ok(models(hydrogen, { low: 80000, high: 160000 })), { cache })
    const empty = await listAgyModels('token-a', 'project', ok({ models: {} }), { cache })
    expect(empty.some((item) => item.id === hydrogen)).toBe(false)
    const later = await listAgyModels('token-a', 'project', unavailable, { cache })
    expect(later.some((item) => item.id === hydrogen)).toBe(false)
  })

  it('does not retain quota data in cached discovery snapshots', () => {
    const cache = new ModelDiscoveryCache()
    cache.remember('opaque', { models: { 'gemini-test-high': { displayName: 'Test', maxTokens: 1000, quotaInfo: { remainingFraction: 0.4 } } } })
    expect(cache.get('opaque')?.models?.['gemini-test-high']).toEqual({ displayName: 'Test', maxTokens: 1000 })
  })

  it('does not reject a model solely on explicitly expired account capability data', () => {
    const account = { refresh: 'fake', addedAt: 0, lastUsed: 0, cachedModels: [`${hydrogen}-low`], cachedQuota: {}, cachedQuotaUpdatedAt: 1 }
    expect(isModelSupportedByAccount(account, `${hydrogen}-high`, true)).toBe(true)
    expect(isModelSupportedByAccount({ ...account, cachedQuotaUpdatedAt: Date.now() }, `${hydrogen}-high`, true)).toBe(false)
  })

  it('retains family identity when authoritative discovery has one surviving tier', () => {
    mergeModelCatalog(models(hydrogen, { low: 80000, high: 160000 }))
    const fresh = mergeModelCatalog(models(hydrogen, { low: 80000 }))
    expect(fresh.some((item) => item.id === hydrogen)).toBe(true)
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((item) => item.id)).toEqual(['low'])
    expect(resolveWireModel(hydrogen, 'low')).toBe(`${hydrogen}-low`)
    expect(() => resolveWireModel(hydrogen, 'high')).toThrow(/high/i)
  })

  it('uses the minimum family window even for an existing concrete selection', () => {
    mergeModelCatalog(models(hydrogen, { low: 80000, high: 160000 }))
    const chosen = `${hydrogen}-high`
    expect(resolveAgyModel('agy', chosen).context?.contextWindow).toBe(80000)
    expect(resolveAgyModel('agy', chosen).reasoning?.efforts.map((item) => item.id)).toEqual(['low', 'high'])
    expect(resolveWireModel(chosen, 'low')).toBe(`${hydrogen}-low`)
  })

  it('does not overstate dynamic context even when a family has pinned catalog metadata', () => {
    const argon = 'gemini-4-argon'
    const listed = mergeModelCatalog(models(argon, { low: 80000, high: 160000 }))
    expect(listed.find((item) => item.id === argon)?.context?.contextWindow).toBe(80000)
    expect(resolveAgyModel('agy', `${argon}-high`).context?.contextWindow).toBe(80000)
  })
})
