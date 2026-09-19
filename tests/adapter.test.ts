import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AGY_SCHEMA_ALLOWLIST, toAgyRequestBody } from '../src/adapter/translate.ts'
import { parseAgySse, parseSseDataLine } from '../src/adapter/parse.ts'
import { catalogModelList, fetchAvailableModels, listAgyModels, mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { formatTieredModelName } from '../src/adapter/catalog.ts'
import { AgyAdapter } from '../src/adapter/adapter.ts'
import type { AgyAccountSession } from '../src/adapter/adapter.ts'
import { AgyAuthError, AgyPoolBlockedError } from '../src/types.ts'
function textMessage(role: Message['role'], text: string): Message {
  return { id: `m-${Math.random()}`, role, content: [{ type: 'text', text }] } as Message
}

function imageMessage(): Message {
  return {
    id: 'm-img',
    role: 'user',
    content: [
      { type: 'text', text: '看图' },
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
    ],
  } as Message
}

function twoImageMessage(): Message {
  return {
    id: 'm-img-2',
    role: 'user',
    content: [
      { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 } },
    ],
  } as Message
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

  it('translates user image blocks into inlineData parts from resolved bytes', () => {
    const messages = [
      { id: 'a', role: 'user' as const, content: [
        { type: 'text' as const, text: '这张图片是什么' },
        { type: 'image' as const, attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      ]},
    ]
    const images = new Map([['att-1', { mediaType: 'image/png', data: 'aGVsbG8=' }]])
    const body = toAgyRequestBody(generateOptions({ messages }), { images })
    expect(body.request.contents[0]!.parts).toEqual([
      { text: '这张图片是什么' },
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ])
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

  it('keeps inlineData parts on Claude models while stripping the trailing model turn', () => {
    const messages = [
      { id: 'a', role: 'user' as const, content: [
        { type: 'image' as const, attachment: { attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 } },
        { type: 'text' as const, text: '看图' },
      ]},
      { id: 'b', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'prefill' }] },
    ]
    const images = new Map([['att-1', { mediaType: 'image/jpeg', data: 'aGVsbG8=' }]])
    const body = toAgyRequestBody(generateOptions({ model: 'claude-opus-4-6-thinking', messages }), { images })
    expect(body.request.contents).toHaveLength(1)
    expect(body.request.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
      { text: '看图' },
    ])
  })

  it('skips non-user image blocks instead of crashing on the unresolved-map guard', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'image' as const, attachment: { attachmentId: 'att-assistant', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
        { type: 'text' as const, text: 'answer' },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ messages }), {})
    expect(body.request.contents[0]!.parts).toEqual([{ text: 'answer' }])
  })

  it('throws instead of silently dropping an image missing from the resolved map', () => {
    const messages = [
      { id: 'a', role: 'user' as const, content: [
        { type: 'image' as const, attachment: { attachmentId: 'att-missing', mediaType: 'image/png', bytes: 4, width: 1, height: 1 } },
      ]},
    ]
    expect(() => toAgyRequestBody(generateOptions({ messages }), {})).toThrowError(/att-missing/)
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
  it('formats tiered model ids into human-readable display names', () => {
    expect(formatTieredModelName('gemini-3.8-flash-tiered')).toBe('Gemini 3.8 Flash')
    expect(formatTieredModelName('gemini-3.9-flash-tiered')).toBe('Gemini 3.9 Flash')
    expect(formatTieredModelName('gemini-4.0-pro-tiered')).toBe('Gemini 4.0 Pro')
  })

  it('merges dynamic ids with catalog metadata and filters tab models', () => {
    const merged = mergeModelCatalog({
      models: {
        'gemini-3.6-flash-high': { displayName: 'Gemini 3.6 Flash (High)' },
        'tab_flash_lite_preview': { displayName: 'Tab Flash' },
        'some-new-model': { displayName: 'New' },
        'gemini-3.8-flash-tiered': { displayName: 'gemini-3.8-flash-tiered' },
        'gemini-3.9-flash-tiered': { displayName: 'gemini-3.9-flash-tiered' },
      },
    })
    const ids = merged.map((m) => m.id)
    expect(ids).toContain('gemini-3.6-flash-high')
    expect(ids).not.toContain('tab_flash_lite_preview')
    expect(merged.find((m) => m.id === 'gemini-3.6-flash-high')?.context?.contextWindow).toBe(1048576)
    expect(merged.find((m) => m.id === 'some-new-model')?.name).toBe('New')
    // tiered model with raw id displayName is prettified from catalog / dynamic fallback
    expect(merged.find((m) => m.id === 'gemini-3.8-flash-tiered')?.name).toBe('Gemini 3.8 Flash')
    expect(merged.find((m) => m.id === 'gemini-3.9-flash-tiered')?.name).toBe('Gemini 3.9 Flash')
    expect(merged.find((m) => m.id === 'gemini-3.9-flash-tiered')?.context?.contextWindow).toBe(1048576)
  })

  it('hides ids upstream assigns to a non-chat role, including ids without a tab_ prefix', () => {
    const merged = mergeModelCatalog({
      models: {
        'gemini-3.6-flash-high': {},
        'chat_20706': {},
        'gemini-3.1-flash-image': { displayName: 'Gemini 3.1 Flash Image' },
        'models/proactive-observer-v10': {},
      },
      tabModelIds: ['chat_20706'],
      imageGenerationModelIds: ['gemini-3.1-flash-image'],
      audioTranscriptionModelIds: ['models/proactive-observer-v10'],
    })
    expect(merged.map((m) => m.id)).toEqual(['gemini-3.6-flash-high'])
  })

  it('hides a deprecated id only when its replacement is present, chat-callable and visible', () => {
    const withReplacement = mergeModelCatalog({
      models: { 'gemini-3.1-pro-high': {}, 'gemini-pro-agent': {} },
      deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
    })
    expect(withReplacement.map((m) => m.id)).toEqual(['gemini-pro-agent'])

    // Replacement absent from this account's tier: keep the retired id, or the
    // capability becomes unreachable.
    const withoutReplacement = mergeModelCatalog({
      models: { 'gemini-3.1-pro-high': {} },
      deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
    })
    expect(withoutReplacement.map((m) => m.id)).toEqual(['gemini-3.1-pro-high'])

    // Replacement itself hidden by a role: same reasoning.
    const replacementHidden = mergeModelCatalog({
      models: { 'old-model': {}, 'new-model': {} },
      deprecatedModelIds: { 'old-model': { newModelId: 'new-model' } },
      imageGenerationModelIds: ['new-model'],
    })
    expect(replacementHidden.map((m) => m.id)).toEqual(['old-model'])

    // Replacement present but never listed anyway (tab_ rule): same reasoning.
    const replacementNotCallable = mergeModelCatalog({
      models: { 'old-model': {}, 'tab_new_model': {} },
      deprecatedModelIds: { 'old-model': { newModelId: 'tab_new_model' } },
    })
    expect(replacementNotCallable.map((m) => m.id)).toEqual(['old-model'])
  })

  it('resolves a deprecation chain the same way whatever order the payload lists it in', () => {
    const models = { 'model-a': {}, 'model-b': {}, 'model-c': {} }
    const forwards = mergeModelCatalog({
      models,
      deprecatedModelIds: { 'model-a': { newModelId: 'model-b' }, 'model-b': { newModelId: 'model-c' } },
    })
    const backwards = mergeModelCatalog({
      models,
      deprecatedModelIds: { 'model-b': { newModelId: 'model-c' }, 'model-a': { newModelId: 'model-b' } },
    })
    expect(forwards.map((m) => m.id)).toEqual(['model-c'])
    expect(backwards.map((m) => m.id)).toEqual(['model-c'])

    // Chain truncated by the account's tier: only the link with a present
    // replacement is hidden.
    const truncated = mergeModelCatalog({
      models: { 'model-a': {}, 'model-b': {} },
      deprecatedModelIds: { 'model-a': { newModelId: 'model-b' }, 'model-b': { newModelId: 'model-c' } },
    })
    expect(truncated.map((m) => m.id)).toEqual(['model-b'])
  })

  it('never hides an id the payload also advertises', () => {
    const merged = mergeModelCatalog({
      models: { 'gemini-3.6-flash-high': {}, 'gemini-3.8-flash-tiered': {}, 'sorted-model': {} },
      // upstream contradicting itself: these ids also sit in a non-chat role
      imageGenerationModelIds: ['gemini-3.8-flash-tiered'],
      tabModelIds: ['sorted-model'],
      deprecatedModelIds: { 'gemini-3.6-flash-high': { newModelId: 'gemini-3.8-flash-tiered' } },
      defaultAgentModelId: 'gemini-3.6-flash-high',
      agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['sorted-model'] }] }],
      tieredModelIds: { flash: ['gemini-3.8-flash-tiered'] },
    })
    expect(merged.map((m) => m.id).sort()).toEqual(['gemini-3.6-flash-high', 'gemini-3.8-flash-tiered', 'sorted-model'])

    // defaultAgentModelId alone must beat a deprecation whose replacement is
    // present and perfectly visible.
    const defaultWins = mergeModelCatalog({
      models: { 'gemini-3.1-pro-high': {}, 'gemini-pro-agent': {} },
      deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
      defaultAgentModelId: 'gemini-3.1-pro-high',
    })
    expect(defaultWins.map((m) => m.id).sort()).toEqual(['gemini-3.1-pro-high', 'gemini-pro-agent'])
  })

  it('leaves a payload without role keys exactly as before', () => {
    const models = { 'gemini-3.6-flash-high': {}, 'tab_flash_lite_preview': {}, 'some-new-model': {} }
    expect(mergeModelCatalog({ models }).map((m) => m.id)).toEqual(['gemini-3.6-flash-high', 'some-new-model'])
    expect(mergeModelCatalog({}).map((m) => m.id)).toEqual([])
  })

  it('tolerates malformed role values instead of throwing', () => {
    const merged = mergeModelCatalog({
      models: { 'gemini-3.6-flash-high': {}, 'keep-me': {} },
      tabModelIds: 'not-an-array' as unknown as string[],
      imageGenerationModelIds: [null, 42, ''] as unknown as string[],
      deprecatedModelIds: {
        'keep-me': null as unknown as { newModelId?: string },
        'gemini-3.6-flash-high': { newModelId: '' },
      },
      agentModelSorts: [{ groups: undefined }, null as unknown as { groups?: { modelIds?: string[] }[] }],
      tieredModelIds: { flash: null as unknown as string[] },
    })
    expect(merged.map((m) => m.id).sort()).toEqual(['gemini-3.6-flash-high', 'keep-me'])

    const arrayShapedDeprecations = mergeModelCatalog({
      models: { 'keep-me': {} },
      deprecatedModelIds: ['not-an-object'] as unknown as Record<string, { newModelId?: string }>,
    })
    expect(arrayShapedDeprecations.map((m) => m.id)).toEqual(['keep-me'])
  })

  it('matches a live account payload: drops the non-tab_ tab id, the image id and the retired pro id', () => {
    // Role keys copied from a real Google AI Pro discovery response (ids only).
    const merged = mergeModelCatalog({
      models: {
        'gemini-3.8-flash-tiered': {}, 'gemini-3.7-flash-tiered': {}, 'gemini-pro-agent': {},
        'claude-sonnet-4-6': {}, 'claude-opus-4-6-thinking': {}, 'gpt-oss-120b-medium': {},
        'gemini-3.1-flash-lite': {}, 'gemini-3-flash': {}, 'gemini-3.1-pro-low': {},
        'gemini-3.1-pro-high': {}, 'gemini-3.1-flash-image': {},
        'chat_20706': {}, 'chat_23310': {}, 'tab_flash_lite_preview': {},
      },
      tabModelIds: ['chat_20706', 'chat_23310'],
      commandModelIds: ['gemini-3-flash'],
      imageGenerationModelIds: ['gemini-3.1-flash-image'],
      mqueryModelIds: ['gemini-3.1-flash-lite'],
      webSearchModelIds: ['gemini-3.1-flash-lite'],
      commitMessageModelIds: ['gemini-3.1-flash-lite'],
      audioTranscriptionModelIds: ['models/proactive-observer-v10'],
      deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
      defaultAgentModelId: 'gemini-3.6-flash-high',
      agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-pro-agent', 'gemini-3.1-pro-low', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'] }] }],
      tieredModelIds: { flashLite: ['gemini-3.1-flash-lite'], flash: ['gemini-3.8-flash-tiered'], pro: ['gemini-3.1-pro-low'] },
    } as Parameters<typeof mergeModelCatalog>[0])
    const ids = merged.map((m) => m.id)
    expect(ids).not.toContain('chat_20706')
    expect(ids).not.toContain('chat_23310')
    expect(ids).not.toContain('tab_flash_lite_preview')
    expect(ids).not.toContain('gemini-3.1-flash-image')
    expect(ids).not.toContain('gemini-3.1-pro-high')
    // utility roles are not a hiding signal: this one is a pinned chat model
    expect(ids).toContain('gemini-3.1-flash-lite')
    expect(ids).toContain('gemini-3-flash')
    expect(ids).toContain('gemini-pro-agent')
    expect(ids).toHaveLength(9)
  })

  it('falls back to catalog when the endpoint fails', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
    const models = await listAgyModels('at', 'p', fetchImpl)
    expect(models.length).toBeGreaterThan(0)
  })

  it('declares input modalities per catalog vision metadata (unknown ids default to image)', () => {
    const merged = mergeModelCatalog({ models: { 'gemini-3.6-flash-high': {}, 'some-new-model': {} } })
    expect(merged.find((m) => m.id === 'gemini-3.6-flash-high')?.inputModalities).toEqual(['text', 'image'])
    expect(merged.find((m) => m.id === 'some-new-model')?.inputModalities).toEqual(['text', 'image'])
    const byId = new Map(catalogModelList().map((m) => [m.id, m.inputModalities]))
    expect(byId.get('gemini-3.6-flash-high')).toEqual(['text', 'image'])
    expect(byId.get('gemini-2.5-flash')).toEqual(['text', 'image'])
    expect(byId.get('gpt-oss-120b-medium')).toEqual(['text'])
    expect(resolveAgyModel('agy', 'brand-new-model').inputModalities).toEqual(['text', 'image'])
    expect(resolveAgyModel('agy', 'gemini-2.5-flash').inputModalities).toEqual(['text', 'image'])
    expect(resolveAgyModel('agy', 'gemini-3.7-flash-tiered').inputModalities).toEqual(['text', 'image'])
  })

  it('resolves exact-model metadata from the catalog', () => {
    const resolved = resolveAgyModel('agy', 'claude-opus-4-6-thinking')
    expect(resolved.name).toContain('Claude Opus')
    expect(resolved.defaultMaxTokens).toBe(65536)
    const unknown = resolveAgyModel('agy', 'brand-new-model')
    expect(unknown.name).toBe('brand-new-model')
    expect(unknown.defaultMaxTokens).toBeUndefined()
  })

  it('exposes reasoning efforts for tiered models (both catalog and dynamic)', () => {
    const resolved38 = resolveAgyModel('agy', 'gemini-3.8-flash-tiered')
    expect(resolved38.name).toBe('Gemini 3.8 Flash')
    expect(resolved38.reasoning).toBeDefined()
    expect(resolved38.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(String(resolved38.reasoning!.defaultEffort)).toBe('medium')
    expect(resolved38.inputModalities).toEqual(['text', 'image'])

    const resolved = resolveAgyModel('agy', 'gemini-3.7-flash-tiered')
    expect(resolved.name).toBe('Gemini 3.7 Flash')
    expect(resolved.reasoning).toBeDefined()
    expect(resolved.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(String(resolved.reasoning!.defaultEffort)).toBe('medium')
    expect(resolved.inputModalities).toEqual(['text', 'image'])

    const tiered36 = resolveAgyModel('agy', 'gemini-3.6-flash-tiered')
    expect(tiered36.reasoning).toBeDefined()
    expect(tiered36.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(tiered36.inputModalities).toEqual(['text', 'image'])

    // dynamically discovered uncataloged tiered model
    const dynamicTiered = resolveAgyModel('agy', 'gemini-3.9-flash-tiered')
    expect(dynamicTiered.name).toBe('Gemini 3.9 Flash')
    expect(dynamicTiered.reasoning).toBeDefined()
    expect(dynamicTiered.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(dynamicTiered.context?.contextWindow).toBe(1048576)
    expect(dynamicTiered.defaultMaxTokens).toBe(65536)
    expect(dynamicTiered.inputModalities).toEqual(['text', 'image'])

    // legacy id-bound models and non-tiered discovered ids must not expose reasoning
    for (const id of ['gemini-3.6-flash-high', 'gemini-2.5-flash', 'brand-new-model']) {
      expect(resolveAgyModel('agy', id).reasoning).toBeUndefined()
    }
  })

  it('maps reasoningEffort to thinkingConfig for tiered models only', () => {
    const low = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'low' as any }), {})
    expect(low.request.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'low', includeThoughts: true } })
    const medium = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'medium' as any }), {})
    expect(medium.request.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'medium', includeThoughts: true } })
    const high = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'high' as any }), {})
    expect(high.request.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } })

    // dynamic uncataloged tiered model also sends thinkingConfig
    const dynamicHigh = toAgyRequestBody(generateOptions({ model: 'gemini-3.9-flash-tiered', reasoningEffort: 'high' as any }), {})
    expect(dynamicHigh.request.generationConfig).toMatchObject({ thinkingConfig: { thinkingLevel: 'high', includeThoughts: true } })

    const noEffort = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered' }), {})
    expect(noEffort.request.generationConfig?.thinkingConfig).toBeUndefined()

    // purpose: 'session-title' disables thinking to protect tight maxTokens budgets
    const titleReq = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', purpose: 'session-title' as any }), {})
    expect(titleReq.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })

    // reasoningEffort 'none' or 'off' also sets thinkingBudget: 0
    const noneEffort = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'none' as any }), {})
    expect(noneEffort.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    const offEffort = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'off' as any }), {})
    expect(offEffort.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })

    const fixedModel = toAgyRequestBody(generateOptions({ model: 'gemini-3.6-flash-high', reasoningEffort: 'high' as any }), {})
    expect(fixedModel.request.generationConfig?.thinkingConfig).toBeUndefined()

    const invalid = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'ultra' as any }), {})
    expect(invalid.request.generationConfig?.thinkingConfig).toBeUndefined()
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

  it('fails image requests with UNSUPPORTED_CONTENT and no fetch when the attachment service is absent', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions({ messages: [imageMessage()] }))) void _
    }).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fails image requests with UNSUPPORTED_CONTENT naming the attachment when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      resolveAttachments: () => ({
        readImage: async () => { throw new Error('attachment storage offline') },
      }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions({ messages: [imageMessage()] }))) void _
    }).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringContaining('agy image attachment "att-1" could not be loaded: attachment storage offline'),
    })
  })

  it('resolves image attachments concurrently and returns a complete map', async () => {
    const bodies: Array<{ request: { contents: Array<{ parts: unknown[] }> } }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(sseStream(['data: [DONE]']), { status: 200 })
    }))
    let inFlight = 0
    let maxInFlight = 0
    const settlementOrder: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      resolveAttachments: () => ({
        readImage: async (ref: { attachmentId: string }) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          // att-1 is the slow read; a sequential loop would settle att-1 before
          // att-2 and never exceed one in-flight read.
          await new Promise((resolve) => setTimeout(resolve, ref.attachmentId === 'att-1' ? 20 : 0))
          inFlight -= 1
          settlementOrder.push(ref.attachmentId)
          return {
            ref: { mediaType: ref.attachmentId === 'att-1' ? 'image/png' : 'image/jpeg' },
            data: new Uint8Array([ref.attachmentId === 'att-1' ? 1 : 2]),
          }
        },
      }),
    })
    for await (const _ of adapter.stream(generateOptions({ messages: [twoImageMessage()] }))) void _
    expect(maxInFlight).toBe(2)
    expect(settlementOrder).toEqual(['att-2', 'att-1'])
    expect(bodies).toHaveLength(1)
    expect(bodies[0]!.request.contents[0]!.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'AQ==' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'Ag==' } },
    ])
  })

  it('reports the first failing attachment in ref order when concurrent reads fail', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      resolveAttachments: () => ({
        // att-2 rejects immediately while att-1 rejects later: a bare Promise.all
        // would surface att-2 (whichever raced first), but the contract is
        // deterministic ref order.
        readImage: async (ref: { attachmentId: string }) => {
          if (ref.attachmentId === 'att-2') throw new Error('att-2 exploded')
          await new Promise((resolve) => setTimeout(resolve, 15))
          throw new Error('att-1 exploded')
        },
      }),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions({ messages: [twoImageMessage()] }))) void _
    }).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTENT',
      message: expect.stringContaining('agy image attachment "att-1" could not be loaded: att-1 exploded'),
    })
  })

  it('resolves multimodal file handles and includes inlineData in request body for Gemini', async () => {
    let capturedBody: any
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(sseStream([
        'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]',
        'data: [DONE]',
      ]), { status: 200 })
    }))

    const tmpDir = os.tmpdir()
    const tmpFile = path.join(tmpDir, 'test-adapter-doc.pdf')
    await fs.promises.writeFile(tmpFile, 'PDF dummy content')

    const fileText = `[File "test-adapter-doc.pdf" (18 bytes, sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef): verbatim read-only copy saved at "${tmpFile}".]`
    const messages = [
      {
        id: 'msg-1',
        role: 'user' as const,
        content: [{ type: 'text' as const, text: fileText }],
      },
    ]

    try {
      const adapter = new AgyAdapter({
        getSession: async () => session(),
        reportFailure: async () => {},
      })
      for await (const _ of adapter.stream(generateOptions({ model: 'gemini-3.8-flash-tiered', messages }))) {
        void _
      }
      expect(capturedBody).toBeDefined()
      const parts = capturedBody.request.contents[0].parts
      expect(parts).toHaveLength(2)
      expect(parts[0]).toEqual({ text: fileText })
      expect(parts[1]).toEqual({
        inlineData: {
          mimeType: 'application/pdf',
          data: Buffer.from('PDF dummy content').toString('base64'),
        },
      })
    } finally {
      await fs.promises.unlink(tmpFile).catch(() => {})
    }
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

  it('maps upstream 5xx to retryable SERVER with the retry-after hint', async () => {
    // Real Google 503 body: capacity rejection for one model.
    const body = JSON.stringify({
      error: {
        code: 503,
        message: 'No capacity available for model gemini-3.8-flash-tiered on the server',
        status: 'UNAVAILABLE',
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503, headers: { 'retry-after': '3' } })))
    const failures: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind) => { failures.push(kind) },
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({
      code: 'SERVER',
      failure: { providerRetryAfterMs: 3000 },
      message: expect.stringContaining('agy upstream error (503)'),
    })
    expect(failures).toEqual(['transient'])
  })

  it('maps upstream 5xx without a retry-after header to SERVER without a delay hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":500}}', { status: 500 })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    let thrown: unknown
    try {
      for await (const _ of adapter.stream(generateOptions())) void _
    } catch (error) {
      thrown = error
    }
    expect(thrown).toMatchObject({ code: 'SERVER' })
    // No retry-after header: the failure carries no delay hint (LlmFailure drops
    // undefined fields), so the harness falls back to its own backoff.
    const failure = (thrown as { failure?: { providerRetryAfterMs?: number } }).failure
    expect(failure?.providerRetryAfterMs).toBeUndefined()
  })

  it('keeps non-5xx upstream errors terminal as UPSTREAM', async () => {
    for (const [status, body] of [
      [404, '{"error":{"message":"model not found"}}'],
      [400, '{"error":{"message":"malformed payload"}}'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
      const adapter = new AgyAdapter({
        getSession: async () => session(),
        reportFailure: async () => {},
      })
      await expect(async () => {
        for await (const _ of adapter.stream(generateOptions())) void _
      }, `status ${status}`).rejects.toMatchObject({ code: 'UPSTREAM' })
    }
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

  it('prepareCall binds model and stream to one generation (DSH rc.8+ compat)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]',
      'data: [DONE]',
    ]), { status: 200 })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    const prepared = await adapter.prepareCall('agy', 'gemini-2.5-flash')
    expect(prepared.model.id).toBe('gemini-2.5-flash')
    expect(prepared.model.provider).toBe('agy')
    const chunks: unknown[] = []
    for await (const chunk of prepared.stream(generateOptions({ model: 'gemini-2.5-flash' }))) chunks.push(chunk)
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
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
