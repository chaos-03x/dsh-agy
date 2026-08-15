import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { toAgyRequestBody } from '../src/adapter/translate.ts'
import { parseAgySse, parseSseDataLine } from '../src/adapter/parse.ts'
import { fetchAvailableModels, listAgyModels, mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import type { AgyAccountSession } from '../src/adapter/adapter.ts'

function textMessage(role: Message['role'], text: string): Message {
  return { id: `m-${Math.random()}`, role, content: [{ type: 'text', text }] } as Message
}

function generateOptions(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'agy',
    model: 'gemini-3.6-flash-high',
    messages: [textMessage('user', 'hello')],
    ...overrides,
  } as GenerateOptions
}

describe('translate', () => {
  it('maps messages to Gemini contents with wrapped envelope', () => {
    const body = toAgyRequestBody(generateOptions(), { projectId: 'proj-1', sessionId: 's1' })
    expect(body.project).toBe('proj-1')
    expect(body.requestId).toMatch(/^agent\/\d+\/[0-9a-f]{8}$/)
    expect(body.model).toBe('gemini-3.6-flash-high')
    expect(body.userAgent).toBe('antigravity')
    expect(body.requestType).toBe('agent')
    expect(body.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
    expect(body.request.sessionId).toBe('s1')
  })

  it('maps reasoning blocks to thought parts and carries them as-is', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'reasoning' as const, text: 'thinking...' },
        { type: 'text' as const, text: 'answer' },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ messages }), {})
    const parts = body.request.contents[0]!.parts
    expect(parts).toEqual([
      { thought: true, text: 'thinking...' },
      { text: 'answer' },
    ])
  })

  it('maps tool calls and results with name resolution', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'tool-call' as const, id: 'call-1', name: 'web_search', arguments: '{"q":"x"}' },
      ]},
      { id: 'b', role: 'user' as const, content: [
        { type: 'tool-result' as const, toolCallId: 'call-1', content: [{ type: 'text' as const, text: 'result!' }] },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ messages }), {})
    expect(body.request.contents[0]!.parts).toEqual([
      { thoughtSignature: 'skip_thought_signature_validator', functionCall: { id: 'call-1', name: 'web_search', args: { q: 'x' } } },
    ])
    expect(body.request.contents[1]!.parts).toEqual([
      { functionResponse: { name: 'web_search', response: { result: 'result!', is_error: false } } },
    ])
  })

  it('maps system, tools, and generation config', () => {
    const body = toAgyRequestBody(
      generateOptions({
        system: 'be helpful',
        tools: [{
          name: 't1',
          description: 'd1',
          parameters: { type: 'object', properties: { x: { type: 'string', enumDescriptions: ['a'] } }, enumDescriptions: ['top'] },
        }],
        temperature: 0.5,
        maxTokens: 1024,
        stop: ['END'],
      }),
      {},
    )
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: 'be helpful' }] })
    expect(body.request.tools).toEqual([{
      functionDeclarations: [{
        name: 't1',
        description: 'd1',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      }],
    }])
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } })
    expect(body.request.generationConfig).toEqual({
      temperature: 0.5,
      maxOutputTokens: 1024,
      stopSequences: ['END'],
    })
  })

  it('keeps only allowlisted keywords in tool schemas (upstream 400)', () => {
    const body = toAgyRequestBody(
      generateOptions({
        tools: [{
          name: 't1',
          description: 'd1',
          parameters: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            $id: 't1',
            type: 'object',
            title: 'T1',
            description: 'd1',
            propertyNames: { pattern: '^[a-z]+$' },
            properties: {
              name: { type: 'string', pattern: '^[a-z]+$', minLength: 1, maxLength: 10, enumDescriptions: ['a'] },
              count: { type: 'integer', minimum: 0, maximum: 100 },
              tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, uniqueItems: true },
              mode: { type: 'string', enum: ['fast', 'slow'], enumDescriptions: ['f', 's'] },
            },
            required: ['name'],
            additionalProperties: false,
            minProperties: 1,
          },
        }],
      }),
      {},
    )
    expect(body.request.tools).toEqual([{
      functionDeclarations: [{
        name: 't1',
        description: 'd1',
        parameters: {
          type: 'object',
          title: 'T1',
          description: 'd1',
          properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string' } },
            mode: { type: 'string', enum: ['fast', 'slow'] },
          },
          required: ['name'],
          additionalProperties: false,
        },
      }],
    }])
  })

  it('falls back to empty args object when tool-call arguments are malformed', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'tool-call' as const, id: 'call-1', name: 'web_search', arguments: '{"localPath":"/home/user/' },
        { type: 'tool-call' as const, id: 'call-2', name: 'read_file', arguments: { path: '/x' } },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ messages }), {})
    const parts = body.request.contents[0]!.parts
    expect(parts).toEqual([
      { thoughtSignature: 'skip_thought_signature_validator', functionCall: { id: 'call-1', name: 'web_search', args: {} } },
      { thoughtSignature: 'skip_thought_signature_validator', functionCall: { id: 'call-2', name: 'read_file', args: { path: '/x' } } },
    ])
  })

  it('strips trailing model turns for Claude models only', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'answer' }] },
      { id: 'b', role: 'user' as const, content: [{ type: 'text' as const, text: 'next' }] },
      { id: 'c', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'trailing' }] },
    ]
    const claude = toAgyRequestBody(generateOptions({ model: 'claude-opus-4-6-thinking', messages }), {})
    expect(claude.request.contents.map((c) => c.role)).toEqual(['model', 'user'])
    const gemini = toAgyRequestBody(generateOptions({ model: 'gemini-2.5-flash', messages }), {})
    expect(gemini.request.contents.map((c) => c.role)).toEqual(['model', 'user', 'model'])
  })
})

describe('parseSseDataLine', () => {
  it('parses array-wrapped payloads and skips non-data lines', () => {
    const payload = parseSseDataLine('data: [{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}]')
    expect(payload?.candidates?.[0]?.content?.parts?.[0]?.text).toBe('hi')
    expect(parseSseDataLine('data: [DONE]')).toBeNull()
    expect(parseSseDataLine('event: ping')).toBeNull()
  })

  it('parses the {response:{...}} envelope shape (daily endpoint)', () => {
    const payload = parseSseDataLine('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"thoughtSignature":"sig","text":""}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":6,"totalTokenCount":35}}}')
    expect(payload?.candidates?.[0]?.content?.parts?.[0]?.thoughtSignature).toBe('sig')
    expect(payload?.candidates?.[0]?.finishReason).toBe('MAX_TOKENS')
    expect(payload?.usageMetadata?.totalTokenCount).toBe(35)
  })
})

function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const text = lines.join('\n') + '\n'
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

async function collect(chunks: AsyncIterable<Awaited<ReturnType<typeof parseAgySse>>>) {
  const out: unknown[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('parseAgySse', () => {
  it('emits text through the {response:{...}} envelope', async () => {
    const chunks = await collect(parseAgySse(sseStream([
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Hel"},{"text":"lo"}]}}]}}',
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"!"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"cachedContentTokenCount":2}}}',
      'data: [DONE]',
    ])))
    const texts = chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(texts).toEqual(['Hel', 'lo', '!'])
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
  })

  it('keeps one continuous text block across events (usage does not split)', async () => {
    // Antigravity sends usageMetadata on EVERY SSE event; per-event block
    // closing used to split one sentence into a block per chunk.
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"Hel"},{"text":"lo"}]}}]}]',
      'data: [{"candidates":[{"content":{"parts":[{"text":"!"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"cachedContentTokenCount":2}}]',
      'data: [{"candidates":[{"content":{"parts":[{"text":" next"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":6,"cachedContentTokenCount":2}}]',
      'data: [DONE]',
    ])))
    const starts = chunks.filter((c) => (c as { type: string }).type === 'block-start')
    const ends = chunks.filter((c) => (c as { type: string }).type === 'block-end')
    expect(starts).toHaveLength(1) // one text block for the whole stream
    expect(ends).toHaveLength(1)
    const deltas = chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text)
    expect(deltas.join('')).toBe('Hello! next')
    // usage emitted once, at the end, with the final totals; inputTokens is
    // the UNcached portion (disjoint buckets: prompt 10 - cached 2 = 8)
    const usages = chunks.filter((c) => (c as { type: string }).type === 'usage')
    expect(usages).toHaveLength(1)
    expect(usages[0]).toMatchObject({ usage: { inputTokens: 8, outputTokens: 6, cacheReadTokens: 2 } })
    const finish = chunks[chunks.length - 1]
    expect(finish).toMatchObject({ type: 'finish' })
  })

  it('emits reasoning deltas for thought parts', async () => {
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"thought":true,"text":"hmm"}]}}]}]',
      'data: [DONE]',
    ])))
    expect(chunks[0]).toMatchObject({ type: 'block-start', blockType: 'reasoning' })
    expect(chunks[1]).toMatchObject({ type: 'reasoning-delta', text: 'hmm' })
  })

  it('emits tool-call blocks with accumulated arguments', async () => {
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"name":"web_search","args":{"q":"x"}}}]}}]}]',
      'data: [DONE]',
    ])))
    expect(chunks[0]).toMatchObject({ type: 'block-start', blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', name: 'web_search' })
    expect(chunks[2]).toMatchObject({ type: 'block-end', block: { type: 'tool-call', name: 'web_search', arguments: '{"q":"x"}' } })
  })

  it('captures functionCall thoughtSignature and upstream id via callback', async () => {
    const captured: Array<[string, string]> = []
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-abc","functionCall":{"id":"fc-1","name":"web_search","args":{"q":"x"}}}]}}]}]',
      'data: [DONE]',
    ]), { onToolSignature: (id, sig) => captured.push([id, sig]) }))
    expect(captured).toEqual([['fc-1', 'sig-abc']])
    // block id uses the upstream id
    const end = chunks.find((c) => (c as { type: string }).type === 'block-end')
    expect(end).toMatchObject({ block: { type: 'tool-call', id: 'fc-1' } })
  })

  it('replays a cached signature on the next turn instead of the sentinel', async () => {
    const { setThoughtSignature } = await import('../src/runtime/signature-cache.ts')
    const { toAgyRequestBody } = await import('../src/adapter/translate.ts')
    setThoughtSignature('call-1', 'sig-from-previous-turn')
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'tool-call' as const, id: 'call-1', name: 'web_search', arguments: '{"q":"x"}' },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ messages }), {})
    expect(body.request.contents[0]!.parts).toEqual([
      { thoughtSignature: 'sig-from-previous-turn', functionCall: { id: 'call-1', name: 'web_search', args: { q: 'x' } } },
    ])
  })

  it('throws on in-band stream errors', async () => {
    await expect(async () => {
      const chunks = parseAgySse(sseStream([
        'data: [{"error":{"code":8,"status":"RESOURCE_EXHAUSTED","message":"quota"}}]',
      ]))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/quota/)
  })
})

describe('models', () => {
  it('merges dynamic ids with catalog metadata and filters tab models', () => {
    const merged = mergeModelCatalog({
      models: {
        'gemini-3.6-flash-high': { displayName: 'Gemini 3.6 Flash (High)' },
        'tab_flash_lite_preview': { displayName: 'Tab Flash' },
        'some-new-model': { displayName: 'New' },
      },
    })
    const ids = merged.map((m) => m.id)
    expect(ids).toContain('gemini-3.6-flash-high')
    expect(ids).not.toContain('tab_flash_lite_preview')
    expect(merged.find((m) => m.id === 'gemini-3.6-flash-high')?.context?.contextWindow).toBe(1048576)
    expect(merged.find((m) => m.id === 'some-new-model')?.name).toBe('New')
  })

  it('falls back to catalog when the endpoint fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const models = await listAgyModels('at', 'p', fetchImpl)
    expect(models.length).toBeGreaterThan(0)
  })

  it('resolves exact-model metadata from the catalog', () => {
    const resolved = resolveAgyModel('agy', 'claude-opus-4-6-thinking')
    expect(resolved.name).toContain('Claude Opus')
    expect(resolved.defaultMaxTokens).toBe(65536)
    const unknown = resolveAgyModel('agy', 'brand-new-model')
    expect(unknown.name).toBe('brand-new-model')
    expect(unknown.defaultMaxTokens).toBeUndefined()
  })
})

describe('AgyAdapter', () => {
  afterEach(() => vi.unstubAllGlobals())

  function session(overrides: Partial<AgyAccountSession> = {}): AgyAccountSession {
    return {
      auth: { access: 'at', expires: Date.now() + 3600_000, refresh: 'rt|p' },
      account: { email: 'a@b.c', refresh: 'rt|p', projectId: 'p', addedAt: 0, lastUsed: 0 },
      index: 0,
      impersonation: {
        'User-Agent': 'antigravity/1.18.3 darwin/arm64',
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'Client-Metadata': '{"ideType":"ANTIGRAVITY","platform":"MACOS","pluginType":"GEMINI"}',
      },
      ...overrides,
    }
  }

  it('throws a guidance error when no account is configured', async () => {
    const adapter = new AgyAdapter({
      getSession: async () => undefined,
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toThrow(/dsh-agy login/)
  })

  it('streams a response and reports no failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]',
      'data: [DONE]',
    ]), { status: 200 })))
    const failures: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind) => { failures.push(kind) },
    })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(generateOptions())) chunks.push(chunk)
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
    expect(failures).toEqual([])
  })

  it('reports and throws QUOTA (terminal) on daily quota exhaustion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED"}}', { status: 429 })))
    const failures: Array<{ kind: string; session: AgyAccountSession }> = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind, s) => { failures.push({ kind, session: s }) },
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({ code: 'QUOTA' })
    expect(failures[0]?.kind).toBe('rate-limit')
    expect(failures[0]?.session.account.email).toBe('a@b.c')
  })

  it('throws RATE_LIMIT with retry delay on soft/rate limits (harness retries)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({ code: 'RATE_LIMIT', failure: { providerRetryAfterMs: 2000 } })
  })
})
