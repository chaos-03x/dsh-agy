import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AGY_SCHEMA_ALLOWLIST, toAgyRequestBody } from '../src/adapter/translate.ts'
import { parseAgySse, parseSseDataLine } from '../src/adapter/parse.ts'
import { fetchAvailableModels, listAgyModels, mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import type { AgyAccountSession } from '../src/adapter/adapter.ts'
import { AgyAuthError, AgyPoolBlockedError } from '../src/types.ts'
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

  it('normalizes enum and type VALUES to upstream-valid shapes (upstream 400)', () => {
    const body = toAgyRequestBody(
      generateOptions({
        tools: [{
          name: 'mcp__github__issue_write',
          description: 'd1',
          parameters: {
            type: 'object',
            properties: {
              // non-string enum items are rejected (TYPE_STRING) -> filtered, enum omitted
              delete: { type: 'boolean', description: 'x', enum: [true] },
              // numeric enum items are rejected too -> only strings survive
              level: { type: 'integer', enum: [1, 2, 3] },
              // string enum survives untouched
              state: { type: 'string', enum: ['open', 'closed'] },
              // union type arrays are rejected (Unknown name "type") -> first non-null type
              value: { type: ['string', 'number', 'boolean'], description: 'Value to set.' },
              nullableValue: { type: ['null', 'number'], description: 'Nullable number.' },
            },
            required: ['state'],
          },
        }],
      }),
      {},
    )
    const p = body.request.tools![0].functionDeclarations[0].parameters as Record<string, any>
    expect(p.properties.delete).toEqual({ type: 'boolean', description: 'x' })
    expect(p.properties.level).toEqual({ type: 'integer' })
    expect(p.properties.state).toEqual({ type: 'string', enum: ['open', 'closed'] })
    expect(p.properties.value).toEqual({ type: 'string', description: 'Value to set.' })
    expect(p.properties.nullableValue).toEqual({ type: 'number', description: 'Nullable number.' })
    expect(p.required).toEqual(['state'])
  })

  /**
   * Recursively assert a sanitized tool schema satisfies the upstream protobuf
   * contract (docs/ANTIGRAVITY-API.md §3.1): only allowlisted keywords, and each
   * keyword value shaped like the proto field it maps to. This is the
   * whack-a-mole guard: any future unknown key or invalid value shape fails CI
   * here, before a user hits upstream.
   */
  function assertUpstreamContract(schema: unknown, path = 'parameters'): void {
    expect(schema, `${path}: expected object`).toBeTypeOf('object')
    expect(Array.isArray(schema), `${path}: expected object, got array`).toBe(false)
    const node = schema as Record<string, unknown>
    for (const key of Object.keys(node)) {
      expect(AGY_SCHEMA_ALLOWLIST.has(key), `${path}.${key}: unknown keyword`).toBe(true)
    }
    if ('type' in node) expect(typeof node.type, `${path}.type`).toBe('string')
    if ('enum' in node) {
      const items = node.enum as unknown[]
      expect(Array.isArray(items), `${path}.enum: expected array`).toBe(true)
      expect(items.length, `${path}.enum: empty enum is rejected upstream`).toBeGreaterThan(0)
      for (const item of items) expect(typeof item, `${path}.enum item`).toBe('string')
    }
    if ('required' in node) {
      for (const item of node.required as unknown[]) expect(typeof item, `${path}.required item`).toBe('string')
    }
    if ('nullable' in node) expect(typeof node.nullable, `${path}.nullable`).toBe('boolean')
    for (const scalar of ['format', 'title', 'description']) {
      if (scalar in node) expect(typeof node[scalar], `${path}.${scalar}`).toBe('string')
    }
    if ('properties' in node) {
      for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) {
        assertUpstreamContract(child, `${path}.properties.${name}`)
      }
    }
    for (const nested of ['items']) {
      if (nested in node) assertUpstreamContract(node[nested], `${path}.${nested}`)
    }
    // additionalProperties accepts a boolean (false = no extra keys) or a
    // nested schema — live-verified accepted by the Antigravity upstream.
    if ('additionalProperties' in node) {
      const ap = node.additionalProperties
      if (typeof ap === 'object' && ap !== null) assertUpstreamContract(ap, `${path}.additionalProperties`)
      else expect(typeof ap, `${path}.additionalProperties`).toBe('boolean')
    }
  }

  // Real-world corpus: trimmed from GitHub MCP server `issue_write` — the #4
  // trigger (boolean enum + union type). Hand-written tests only cover known
  // shapes; real MCP schemas surface unknown ones.
  const REAL_WORLD_TOOL_SCHEMAS = [{
    name: 'mcp__github__issue_write',
    description: 'Create or update a GitHub issue',
    parameters: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        issue_fields: {
          type: 'array',
          description: 'Fields to set on the issue',
          items: {
            type: 'object',
            properties: {
              delete: { type: 'boolean', description: 'Set to true to clear this field', enum: [true] },
              field: { type: 'string', enum: ['body', 'assignees', 'milestone'] },
              value: { type: ['string', 'number', 'boolean'], description: 'Value to set.' },
            },
          },
        },
      },
      required: ['owner', 'repo', 'title'],
    },
  }, {
    name: 'mcp__context7__query_docs',
    description: 'Query library documentation',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query', minLength: 1, maxLength: 500, pattern: '.*' },
        library: { type: 'string', description: 'Library id', enum: ['/vercel/next.js', '/facebook/react'] },
        maxResults: { type: 'integer', description: 'Max results', minimum: 1, maximum: 5, default: 3 },
      },
      required: ['query'],
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    },
  }]

  it('sanitized output of a real-world tool corpus satisfies the upstream contract', () => {
    for (const tool of REAL_WORLD_TOOL_SCHEMAS) {
      const body = toAgyRequestBody(generateOptions({ tools: [tool] }), {})
      assertUpstreamContract(body.request.tools![0].functionDeclarations[0].parameters)
    }
  })

  it('sanitizes tool names to the upstream charset and dedupes', () => {
    const body = toAgyRequestBody(
      generateOptions({
        tools: [
          { name: 'mcp__github__issue_write', description: 'd', parameters: { type: 'object', properties: {} } },
          // illegal chars -> underscores; overlong -> hashed tail
          { name: 'my tool.with/slashes!', description: 'd', parameters: { type: 'object', properties: {} } },
          { name: 'x'.repeat(120), description: 'd', parameters: { type: 'object', properties: {} } },
        ],
      }),
      {},
    )
    const names = body.request.tools![0].functionDeclarations.map((t) => t.name)
    expect(names[0]).toBe('mcp__github__issue_write')
    expect(names[1]).toMatch(/^my_tool_with_slashes_$/)
    expect(names[2]!.length).toBeLessThanOrEqual(64)
    expect(new Set(names).size).toBe(names.length)
  })

  it('excludes builtin Gemini tool names from functionDeclarations', () => {
    const body = toAgyRequestBody(
      generateOptions({
        tools: [
          { name: 'web_search', description: 'd', parameters: { type: 'object', properties: {} } },
          { name: 'google_search', description: 'd', parameters: { type: 'object', properties: {} } },
          { name: 'mcp__github__issue_write', description: 'd', parameters: { type: 'object', properties: {} } },
        ],
      }),
      {},
    )
    const names = body.request.tools![0].functionDeclarations.map((t) => t.name)
    expect(names).toEqual(['mcp__github__issue_write'])
  })

  it('returns no tools block when all tools are builtin or sanitized away', () => {
    const body = toAgyRequestBody(
      generateOptions({ tools: [{ name: 'web_search', description: 'd', parameters: { type: 'object' } }] }),
      {},
    )
    expect(body.request.tools).toBeUndefined()
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

  it('isolates consecutive functionCall parts into separate atomic blocks', async () => {
    // Multi-tool turns: two functionCall parts in one event must become two
    // independent blocks — concatenated args JSON would fail DSH validation
    // with "arguments" must be an object.
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"edit_file","args":{"path":"/a"}}},{"functionCall":{"id":"c2","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
      'data: [DONE]',
    ])))
    const toolCalls = chunks.filter((c) => (c as { type: string }).type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
    expect(toolCalls).toHaveLength(2)
    expect(toolCalls[0]).toMatchObject({ block: { type: 'tool-call', id: 'c1', arguments: '{"path":"/a"}' } })
    expect(toolCalls[1]).toMatchObject({ block: { type: 'tool-call', id: 'c2', arguments: '{"cmd":"ls"}' } })
    const starts = chunks.filter((c) => (c as { type: string }).type === 'block-start')
    expect(starts).toHaveLength(2)
    expect((starts[0] as { index: number }).index).not.toBe((starts[1] as { index: number }).index)
  })

  it('yields the text block-end when a functionCall interrupts', async () => {
    // Cross-kind switch must close (and yield the end of) the open text block
    // before opening the tool-call block — dropped block-ends corrupt DSH.
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"thinking"}]}}]}]',
      'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
      'data: [DONE]',
    ])))
    const ends = chunks.filter((c) => (c as { type: string }).type === 'block-end')
    expect(ends).toHaveLength(2)
    expect(ends[0]).toMatchObject({ block: { type: 'text', text: 'thinking' } })
    expect(ends[1]).toMatchObject({ block: { type: 'tool-call', id: 'c1' } })
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
        'Client-Metadata': '{"ideType":"ANTIGRAVITY"}',
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

  it('converts retryable pool blockage into RATE_LIMIT with a positive integer delay', async () => {
    const resetAt = Date.now() + 5000
    const adapter = new AgyAdapter({
      getSession: async () => {
        throw new AgyPoolBlockedError('retryable', resetAt)
      },
      reportFailure: async () => {},
    })

    let thrown: unknown
    try {
      for await (const _ of adapter.stream(generateOptions())) void _
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({
      code: 'RATE_LIMIT',
      failure: { providerRetryAfterMs: expect.any(Number) },
    })
    expect(thrown && typeof thrown === 'object' && 'failure' in thrown).toBe(true)
    if (!thrown || typeof thrown !== 'object' || !('failure' in thrown)) throw new Error('missing failure')
    const failure = thrown.failure
    expect(failure && typeof failure === 'object' && 'providerRetryAfterMs' in failure).toBe(true)
    if (!failure || typeof failure !== 'object' || !('providerRetryAfterMs' in failure)) throw new Error('missing retry delay')
    const retryMs = failure.providerRetryAfterMs
    expect(typeof retryMs).toBe('number')
    if (typeof retryMs !== 'number') throw new Error('retry delay is not numeric')
    expect(Number.isFinite(retryMs)).toBe(true)
    expect(Number.isInteger(retryMs)).toBe(true)
    expect(retryMs).toBeGreaterThan(0)
  })

  it('maps structured auth failures to the matching host error code', async () => {
    const cases = [
      ['transport', 'TRANSPORT'],
      ['rate-limit', 'RATE_LIMIT'],
      ['invalid-credential', 'INVALID_CREDENTIAL'],
    ] as const

    for (const [kind, code] of cases) {
      const adapter = new AgyAdapter({
        getSession: async () => {
          throw new AgyAuthError(kind, `auth ${kind}`)
        },
        reportFailure: async () => {},
      })
      await expect(async () => {
        for await (const _ of adapter.stream(generateOptions())) void _
      }).rejects.toMatchObject({ code })
    }
  })

  it('listModels falls back for expected availability errors but rethrows unknown failures', async () => {
    const blocked = new AgyAdapter({
      getSession: async () => {
        throw new AgyPoolBlockedError('retryable', Date.now() + 60000)
      },
      reportFailure: async () => {},
    })
    const models = await blocked.listModels('agy')
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true)

    const broken = new AgyAdapter({
      getSession: async () => { throw new Error('store corrupt') },
      reportFailure: async () => {},
    })
    await expect(broken.listModels('agy')).rejects.toThrow('store corrupt')
  })

  it('converts quota-exhausted pool blockage into terminal QUOTA error', async () => {
    const resetAt = Date.now() + 86400000
    const adapter = new AgyAdapter({
      getSession: async () => {
        throw new AgyPoolBlockedError('quota-exhausted', resetAt)
      },
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({
      code: 'QUOTA',
    })
  })
})

describe('parseAgySse inbound shape contract', () => {
  /**
   * Block-stream well-formedness invariants. The upstream response is external
   * input of arbitrary shape; every parsed stream must satisfy these
   * regardless of how the model interleaves text / reasoning / functionCalls.
   * This is the inbound mirror of assertUpstreamContract (outbound).
   */
  function assertBlockStreamWellFormed(chunks: unknown[]): void {
    const openIndexes = new Set<number>()
    let sawUsage = false
    let sawFinish = false
    for (const chunk of chunks as Array<{ type: string; index?: number; block?: { type: string; arguments?: string } }>) {
      switch (chunk.type) {
        case 'block-start': {
          expect(openIndexes.has(chunk.index!), `block-start ${chunk.index} while block open`).toBe(false)
          openIndexes.add(chunk.index!)
          break
        }
        case 'text-delta':
        case 'reasoning-delta':
        case 'tool-call-delta': {
          expect(openIndexes.has(chunk.index!), `${chunk.type} ${chunk.index} without open block`).toBe(true)
          break
        }
        case 'block-end': {
          expect(openIndexes.has(chunk.index!), `block-end ${chunk.index} without block-start`).toBe(true)
          openIndexes.delete(chunk.index!)
          if (chunk.block?.type === 'tool-call') {
            // args must always be standalone valid JSON — never concatenated
            // fragments from consecutive functionCall parts
            expect(() => JSON.parse(chunk.block?.arguments ?? ''), `tool-call ${chunk.index} args not valid JSON`).not.toThrow()
          }
          break
        }
        case 'usage': {
          expect(sawUsage, 'duplicate usage').toBe(false)
          sawUsage = true
          break
        }
        case 'finish': {
          expect(sawFinish, 'duplicate finish').toBe(false)
          sawFinish = true
          break
        }
      }
    }
    expect(openIndexes.size, 'unclosed blocks at stream end').toBe(0)
    expect(sawFinish, 'stream must end with finish').toBe(true)
    expect((chunks[chunks.length - 1] as { type: string }).type, 'finish must be last').toBe('finish')
  }

  const SHAPES: Array<{ name: string; lines: string[]; assert?: (chunks: unknown[]) => void }> = [
    {
      name: 'single text block, split across events',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"text":"Hel"},{"text":"lo"}]}}]}]',
        'data: [{"candidates":[{"content":{"parts":[{"text":"!"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const starts = chunks.filter((c) => (c as { type: string }).type === 'block-start')
        expect(starts).toHaveLength(1)
        const text = chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text).join('')
        expect(text).toBe('Hello!')
      },
    },
    {
      name: 'reasoning then text then tool call (full interleave)',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"thought":true,"text":"hmm"},{"text":"answer"}]}}]}]',
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const types = chunks.map((c) => (c as { type: string }).type)
        expect(types.filter((t) => t === 'block-start')).toHaveLength(3)
        expect(types.filter((t) => t === 'block-end')).toHaveLength(3)
        const tool = chunks.find((c) => (c as { type: string }).type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
        expect(tool).toMatchObject({ block: { type: 'tool-call', id: 'c1', arguments: '{"cmd":"ls"}' } })
      },
    },
    {
      name: 'two consecutive functionCalls in one event (parallel tools)',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"edit_file","args":{"path":"/a"}}},{"functionCall":{"id":"c2","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const toolEnds = chunks.filter((c) => (c as { type: string }).type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
        expect(toolEnds).toHaveLength(2)
        expect((toolEnds[0] as { block: { arguments: string } }).block.arguments).toBe('{"path":"/a"}')
        expect((toolEnds[1] as { block: { arguments: string } }).block.arguments).toBe('{"cmd":"ls"}')
      },
    },
    {
      name: 'two consecutive functionCalls across separate events',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"edit_file","args":{"path":"/a"}}}]}}]}]',
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c2","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const toolEnds = chunks.filter((c) => (c as { type: string }).type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
        expect(toolEnds).toHaveLength(2)
      },
    },
    {
      name: 'functionCall args arriving as raw JSON string part',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"id":"c1","name":"bash","args":"{\\"cmd\\":\\"ls\\"}"}}]}}]}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const tool = chunks.find((c) => (c as { type: string }).type === 'block-end' && (c as { block: { type: string } }).block.type === 'tool-call')
        expect(tool).toMatchObject({ block: { arguments: '{"cmd":"ls"}' } })
      },
    },
    {
      name: 'empty parts array (no content)',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[]}}]}]',
        'data: [DONE]',
      ],
    },
    {
      name: 'candidates absent entirely',
      lines: [
        'data: [{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":0}}]',
        'data: [DONE]',
      ],
    },
    {
      name: 'usageMetadata on every event (cumulative)',
      lines: [
        'data: [{"candidates":[{"content":{"parts":[{"text":"a"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}]',
        'data: [{"candidates":[{"content":{"parts":[{"text":"b"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2}}]',
        'data: [DONE]',
      ],
      assert: (chunks) => {
        const usages = chunks.filter((c) => (c as { type: string }).type === 'usage')
        expect(usages).toHaveLength(1) // emitted once, final totals
      },
    },
  ]

  it.each(SHAPES)('well-formed: $name', async ({ lines, assert }) => {
    const chunks = await collect(parseAgySse(sseStream(lines)))
    assertBlockStreamWellFormed(chunks)
    assert?.(chunks)
  })

  it('text reconstruction is invariant to chunk boundaries (property test)', async () => {
    // The same logical text split at different SSE boundaries must rebuild
    // identically (mirrors OmniRoute's sse-parser property test).
    const full = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    const boundaries = [1, 7, 31, 128]
    const rebuilt: string[] = []
    for (const size of boundaries) {
      const parts: string[] = []
      for (let i = 0; i < full.length; i += size) parts.push(full.slice(i, i + size))
      const lines = parts.map((p) => `data: [{"candidates":[{"content":{"parts":[{"text":${JSON.stringify(p)}}]}}]}]`)
      lines.push('data: [DONE]')
      const chunks = await collect(parseAgySse(sseStream(lines)))
      assertBlockStreamWellFormed(chunks)
      rebuilt.push(chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text).join(''))
    }
    expect(new Set(rebuilt)).toEqual(new Set([full]))
  })
})
