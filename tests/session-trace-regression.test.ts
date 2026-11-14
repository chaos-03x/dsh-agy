import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import { resetDiscoveredTieredModels } from '../src/adapter/catalog.ts'
import { mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { parseAgySse } from '../src/adapter/parse.ts'
import { resolveWireModel, toAgyRequestBody } from '../src/adapter/translate.ts'

const family = 'gemini-4-hydrogen'
const variants = (maxTokens: number) => Object.fromEntries(['low', 'medium', 'high', 'xhigh'].map(
  (level) => [`${family}-${level}`, { maxTokens }],
))
const sse = (lines: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n'))
    controller.close()
  },
})
const collect = async (stream: AsyncIterable<unknown>) => {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  resetDiscoveredTieredModels()
  vi.unstubAllGlobals()
})

describe('real session trace regressions', () => {
  it('propagates the discovered context window to the group and existing concrete sessions', () => {
    const list = mergeModelCatalog({ models: variants(123456) })
    expect(list.find((model) => model.id === family)?.context?.contextWindow).toBe(123456)
    expect(resolveAgyModel('agy', family).context?.contextWindow).toBe(123456)
    expect(resolveAgyModel('agy', `${family}-medium`).context?.contextWindow).toBe(123456)
  })

  it('does not overstate the grouped window when variants advertise different sizes', () => {
    const list = mergeModelCatalog({ models: {
      [`${family}-low`]: { maxTokens: 80000 },
      [`${family}-high`]: { maxTokens: 160000 },
    } })
    expect(list.find((model) => model.id === family)?.context?.contextWindow).toBe(80000)
    expect(resolveAgyModel('agy', family).context?.contextWindow).toBe(80000)
    expect(resolveAgyModel('agy', `${family}-high`).context?.contextWindow).toBe(80000)
  })

  it('does not invent a context window when an unknown family does not report one', () => {
    mergeModelCatalog({ models: {
      [`${family}-low`]: { maxTokens: 80000 },
      [`${family}-high`]: { maxTokens: -1 },
    } })
    expect(resolveAgyModel('agy', family).context).toBeUndefined()
    expect(resolveAgyModel('agy', `${family}-high`).context).toBeUndefined()
    expect(resolveAgyModel('agy', `${family}-low`).context).toBeUndefined()
  })

  it('passes the old model route and context through DSH prepareCall', async () => {
    mergeModelCatalog({ models: variants(123456) })
    const adapter = new AgyAdapter({ getSession: async () => undefined, reportFailure: async () => {} })
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    try {
      ctx.llm.registerAdapter(['agy'], adapter)
      const prepared = await ctx.llm.prepareCall({ provider: 'agy', model: `${family}-medium`, reasoningEffort: 'high' })
      expect(prepared.context?.contextWindow).toBe(123456)
      expect(prepared.config.reasoningEffort).toBe('high')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refreshes dynamic context metadata on account change rather than reusing stale sizes', () => {
    mergeModelCatalog({ models: variants(123456) })
    mergeModelCatalog({ models: variants(65432) })
    expect(resolveAgyModel('agy', family).context?.contextWindow).toBe(65432)
    expect(resolveAgyModel('agy', `${family}-medium`).context?.contextWindow).toBe(65432)
  })

  it('keeps existing concrete model selections and honors a saved explicit effort', () => {
    mergeModelCatalog({ models: variants(1048576) })
    expect(resolveAgyModel('agy', `${family}-medium`).reasoning?.efforts.map((effort) => effort.id))
      .toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(resolveWireModel(`${family}-medium`)).toBe(`${family}-medium`)
    expect(resolveWireModel(`${family}-medium`, 'high')).toBe(`${family}-high`)
    expect(resolveWireModel(`${family}-medium`, 'xhigh')).toBe(`${family}-xhigh`)
    expect(() => resolveWireModel(`${family}-medium`, 'max')).toThrow(/max/i)
  })

  it('dispatches the saved concrete route and effort to an exact-capability account', async () => {
    mergeModelCatalog({ models: variants(1048576) })
    let picked: unknown
    let wireModel: unknown
    const adapter = new AgyAdapter({
      getSession: async (model, _conversation, exact) => {
        picked = { model, exact }
        return {
          auth: { access: 'at', expires: Date.now() + 60_000, refresh: 'r|p' },
          account: { refresh: 'r', addedAt: 0, lastUsed: 0, projectId: 'p' }, index: 0,
          impersonation: { 'User-Agent': 'test', 'X-Goog-Api-Client': 'test', clientMetadata: {} },
        }
      },
      reportFailure: async () => {},
    })
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      wireModel = JSON.parse(String(init?.body)).model
      return new Response('data: [DONE]\n\n', { status: 200 })
    }))
    await collect(adapter.stream({
      provider: 'agy', model: `${family}-medium`, reasoningEffort: 'high',
      messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    }))
    expect(picked).toEqual({ model: `${family}-high`, exact: true })
    expect(wireModel).toBe(`${family}-high`)
  })

  it('requests real Gemini thought parts for discrete thinking models', () => {
    mergeModelCatalog({ models: variants(1048576) })
    const options = {
      provider: 'agy', model: family,
      messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    } as const
    for (const reasoningEffort of [undefined, 'high', 'xhigh']) {
      const body = toAgyRequestBody({ ...options, reasoningEffort }, {})
      expect(body.request.generationConfig?.thinkingConfig).toEqual({ includeThoughts: true })
    }
    const title = toAgyRequestBody({ ...options, purpose: 'session-title' }, {})
    expect(title.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    const off = toAgyRequestBody({ ...options, reasoningEffort: 'off' }, {})
    expect(off.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    const claude = toAgyRequestBody({ ...options, model: 'claude-opus-5-5', reasoningEffort: 'high' }, {})
    expect(claude.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('reports provider thought tokens as part of output usage', async () => {
    const chunks = await collect(parseAgySse(sse([
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":60,"candidatesTokenCount":7,"thoughtsTokenCount":1500,"totalTokenCount":1607}}}',
    ])))
    expect(chunks).toContainEqual({ type: 'usage', usage: {
      inputTokens: 40, cacheReadTokens: 60, outputTokens: 1507, reasoningTokens: 1500, totalTokens: 1607,
    } })
  })

  it('rejects malformed or inconsistent provider usage counters', async () => {
    const chunks = await collect(parseAgySse(sse([
      'data: {"response":{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":50,"candidatesTokenCount":7,"thoughtsTokenCount":-1,"totalTokenCount":3}}}',
    ])))
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 10, outputTokens: 7 } })
  })

  it('forwards host web_search and image tools as callable function declarations', () => {
    const body = toAgyRequestBody({
      provider: 'agy', model: family,
      messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      tools: [
        { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } }, required: ['queries'] } },
        { name: 'codex_image_generate', description: 'Generate an image', parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
      ],
    }, {})
    expect(body.request.tools?.[0]?.functionDeclarations.map((tool) => tool.name))
      .toEqual(['web_search', 'codex_image_generate'])
  })

  it('emits a tool-calls finish for a completed function call followed by upstream STOP', async () => {
    const chunks = await collect(parseAgySse(sse([
      'data: {"response":{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"read","args":{"path":"example"}}}]}}]}}',
      'data: {"response":{"candidates":[{"finishReason":"STOP"}]}}',
    ])))
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }) }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('also reports tool-calls for a completed stream terminated by [DONE]', async () => {
    const chunks = await collect(parseAgySse(sse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{}}}]}}]}',
      'data: [DONE]',
    ])))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('keeps truncation and policy errors rather than overriding them with tool-calls', async () => {
    const part = '{"functionCall":{"name":"read","args":{}}}'
    const truncated = await collect(parseAgySse(sse([
      `data: {"candidates":[{"content":{"parts":[${part}]},"finishReason":"MAX_TOKENS"}]}`,
    ])))
    expect(truncated.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'max-tokens' } })
    await expect(collect(parseAgySse(sse([
      `data: {"candidates":[{"content":{"parts":[${part}]},"finishReason":"SAFETY"}]}`,
    ])))).rejects.toThrow(/SAFETY/)
    await expect(collect(parseAgySse(sse([
      `data: {"candidates":[{"content":{"parts":[${part}]}}]}`,
    ])))).rejects.toThrow(/terminated prematurely/)
  })
})
