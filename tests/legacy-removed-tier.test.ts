import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { resetDiscoveredTieredModels } from '../src/adapter/catalog.ts'
import { mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { resolveWireModel } from '../src/adapter/translate.ts'

const base = 'gemini-4-hydrogen'
const low = `${base}-low`
const high = `${base}-high`
const discovery = (entries: Record<string, number>) => ({
  models: Object.fromEntries(Object.entries(entries).map(([level, maxTokens]) => [`${base}-${level}`, { maxTokens }])),
})
const request = (effort?: string): GenerateOptions => ({
  provider: 'agy', model: high, ...(effort ? { reasoningEffort: effort } : {}),
  messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
}) as GenerateOptions

afterEach(() => { resetDiscoveredTieredModels(); vi.unstubAllGlobals() })

describe('saved selections after model tiers change', () => {
  it('recognizes the removed concrete tier and only routes to a surviving explicit effort', () => {
    mergeModelCatalog(discovery({ low: 80000, high: 160000 }))
    mergeModelCatalog(discovery({ low: 80000 }))
    const metadata = resolveAgyModel('agy', high)
    expect(metadata.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low'])
    expect(metadata.context?.contextWindow).toBe(80000)
    expect(resolveWireModel(high, 'low')).toBe(low)
    expect(() => resolveWireModel(high, 'high')).toThrow(/high/i)
    expect(() => resolveWireModel(high)).toThrow(/advertis|availab/i)
    expect(() => resolveWireModel(high, 'off')).toThrow(/advertis|availab/i)
    mergeModelCatalog(discovery({ low: 80000, high: 160000 }))
    expect(resolveWireModel(high)).toBe(high)
  })

  it.each([undefined, 'off', 'high'])('rejects an unavailable saved tier before selecting an account (effort %s)', async (effort) => {
    mergeModelCatalog(discovery({ low: 80000, high: 160000 }))
    mergeModelCatalog(discovery({ low: 80000 }))
    const select = vi.fn(async () => { throw new Error('account selection must not run') })
    const adapter = new AgyAdapter({ getSession: select, reportFailure: async () => {} })
    const run = async () => { for await (const _chunk of adapter.stream(request(effort))) void _chunk }
    await expect(run()).rejects.toThrow(/advertis|high/i)
    expect(select).not.toHaveBeenCalled()
  })

  it('passes the surviving wire ID and exact-match requirement to account selection', async () => {
    mergeModelCatalog(discovery({ low: 80000, high: 160000 }))
    mergeModelCatalog(discovery({ low: 80000 }))
    const selections: Array<{ id?: string, exact?: boolean }> = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: [DONE]\n\n', { status: 200 })))
    const adapter = new AgyAdapter({
      getSession: async (id, _conversation, exact) => {
        selections.push({ id, exact })
        return {
          auth: { access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 3600000 },
          account: { refresh: 'synthetic-refresh', projectId: 'project', addedAt: 0, lastUsed: 0 }, index: 0,
          impersonation: { 'User-Agent': 'synthetic', 'X-Goog-Api-Client': 'synthetic', clientMetadata: {} },
        }
      },
      reportFailure: async () => {},
    })
    for await (const _chunk of adapter.stream(request('low'))) void _chunk
    expect(selections).toEqual([{ id: low, exact: true }])
  })
})
