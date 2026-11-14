import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { resetDiscoveredTieredModels } from '../src/adapter/catalog.ts'
import { mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { resolveWireModel, toAgyRequestBody } from '../src/adapter/translate.ts'
import { isModelSupportedByAccount } from '../src/session.ts'
import type { ManagedAccount } from '../src/types.ts'
import type { ModelVisibility } from '../src/model-visibility.ts'

const hydrogen = 'gemini-4-hydrogen'
const ids = (efforts: string[]) => Object.fromEntries(efforts.map((effort) => [`${hydrogen}-${effort}`, {}]))
const request = (effort?: string) => ({
  provider: 'agy', model: hydrogen, reasoningEffort: effort,
  messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
}) as GenerateOptions

afterEach(() => {
  resetDiscoveredTieredModels()
  vi.unstubAllGlobals()
})

describe('advertised discrete model capabilities', () => {
  it('groups Hydrogen once and maps each advertised effort to its exact wire ID', () => {
    const models = mergeModelCatalog({ models: ids(['low', 'medium', 'high', 'xhigh']) })
    expect(models.map((model) => model.id)).toEqual([hydrogen])
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((level) => level.id))
      .toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(toAgyRequestBody(request('xhigh'), {}).model).toBe(`${hydrogen}-xhigh`)
    expect(toAgyRequestBody(request('xhigh'), {}).request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
    expect(toAgyRequestBody(request('high'), {}).request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('exposes only the tiers this account advertised and refuses a missing tier', () => {
    mergeModelCatalog({ models: ids(['low', 'high']) })
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((level) => level.id)).toEqual(['low', 'high'])
    expect(resolveWireModel(hydrogen)).toBe(`${hydrogen}-low`)
    expect(resolveWireModel(hydrogen, 'high')).toBe(`${hydrogen}-high`)
    expect(() => resolveWireModel(hydrogen, 'medium')).toThrow(/medium/i)
  })

  it('keeps Max and Extra High distinct when both are advertised', () => {
    mergeModelCatalog({ models: ids(['xhigh', 'max']) })
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((level) => level.id)).toEqual(['xhigh', 'max'])
    expect(resolveWireModel(hydrogen, 'xhigh')).toBe(`${hydrogen}-xhigh`)
    expect(resolveWireModel(hydrogen, 'max')).toBe(`${hydrogen}-max`)
  })

  it('does not create synthetic chat models from image-only variants', () => {
    const imageIds = ['gemini-image-low', 'gemini-image-high']
    const models = mergeModelCatalog({
      models: Object.fromEntries(imageIds.map((id) => [id, {}])),
      imageGenerationModelIds: imageIds,
    })
    expect(models).toEqual([])
  })

  it('does not hide an extra discrete tier when a native tiered route cannot select it', () => {
    const base = 'gemini-3.8-flash'
    const models = mergeModelCatalog({ models: {
      [`${base}-tiered`]: {}, [`${base}-low`]: {}, [`${base}-high`]: {}, [`${base}-xhigh`]: {},
    } })
    expect(models.map((model) => model.id).sort()).toEqual([`${base}-tiered`, `${base}-xhigh`].sort())
  })

  it('selects a visible default without breaking explicit legacy selections', () => {
    mergeModelCatalog({ models: ids(['low', 'medium', 'high']) })
    const hidden = new Set([`${hydrogen}-medium`])
    expect(resolveWireModel(hydrogen, undefined, hidden)).toBe(`${hydrogen}-low`)
    expect(resolveWireModel(hydrogen, 'medium', hidden)).toBe(`${hydrogen}-medium`)
  })

  it('replaces per-account discovered tiers rather than retaining a previous account', () => {
    mergeModelCatalog({ models: ids(['low', 'xhigh']) })
    mergeModelCatalog({ models: ids(['medium', 'high']) })
    expect(resolveAgyModel('agy', hydrogen).reasoning?.efforts.map((level) => level.id)).toEqual(['medium', 'high'])
    expect(() => resolveWireModel(hydrogen, 'xhigh')).toThrow(/xhigh/i)
  })

  it('keeps the selected request id-bound if discovery changes while selecting an account', () => {
    mergeModelCatalog({ models: ids(['low', 'high']) })
    const wireModel = resolveWireModel(hydrogen, 'high')
    // A subsequent account can advertise the same base as a native tiered ID.
    mergeModelCatalog({ models: { [hydrogen]: {} }, tieredModelIds: { flash: [hydrogen] } })
    const body = toAgyRequestBody(request('high'), { wireModel })
    expect(body.model).toBe(`${hydrogen}-high`)
    expect(body.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('preserves existing per-variant visibility choices after grouping', async () => {
    mergeModelCatalog({ models: ids(['low', 'medium', 'xhigh']) })
    const hidden = new Set([`${hydrogen}-xhigh`])
    const adapter = new AgyAdapter({
      getSession: async () => undefined,
      reportFailure: async () => {},
      modelVisibility: { disabledFor: () => hidden } as unknown as ModelVisibility,
    })
    expect((await adapter.resolveModel('agy', hydrogen)).reasoning?.efforts.map((level) => level.id)).toEqual(['low', 'medium'])
  })

  it('uses the concrete selected tier for account eligibility and dispatch', async () => {
    mergeModelCatalog({ models: ids(['low', 'high', 'xhigh']) })
    const base: ManagedAccount = { refresh: 'r', addedAt: 0, lastUsed: 0 }
    expect(isModelSupportedByAccount({ ...base, cachedModels: [`${hydrogen}-low`] }, `${hydrogen}-xhigh`, true)).toBe(false)
    expect(isModelSupportedByAccount({ ...base, cachedModels: [`${hydrogen}-xhigh`] }, `${hydrogen}-xhigh`, true)).toBe(true)
    expect(isModelSupportedByAccount(base, `${hydrogen}-xhigh`, true)).toBe(true) // unprobed remains optimistic
    const picked: Array<{ model?: string; exact?: boolean }> = []
    const adapter = new AgyAdapter({
      getSession: async (model, _conversation, exact) => {
        picked.push({ model, exact })
        // Another discovery can replace the global catalog during selection.
        mergeModelCatalog({ models: { 'gemini-2.5-flash': {} } })
        return {
          auth: { access: 'at', expires: Date.now() + 60_000, refresh: 'r|p' },
          account: { ...base, projectId: 'p' }, index: 0,
          impersonation: { 'User-Agent': 'test', 'X-Goog-Api-Client': 'test', clientMetadata: {} },
        }
      },
      reportFailure: async () => {},
    })
    let sentModel: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentModel = JSON.parse(String(init?.body)).model
      return new Response('data: [DONE]\n\n', { status: 200 })
    }))
    for await (const _chunk of adapter.stream(request('xhigh'))) void _chunk
    expect(picked).toEqual([{ model: `${hydrogen}-xhigh`, exact: true }])
    expect(sentModel).toBe(`${hydrogen}-xhigh`)
  })
})
