import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { AGY_CLAUDE_MAX_OUTPUT_TOKENS, AGY_SCHEMA_ALLOWLIST, toAgyRequestBody } from '../src/adapter/translate.ts'
import { parseAgySse, parseSseDataLine } from '../src/adapter/parse.ts'
import { catalogModelList, fetchAvailableModels, listAgyModels, mergeModelCatalog, resolveAgyModel } from '../src/adapter/models.ts'
import { AGY_PUBLIC_MODELS, formatTieredModelName, isChatCallableModelId } from '../src/adapter/catalog.ts'
import { AgyAdapter, buildRequestHeaders } from '../src/adapter/adapter.ts'
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
      { functionResponse: { id: 'call-1', name: 'web_search', response: { result: 'result!', is_error: false } } },
    ])
  })

  // The Anthropic-backed Claude path requires tool_result.tool_use_id; Gemini
  // accepts either shape, so the id is always carried (live-verified: Claude
  // 400s without it, both families answer 200 with it).
  it('carries the tool-call id on functionResponse for the Claude path', () => {
    const messages = [
      { id: 'a', role: 'assistant' as const, content: [
        { type: 'tool-call' as const, id: 'toolu_vrtx_01Q', name: 'read', arguments: '{"file_path":"/x"}' },
      ]},
      { id: 'b', role: 'user' as const, content: [
        { type: 'tool-result' as const, toolCallId: 'toolu_vrtx_01Q', content: [{ type: 'text' as const, text: 'body' }] },
      ]},
    ]
    const body = toAgyRequestBody(generateOptions({ model: 'claude-opus-4-6-thinking', messages }), {})
    expect(body.request.contents[1]!.parts).toEqual([
      { functionResponse: { id: 'toolu_vrtx_01Q', name: 'read', response: { result: 'body', is_error: false } } },
    ])
  })

  /**
   * 0.2.0 promotes a tool result to a `tool`-ROLE message and drops
   * `tool-result` from the content-block union, so the same turn arrives with
   * the correlation on the message. The wire shape must not depend on which
   * dsh-llm line produced it, which is what routing both through
   * `toolResultPart` buys.
   */
  it('maps a 0.2.0 tool-role message to the same functionResponse part', () => {
    const messages = [
      { id: 'a', role: 'assistant', source: { kind: 'model', provider: 'agy', model: 'm' }, content: [
        { type: 'tool-call', id: 'call-1', name: 'web_search', arguments: '{"q":"x"}' },
      ]},
      {
        id: 'b',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-1' },
        toolCallId: 'call-1',
        content: [{ type: 'text', text: 'result!' }],
      },
      { id: 'c', role: 'user', content: [{ type: 'text', text: 'thanks' }] },
    ]
    const body = toAgyRequestBody(
      generateOptions({ messages: messages as unknown as GenerateOptions['messages'] }),
      {},
    )
    expect(body.request.contents.map((content) => content.role)).toEqual(['model', 'user', 'user'])
    expect(body.request.contents[1]!.parts).toEqual([
      { functionResponse: { id: 'call-1', name: 'web_search', response: { result: 'result!', is_error: false } } },
    ])
  })

  it('carries a 0.2.0 tool-role message isError onto the wire', () => {
    const messages = [
      { id: 'a', role: 'assistant', content: [
        { type: 'tool-call', id: 'call-9', name: 'read', arguments: '{}' },
      ]},
      { id: 'b', role: 'tool', toolCallId: 'call-9', isError: true, content: [{ type: 'text', text: 'boom' }] },
    ]
    const body = toAgyRequestBody(
      generateOptions({ messages: messages as unknown as GenerateOptions['messages'] }),
      {},
    )
    expect(body.request.contents[1]!.parts).toEqual([
      { functionResponse: { id: 'call-9', name: 'read', response: { result: 'boom', is_error: true } } },
    ])
  })

  /**
   * On BOTH supported lines a loop-built request carries the system prompt as a
   * leading `system`-role message and leaves `options.system` undefined. Sending
   * it through the conversation path put the prompt on the wire as an ordinary
   * USER turn; it belongs in `systemInstruction`.
   */
  it('lifts a system-role message into systemInstruction, not a user turn', () => {
    const messages = [
      { id: 's', role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'be terse' }] },
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const body = toAgyRequestBody(
      generateOptions({ messages: messages as unknown as GenerateOptions['messages'] }),
      {},
    )
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: 'be terse' }] })
    expect(body.request.contents).toHaveLength(1)
    expect(body.request.contents[0]).toEqual({ role: 'user', parts: [{ text: 'hello' }] })
  })

  it('keeps options.system ahead of the system-role message when both are present', () => {
    const messages = [
      { id: 's', role: 'system', content: [{ type: 'text', text: 'from history' }] },
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const body = toAgyRequestBody(
      generateOptions({
        system: 'from options',
        messages: messages as unknown as GenerateOptions['messages'],
      }),
      {},
    )
    expect(body.request.systemInstruction).toEqual({ parts: [{ text: 'from options\n\nfrom history' }] })
  })

  it('skips a developer message: tool bookkeeping is not a conversation turn', () => {
    const messages = [
      { id: 'd', role: 'developer', content: [{ type: 'tool-addition', toolName: 'read' }] },
      { id: 'u', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]
    const body = toAgyRequestBody(
      generateOptions({ messages: messages as unknown as GenerateOptions['messages'] }),
      {},
    )
    expect(body.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }])
  })

  // Empty text parts 400 the Claude path ("messages.N.content.M.text.text:
  // Field required"); upstream's own normalization drops them on the Gemini
  // path, so they are dropped here too. The trailing user turn keeps
  // stripTrailingModelTurn from removing the assistant message under test.
  it('drops empty text parts before they reach the wire', () => {
    const messages = [
      { id: 'a', role: 'user' as const, content: [
        { type: 'text' as const, text: 'hi' },
        { type: 'text' as const, text: '' },
      ]},
      { id: 'b', role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'answer' },
        { type: 'tool-call' as const, id: 'call-1', name: 'read', arguments: '{}' },
        { type: 'text' as const, text: '' },
      ]},
      { id: 'c', role: 'user' as const, content: [{ type: 'text' as const, text: 'next' }] },
    ]
    const body = toAgyRequestBody(generateOptions({ model: 'claude-opus-4-6-thinking', messages }), {})
    expect(body.request.contents[0]!.parts).toEqual([{ text: 'hi' }])
    expect(body.request.contents[1]!.parts).toEqual([
      { text: 'answer' },
      { thoughtSignature: 'skip_thought_signature_validator', functionCall: { id: 'call-1', name: 'read', args: {} } },
    ])
  })

  // A replayed thought cannot be re-signed for the Claude path (the sentinel is
  // rejected as an invalid signature), so it is dropped there; Gemini accepts
  // it. Reachable via a mid-session switch from a tiered Gemini model, whose
  // history carries reasoning blocks.
  it('drops replayed thought blocks on the Claude path only', () => {
    const messages = [
      { id: 'a', role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] },
      { id: 'b', role: 'assistant' as const, content: [
        { type: 'reasoning' as const, text: 'a gemini thought' },
        { type: 'text' as const, text: 'answer' },
      ]},
      { id: 'c', role: 'user' as const, content: [{ type: 'text' as const, text: 'next' }] },
    ]
    const claude = toAgyRequestBody(generateOptions({ model: 'claude-opus-4-6-thinking', messages }), {})
    expect(claude.request.contents[1]!.parts).toEqual([{ text: 'answer' }])

    const gemini = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered', messages }), {})
    expect(gemini.request.contents[1]!.parts).toEqual([
      { thought: true, text: 'a gemini thought' },
      { text: 'answer' },
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
              // empty-string enum items are rejected (cannot be empty) -> filtered out
              permission: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access', ''] },
              // all-empty enum items -> omitted entirely
              cleared: { type: 'string', enum: ['', ''] },
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
    expect(p.properties.permission).toEqual({
      type: 'string',
      enum: ['read-only', 'workspace-write', 'danger-full-access'],
    })
    expect(p.properties.cleared).toEqual({ type: 'string' })
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
      for (const item of items) {
        expect(typeof item, `${path}.enum item`).toBe('string')
        expect((item as string).length, `${path}.enum item: empty string is rejected upstream`).toBeGreaterThan(0)
      }
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

  // Claude-family ceiling is 64000, not the Gemini 65536 the catalog pinned:
  // 64001+ answers 400 INVALID_ARGUMENT ("Request contains an invalid
  // argument"), so the default the harness injects must stay under it.
  it('clamps maxOutputTokens to the Claude ceiling on the wire', () => {
    const overCap = toAgyRequestBody(
      generateOptions({ model: 'claude-opus-4-6-thinking', maxTokens: 65536 }),
      {},
    )
    expect(overCap.request.generationConfig?.maxOutputTokens).toBe(AGY_CLAUDE_MAX_OUTPUT_TOKENS)
    expect(AGY_CLAUDE_MAX_OUTPUT_TOKENS).toBe(64000)

    // At or under the ceiling passes through untouched (no silent shrink).
    const atCap = toAgyRequestBody(
      generateOptions({ model: 'claude-sonnet-4-6', maxTokens: 64000 }),
      {},
    )
    expect(atCap.request.generationConfig?.maxOutputTokens).toBe(64000)
    const underCap = toAgyRequestBody(
      generateOptions({ model: 'claude-sonnet-4-6', maxTokens: 8192 }),
      {},
    )
    expect(underCap.request.generationConfig?.maxOutputTokens).toBe(8192)

    // Gemini keeps the larger ceiling: the clamp is Claude-specific.
    const gemini = toAgyRequestBody(
      generateOptions({ model: 'gemini-3-flash-agent', maxTokens: 65536 }),
      {},
    )
    expect(gemini.request.generationConfig?.maxOutputTokens).toBe(65536)
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

function sseStreamRaw(text: string): ReadableStream<Uint8Array> {
  // Like sseStream but takes raw wire bytes: lets a test end the stream
  // WITHOUT a trailing newline (the EOF-residual path).
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

  it('throws on a bare JSON error line without the data: prefix', async () => {
    // Upstream drops its error vocabulary as a bare JSON line right before
    // terminating the stream; the non-data skip used to swallow it silently
    // and the turn ended looking complete (issue #85).
    await expect(async () => {
      const chunks = parseAgySse(sseStream([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"继续"}]}}]}}',
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ]))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/agy stream error \(500\): Internal error encountered\./)
  })

  it('still delivers the text emitted before a bare JSON error', async () => {
    const chunks: unknown[] = []
    await expect(async () => {
      for await (const chunk of parseAgySse(sseStream([
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"继续"}]}}]}}',
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ]))) chunks.push(chunk)
    }).rejects.toThrow(/Internal error/)
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
  })

  it('processes a final line that arrives without a trailing newline', async () => {
    // Content, usage, and finishReason riding the unterminated final line used
    // to be dropped wholesale at EOF. Its finishReason also completes the
    // stream: the completeness guard needs the residual processed.
    const chunks = await collect(parseAgySse(sseStreamRaw(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":1}}}')))
    expect(chunks.some((c) => (c as { type: string }).type === 'text-delta')).toBe(true)
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('treats a bare JSON error in the final unterminated line as a failure', async () => {
    await expect(async () => {
      const chunks = parseAgySse(sseStreamRaw(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"看 8"}]}}]}}\n{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}'))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/Internal error encountered\./)
  })

  it('counts a bare data: [DONE] final line toward completion', async () => {
    const chunks = await collect(parseAgySse(sseStreamRaw(
      'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]\ndata: [DONE]')))
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('fails a stream that closes cleanly without [DONE] or finishReason', async () => {
    // A proxy or LB closing the connection mid-body used to yield the default
    // `stop`: the truncated turn looked completed — no error, no retry
    // (issue #85).
    await expect(async () => {
      const chunks = parseAgySse(sseStreamRaw(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"继续"}]}}]}}\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"看"}]}}]}}'))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/terminated prematurely without \[DONE\] or finishReason/)
  })

  it('completes a stream that ends with [DONE] but no finishReason', async () => {
    // Either completion signal alone suffices.
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}]',
      'data: [DONE]',
    ])))
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('completes the measured live shape: finishReason terminates, no [DONE]', async () => {
    // MEASURED on daily-cloudcode-pa (2026-10-03, probe, 3/3): real streams
    // send NO `data: [DONE]` — the final data chunk carries the candidate
    // finishReason plus the routine zero-length `{thoughtSignature, text: ""}`
    // terminator part, which must not fabricate an empty text block
    // (issue #77). Pinning this stops the completeness guard from ever being
    // tightened into requiring [DONE], which would fail every live stream.
    const chunks = await collect(parseAgySse(sseStreamRaw(
      'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "OK"}]}}]},'
      + '"usageMetadata": {"promptTokenCount": 9}}\n'
      + 'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"thoughtSignature": "sig","text": ""}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 9,"candidatesTokenCount": 1,"totalTokenCount": 10}}}')))
    const text = chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('OK')
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.some((c) => (c as { type: string }).type === 'usage')).toBe(true)
  })

  it('does not fabricate an empty text block after a functionCall', async () => {
    // The daily endpoint ends tool-call turns with a trailing zero-length
    // text part (often carrying a sibling thoughtSignature). Emitting it
    // fabricated an empty content block into the session log — poison for
    // stricter downstream serializers (issue #77).
    const captured: Array<[string, string]> = []
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-1","functionCall":{"id":"c1","name":"bash","args":{"cmd":"ls"}}}]}}]}]',
      'data: [{"candidates":[{"content":{"parts":[{"thoughtSignature":"sig-2","text":""}]},"finishReason":"STOP"}]}]',
    ]), { onToolSignature: (id, sig) => captured.push([id, sig]) }))
    expect(chunks.filter((c) => (c as { type: string }).type === 'text-delta')).toHaveLength(0)
    const ends = chunks.filter((c) => (c as { type: string }).type === 'block-end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ block: { type: 'tool-call', id: 'c1' } })
    // signatures on text parts are ignored by design; only functionCall parts are captured
    expect(captured).toEqual([['c1', 'sig-1']])
  })

  it('keeps one text block across a zero-length part', async () => {
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"Hel"},{"text":""},{"text":"lo"}]}}]}]',
      'data: [{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}]',
    ])))
    expect(chunks.filter((c) => (c as { type: string }).type === 'block-start')).toHaveLength(1)
    const text = chunks.filter((c) => (c as { type: string }).type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toBe('Hello')
  })

  it('does not fabricate a reasoning block from a zero-length thought part', async () => {
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"thought":true,"text":""}]}}]}]',
      'data: [{"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}]',
    ])))
    expect(chunks.filter((c) => (c as { type: string }).type === 'block-start')).toHaveLength(0)
  })

  it('fails a stream blocked by an unmapped finishReason instead of stopping', async () => {
    // SAFETY used to fall through the default branch: the blocked turn looked
    // like a normal completion.
    await expect(async () => {
      const chunks = parseAgySse(sseStream([
        'data: [{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}]',
        'data: [DONE]',
      ]))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/unrecognized finishReason: SAFETY/)
  })

  it('fails on MALFORMED_FUNCTION_CALL like any other unmapped finishReason', async () => {
    await expect(async () => {
      const chunks = parseAgySse(sseStream([
        'data: [{"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash"}}]},"finishReason":"MALFORMED_FUNCTION_CALL"}]}]',
        'data: [DONE]',
      ]))
      for await (const _ of chunks) void _
    }).rejects.toThrow(/MALFORMED_FUNCTION_CALL/)
  })

  it('grants FINISH_REASON_UNSPECIFIED a normal stop', async () => {
    // Explicit but information-free: treated like the absent field.
    const chunks = await collect(parseAgySse(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"FINISH_REASON_UNSPECIFIED"}]}]',
      'data: [DONE]',
    ])))
    expect(chunks[chunks.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
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

  it('treats a chat_ session id as non-chat even when no role list names it', () => {
    // The role list is the primary signal, but it is optional in the payload:
    // an account that omits `tabModelIds` must still not get a raw session id in
    // the picker. Same rule the tab_ prefix already applied.
    expect(isChatCallableModelId('chat_20706')).toBe(false)
    expect(isChatCallableModelId('chat_23310')).toBe(false)
    expect(isChatCallableModelId('tab_flash_lite_preview')).toBe(false)
    // A chat-prefixed id that is NOT the session shape stays callable: the rule
    // is the digits suffix, not the word.
    expect(isChatCallableModelId('chat-flash')).toBe(true)
    expect(isChatCallableModelId('gemini-3.8-flash-tiered')).toBe(true)

    expect(mergeModelCatalog({
      models: { 'gemini-3.6-flash-high': {}, 'chat_20706': {} },
    }).map((m) => m.id)).toEqual(['gemini-3.6-flash-high'])
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
    // The harness injects this as maxTokens, and Antigravity rejects >64000 on
    // the Claude family with 400, so the catalog default must not exceed it.
    expect(resolved.defaultMaxTokens).toBe(AGY_CLAUDE_MAX_OUTPUT_TOKENS)
    expect(resolveAgyModel('agy', 'claude-sonnet-4-6').defaultMaxTokens).toBe(AGY_CLAUDE_MAX_OUTPUT_TOKENS)
    const unknown = resolveAgyModel('agy', 'brand-new-model')
    expect(unknown.name).toBe('brand-new-model')
    expect(unknown.defaultMaxTokens).toBeUndefined()
  })

  it('keeps every catalog default maxTokens within what upstream accepts', () => {
    // Live-verified ceiling: 64000 for the Claude family, 65536 for Gemini.
    for (const model of AGY_PUBLIC_MODELS) {
      const cap = model.id.startsWith('claude-') ? AGY_CLAUDE_MAX_OUTPUT_TOKENS : 65536
      expect(model.maxOutputTokens, `${model.id} exceeds its upstream ceiling`).toBeLessThanOrEqual(cap)
    }
  })

  it('exposes reasoning efforts for tiered models (both catalog and dynamic)', () => {
    const resolved38 = resolveAgyModel('agy', 'gemini-3.8-flash-tiered')
    expect(resolved38.name).toBe('Gemini 3.8 Flash')
    expect(resolved38.reasoning).toBeDefined()
    expect(resolved38.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    expect(resolved38.inputModalities).toEqual(['text', 'image'])

    const resolved = resolveAgyModel('agy', 'gemini-3.7-flash-tiered')
    expect(resolved.name).toBe('Gemini 3.7 Flash')
    expect(resolved.reasoning).toBeDefined()
    expect(resolved.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
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

  it('declares no default reasoning effort, so the selector keeps an adaptive option', () => {
    // Regression guard. `defaultEffort` is not a cosmetic default: the harness
    // resolves `effective = requested ?? reasoning.defaultEffort` AND builds the
    // selector's options as
    //   `...defaultEffort === void 0 ? [providerDefault] : []`
    // so declaring one both forces an effort onto every request and deletes the
    // only choice meaning "let the model decide" — the selector then has no
    // adaptive entry at all, and `translate.ts` always emits `thinkingConfig`.
    // Every tiered model must therefore leave it unset.
    for (const id of ['gemini-3.8-flash-tiered', 'gemini-3.7-flash-tiered', 'gemini-3.9-flash-tiered']) {
      const resolved = resolveAgyModel('agy', id)
      expect(resolved.reasoning, `${id} should expose reasoning`).toBeDefined()
      expect(
        resolved.reasoning!.defaultEffort,
        `${id} must not pin a default effort (it would remove the adaptive option)`,
      ).toBeUndefined()
      // The three explicit levels stay selectable next to the adaptive option.
      expect(resolved.reasoning!.efforts.map((e) => String(e.id))).toEqual(['low', 'medium', 'high'])
    }
  })

  it('omits thinkingConfig entirely when no effort is requested (adaptive path)', () => {
    // Companion to the guard above: with no `defaultEffort` in play, an omitted
    // effort must produce NO thinkingConfig, which is what lets the upstream run
    // its own adaptive budget. If this ever emits a level, the adaptive option
    // is broken at the wire even though the selector still lists it.
    const adaptive = toAgyRequestBody(generateOptions({ model: 'gemini-3.8-flash-tiered' }), {})
    expect(adaptive.request.generationConfig?.thinkingConfig).toBeUndefined()
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

  it('replaces the level with a configured budget, never sends both', () => {
    // Measured: when BOTH ride together the LEVEL wins —
    // `{thinkingLevel:"low",thinkingBudget:16000}` spends what `low` alone spends
    // (~180 thoughts against ~330 for the budget alone), and
    // `{thinkingLevel:"high",thinkingBudget:1000}` tracks `high` (~316 vs ~173).
    // Sending both would make the configured number silently inert, so the
    // budget must take the level's place.
    const budgetFor = (level: string): number | undefined =>
      level === 'high' ? 16000 : undefined
    const withBudget = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'high' as any }),
      { thinkingBudgetFor: budgetFor },
    )
    expect(withBudget.request.generationConfig?.thinkingConfig)
      .toEqual({ thinkingBudget: 16000, includeThoughts: true })

    // A level with no configured budget keeps the level token.
    const noBudget = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'low' as any }),
      { thinkingBudgetFor: budgetFor },
    )
    expect(noBudget.request.generationConfig?.thinkingConfig)
      .toEqual({ thinkingLevel: 'low', includeThoughts: true })

    // No resolver at all behaves exactly as before the feature existed.
    const absent = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'high' as any }),
      {},
    )
    expect(absent.request.generationConfig?.thinkingConfig)
      .toEqual({ thinkingLevel: 'high', includeThoughts: true })
  })

  it('keeps the off-paths off even when a budget is configured', () => {
    // `session-title` and an explicit none/off must still send `thinkingBudget:0`:
    // they exist to protect a tight maxTokens cap, and a user-configured level
    // budget is about how much thinking a NORMAL turn gets.
    const budgetFor = (): number => 16000
    const title = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', purpose: 'session-title' as any, reasoningEffort: 'high' as any }),
      { thinkingBudgetFor: budgetFor },
    )
    expect(title.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    const off = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'off' as any }),
      { thinkingBudgetFor: budgetFor },
    )
    expect(off.request.generationConfig?.thinkingConfig).toEqual({ thinkingBudget: 0 })
    // Id-bound models still never carry a config, budget or not.
    const idBound = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.6-flash-high', reasoningEffort: 'high' as any }),
      { thinkingBudgetFor: budgetFor },
    )
    expect(idBound.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('turns the Default effort into Max when a tiered budget is set', () => {
    // The selector's "Default" entry arrives with NO effort. Unset, the request
    // must carry no thinkingConfig at all (upstream allocates); a configured
    // value sends a bare `thinkingBudget` with no `thinkingLevel`, which is what
    // makes it a cap rather than a fourth tier.
    const withTiered = (budget: number | undefined): unknown =>
      toAgyRequestBody(
        generateOptions({ model: 'gemini-3.8-flash-tiered' }),
        { tieredBudgetFor: () => budget },
      ).request.generationConfig?.thinkingConfig

    expect(withTiered(undefined)).toBeUndefined()
    expect(withTiered(65_535)).toEqual({ thinkingBudget: 65_535, includeThoughts: true })
    // A chosen LEVEL still wins over the Default slot: they are different efforts.
    const leveled = toAgyRequestBody(
      generateOptions({ model: 'gemini-3.8-flash-tiered', reasoningEffort: 'high' as any }),
      { tieredBudgetFor: () => 65_535, thinkingBudgetFor: () => undefined },
    )
    expect(leveled.request.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: 'high', includeThoughts: true })
  })

  it('sends a Claude budget only when max_tokens leaves room above it', () => {
    // Measured on this channel: Claude rejects a budget that is not STRICTLY
    // below `max_tokens` (`budget=1024, max_tokens=1024` is a 400), and it also
    // rejects a budget sent with no `maxOutputTokens` at all. So the guard is the
    // difference between a working setting and a 400 on every request.
    const withClaudeBudget = (maxTokens: number | undefined): unknown =>
      toAgyRequestBody(
        generateOptions({ model: 'claude-opus-4-6-thinking', ...(maxTokens === undefined ? {} : { maxTokens }) }),
        { claudeBudgetFor: () => 16384 },
      ).request.generationConfig?.thinkingConfig

    // Room above the budget: sent.
    expect(withClaudeBudget(64_000)).toEqual({ thinkingBudget: 16384, includeThoughts: true })
    // Exactly equal is NOT enough (strictly greater is required).
    expect(withClaudeBudget(16_384)).toBeUndefined()
    // Below the budget: dropped rather than raising the caller's cap.
    expect(withClaudeBudget(1024)).toBeUndefined()
    // No output cap at all: also dropped.
    expect(withClaudeBudget(undefined)).toBeUndefined()
  })

  it('leaves a Claude request untouched when no budget is configured', () => {
    // The shipped default must change nothing: no budget means the request keeps
    // upstream's own thinking behaviour.
    const body = toAgyRequestBody(
      generateOptions({ model: 'claude-opus-4-6-thinking', maxTokens: 64_000 }),
      { claudeBudgetFor: () => undefined },
    )
    expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
    // And the resolver being absent entirely behaves the same way.
    const absent = toAgyRequestBody(
      generateOptions({ model: 'claude-opus-4-6-thinking', maxTokens: 64_000 }),
      {},
    )
    expect(absent.request.generationConfig?.thinkingConfig).toBeUndefined()
  })

  it('never sends a Claude budget on a session-title request', () => {
    // Session titles run with a tiny output cap, so a large budget would be
    // dropped by the room check anyway — but the purpose check keeps the
    // behaviour explicit rather than incidental.
    const body = toAgyRequestBody(
      generateOptions({ model: 'claude-opus-4-6-thinking', purpose: 'session-title' as any, maxTokens: 64_000 }),
      { claudeBudgetFor: () => 16384 },
    )
    expect(body.request.generationConfig?.thinkingConfig).toBeUndefined()
  })
})

describe('buildRequestHeaders', () => {
  function session(impersonation: AgyAccountSession['impersonation']): AgyAccountSession {
    return {
      auth: { access: 'at', expires: Date.now() + 3600_000, refresh: 'rt|p' },
      account: { email: 'a@b.c', refresh: 'rt|p', projectId: 'p', addedAt: 0, lastUsed: 0 },
      index: 0,
      impersonation,
    }
  }

  /**
   * Regression test for the highest-signal defect found in the security review.
   *
   * `attributionHeaders()` returns a lowercase `user-agent`; the impersonation
   * object uses camel-case `User-Agent`. Spreading both kept them as two distinct
   * properties, and `Headers` folded them into ONE comma-joined value:
   *
   *   `deepseek-harness/<v> (+url), antigravity/<v> <platform>`
   *
   * That header named this tool on every generation request, was byte-identical
   * for every dsh-agy user, and cannot be produced by any official client. This
   * test asserts the WIRE result rather than the intermediate object, because the
   * object looked correct in isolation — which is exactly how the bug survived.
   */
  it('sends exactly one User-Agent, and it is the client identity', () => {
    const headers = new Headers(buildRequestHeaders(session({
      'User-Agent': 'antigravity/2.0.0 darwin/arm64',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode/1.96.0',
      clientMetadata: { ideType: 'ANTIGRAVITY' },
    })))

    expect(headers.get('user-agent')).toBe('antigravity/2.0.0 darwin/arm64')
    expect(headers.get('user-agent')).not.toContain('deepseek-harness')
    // A comma-joined pair is the specific shape the old spread produced.
    expect(headers.get('user-agent')).not.toContain(',')
  })

  it('carries the two impersonation headers and nothing invented', () => {
    const headers = buildRequestHeaders(session({
      'User-Agent': 'antigravity/2.0.0 darwin/arm64',
      'X-Goog-Api-Client': 'google-cloud-sdk vscode/1.96.0',
      clientMetadata: { ideType: 'ANTIGRAVITY' },
    }))

    expect(headers.authorization).toBe('Bearer at')
    expect(headers['X-Goog-Api-Client']).toBe('google-cloud-sdk vscode/1.96.0')
    // Neither of these is an official shape: `Client-Metadata` and
    // `x-goog-request-id` are both absent from BOTH official binaries, and the
    // request id the backend correlates on is the body's `requestId` field.
    expect(Object.keys(headers).sort()).toEqual(
      ['User-Agent', 'X-Goog-Api-Client', 'accept', 'authorization', 'content-type'],
    )
    // The metadata message is not a header and must not be spread as one.
    expect(headers).not.toHaveProperty('clientMetadata')
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
        clientMetadata: { ideType: 'ANTIGRAVITY' },
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

  it('routes the generation stream through the account proxy', async () => {
    // Issue #29 (1): the stream used to omit session.account.proxy, so a
    // proxied account silently generated from the host's real IP.
    const { dispatcherForAsync, proxyAgent } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')
    const fetchSpy = vi.fn(async () => new Response(sseStream(['data: [DONE]']), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await withProxyFixture(async (accountProxy) => {
      const adapter = new AgyAdapter({
        getSession: async () => session({
          account: { email: 'a@b.c', refresh: 'rt|p', projectId: 'p', addedAt: 0, lastUsed: 0, proxy: accountProxy },
        }),
        reportFailure: async () => {},
      })
      for await (const _ of adapter.stream(generateOptions())) void _

      const init = fetchSpy.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined
      // Streaming class: the account dispatcher without the body inactivity timer.
      expect(init?.dispatcher).toBe(await dispatcherForAsync(accountProxy, { streaming: true }))
      expect(init?.dispatcher).not.toBe(proxyAgent)
    }, { credentials: 'user:sup3rs3cret' })
  })

  it('routes model listing through the account proxy', async () => {
    // Same defect class as the stream: discovery is account-scoped, so it must
    // not reveal the host's real IP for a proxied account (issue #29).
    const { dispatcherForAsync } = await import('../src/proxy.ts')
    const { withProxyFixture } = await import('./helpers/proxy-fixture.ts')
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ models: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await withProxyFixture(async (accountProxy) => {
      const adapter = new AgyAdapter({
        getSession: async () => session({
          account: { email: 'a@b.c', refresh: 'rt|p', projectId: 'p', addedAt: 0, lastUsed: 0, proxy: accountProxy },
        }),
        reportFailure: async () => {},
      })
      await adapter.listModels('agy')

      const init = fetchSpy.mock.calls[0]?.[1] as { dispatcher?: unknown } | undefined
      expect(init?.dispatcher).toBe(await dispatcherForAsync(accountProxy))
    })
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

  it('surfaces a premature stream death as terminal UPSTREAM and absorbs it at the account level', async () => {
    // Deliberately NOT TRANSPORT: content may already have been delivered and
    // DSH retries TRANSPORT, which would replay a partially-delivered turn.
    // The account-level network-error report absorbs the transient case.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStreamRaw(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"半截"}]}}]}}'), { status: 200 })))
    const failures: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind) => { failures.push(kind) },
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({ code: 'UPSTREAM' })
    expect(failures).toEqual(['network-error'])
  })

  it('does not cool the account for a policy-blocked stream', async () => {
    // SAFETY is a content-level verdict: request-error (no-op) at account
    // level, terminal UPSTREAM for DSH.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}]',
      'data: [DONE]',
    ]), { status: 200 })))
    const failures: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind) => { failures.push(kind) },
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({ code: 'UPSTREAM' })
    expect(failures).toEqual(['request-error'])
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

  it('resends once under a fresh session id when the upstream hits the 1M wall', async () => {
    const bodies: Array<{ request: { sessionId?: string } }> = []
    const wall =
      '{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed for the model: 1048576"}}'
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      // First attempt reports the per-session accumulation wall; the resend must
      // succeed, which only happens if the derived session id actually changed.
      if (bodies.length === 1) return new Response(wall, { status: 400 })
      return new Response(sseStream(['data: [DONE]']), { status: 200 })
    }))

    const failures: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind) => { failures.push(kind) },
    })
    for await (const _ of adapter.stream(generateOptions({ sessionId: 'session-1' as never }))) void _

    expect(bodies).toHaveLength(2)
    const first = bodies[0]!.request.sessionId
    const second = bodies[1]!.request.sessionId
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    // A different upstream session is the whole recovery mechanism.
    expect(second).not.toBe(first)
    // The account is healthy — this is a session-scoped wall, not an account
    // fault, so it must not cool or rotate the account.
    expect(failures).toEqual([])
  })

  it('carries the request id in the body, and sends no request-id header', async () => {
    // The id used to be stamped in two places. `toAgyRequestBody` and
    // `buildRequestHeaders` each generated their own, so one request carried
    // `body.requestId` != `x-goog-request-id` — a shape no client produces, and
    // invisible to any test that looked at one side only. The body's field is the
    // one that survived, because `x-goog-request-id` is present in neither
    // official binary.
    const seen: Array<{ header: string | null; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        header: new Headers(init?.headers as HeadersInit).get('x-goog-request-id'),
        body: JSON.parse(String(init?.body)) as { requestId?: string },
      })
      return new Response(sseStream(['data: [DONE]']), { status: 200 })
    }))

    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    for await (const _ of adapter.stream(generateOptions())) void _

    expect(seen).toHaveLength(1)
    expect((seen[0]!.body as { requestId?: string }).requestId).toMatch(/^agent\/\d+\/[0-9a-f]{8}$/)
    expect(seen[0]!.header).toBeNull()
  })

  it('gives a resent attempt its own request id', async () => {
    // The 1M-wall resend is a second upstream request, so it must not repeat the
    // first one's id — that would look like a replayed request.
    const seen: Array<{ requestId?: string; sessionId?: string }> = []
    const wall =
      '{"error":{"code":400,"message":"The input token count exceeds the maximum number of tokens allowed for the model: 1048576"}}'
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { requestId?: string; request: { sessionId?: string } }
      seen.push({
        requestId: body.requestId,
        sessionId: body.request.sessionId,
      })
      if (seen.length === 1) return new Response(wall, { status: 400 })
      return new Response(sseStream(['data: [DONE]']), { status: 200 })
    }))

    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    for await (const _ of adapter.stream(generateOptions({ sessionId: 'session-1' as never }))) void _

    expect(seen).toHaveLength(2)
    expect(seen[0]!.requestId).toBeDefined()
    expect(seen[1]!.requestId).not.toBe(seen[0]!.requestId)
    // Same rule for the upstream session: the resend names a fresh one.
    expect(seen[1]!.sessionId).not.toBe(seen[0]!.sessionId)
  })

  it('sends exactly one client User-Agent on the wire, for a real request', async () => {
    // The `buildRequestHeaders` test above asserts the object it returns; this one
    // asserts what the dispatch actually hands to `fetch`. That distinction is the
    // whole reason the original defect survived: the duplicate header was produced
    // by a spread inside `buildRequestHeaders`, but a re-introduced merge at the
    // fetch call site would satisfy an object-level test and still announce this
    // tool on every generation request.
    const seen: Array<string | null> = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers as HeadersInit).get('user-agent'))
      return new Response(sseStream(['data: [DONE]']), { status: 200 })
    }))

    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    for await (const _ of adapter.stream(generateOptions())) void _

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(session().impersonation['User-Agent'])
    expect(seen[0]).not.toContain('deepseek-harness')
    // The comma-joined pair is the exact shape the old spread produced.
    expect(seen[0]).not.toContain(',')
  })

  it('does not resend an ordinary 400 under a bumped session id', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        '{"error":{"code":400,"message":"Request contains an invalid argument."}}',
        { status: 400 },
      )
    }))

    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions({ sessionId: 'session-1' as never }))) void _
    }).rejects.toMatchObject({ code: 'UPSTREAM' })
    // Resending a malformed payload changes nothing but the session id.
    expect(bodies).toHaveLength(1)
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

  it('treats a 403 verification challenge as recoverable, not as a dead credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'VALIDATION_REQUIRED',
        details: [{ metadata: { validation_url: 'https://accounts.google.com/verify?t=abc' } }],
      },
    }), { status: 403 })))

    const seen: Array<{ kind: string; url?: string }> = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async (kind, _session, info) => { seen.push({ kind, url: info?.verificationUrl }) },
    })

    // INVALID_CREDENTIAL would tell the user their login is dead and disable the
    // account; this signal means "verify, then come back".
    let thrown: { code?: string; failure?: { providerRetryAfterMs?: number } } | undefined
    try {
      for await (const _ of adapter.stream(generateOptions())) void _
    } catch (error) {
      thrown = error as typeof thrown
    }

    expect(thrown?.code).toBe('RATE_LIMIT')
    // No delay may be fed to the harness. The account park IS the cooldown, and
    // `llm-retry` gives up outright when `providerRetryAfterMs > maxDelayMs`
    // (`mode: 'normal'` -> `next()`), so the 15-minute value that used to be set
    // here turned a recoverable challenge into a failed turn instead of letting
    // DSH retry onto another account. Pinned because re-adding it looks helpful.
    expect(thrown?.failure?.providerRetryAfterMs).toBeUndefined()

    expect(seen).toEqual([{ kind: 'verification-required', url: 'https://accounts.google.com/verify?t=abc' }])
  })

  it('surfaces the appeal link in the failure message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 403, message: 'VALIDATION_REQUIRED', details: [{ metadata: { appeal_url: 'https://appeal.example/x' } }] },
    }), { status: 403 })))

    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toThrow(/https:\/\/appeal\.example\/x/)
  })

  it('releases the in-flight slot when a consumer abandons the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream(['data: [DONE]']), { status: 200 })))

    const events: string[] = []
    const account = { email: 'a@b.c', refresh: 'rt|p', projectId: 'p', addedAt: 0, lastUsed: 0 }
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      noteRequestStarted: (a) => events.push(`start:${a.email}`),
      noteRequestSettled: (a) => events.push(`settled:${a.email}`),
    })

    // Consume one chunk then break: the async generator's `finally` must still run
    // the release, or the counter leaks and the account is deprioritized forever.
    for await (const _ of adapter.stream(generateOptions())) break
    expect(events).toContain(`start:${account.email}`)
    expect(events).toContain(`settled:${account.email}`)
  })

  it('releases the in-flight slot when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })))

    const events: string[] = []
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      noteRequestStarted: () => events.push('start'),
      noteRequestSettled: () => events.push('settled'),
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toMatchObject({ code: 'SERVER' })
    expect(events).toEqual(['start', 'settled'])
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

  it('hides disabled models from listModels but keeps them in listAllModels', async () => {
    // This pairing is the model-toggle contract: the selector reads listModels
    // (filtered), while the settings page reads listAllModels (unfiltered) so a
    // hidden model is still listed next to the switch that un-hides it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: {} }), { status: 200 })))
    const hidden = new Set(['gemini-2.5-flash'])
    const adapter = new AgyAdapter({
      getSession: async () => undefined,
      reportFailure: async () => {},
      modelVisibility: { disabledFor: () => hidden },
    })
    const visible = await adapter.listModels('agy')
    const all = await adapter.listAllModels()
    expect(all.some((model) => model.id === 'gemini-2.5-flash')).toBe(true)
    expect(visible.some((model) => model.id === 'gemini-2.5-flash')).toBe(false)
    expect(visible.length).toBe(all.length - 1)
  })

  it('returns the full catalog when nothing is disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: {} }), { status: 200 })))
    const adapter = new AgyAdapter({
      getSession: async () => undefined,
      reportFailure: async () => {},
      modelVisibility: { disabledFor: () => new Set<string>() },
    })
    const visible = await adapter.listModels('agy')
    const all = await adapter.listAllModels()
    expect(visible.map((model) => model.id)).toEqual(all.map((model) => model.id))
  })

  it('caches listAllModels across multiple calls within the TTL, avoiding duplicate network requests', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      models: {
        'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash' },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const adapter = new AgyAdapter({
      getSession: async () => session({
        auth: { access: 'token-123', refresh: 'r', expires: Date.now() + 3600000 },
      }),
      reportFailure: async () => {},
    })

    // First call fetches from upstream
    const first = await adapter.listModels('agy')
    expect(first.some((m) => m.id === 'gemini-3.8-flash-tiered')).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Repeated calls (e.g. DSH 0.2.0-rc.1 selectModel -> requireModel -> listModels on each model/effort change)
    const second = await adapter.listModels('agy')
    const third = await adapter.listAllModels()
    expect(second).toBe(first)
    expect(third).toBe(first)
    // No new network requests were fired
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Forced refresh bypasses cache
    await adapter.listAllModels(true)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('drops the cached model list on invalidateModelCache, re-probing on the next call', async () => {
    // The cache is keyed to no account, so the events that switch the account
    // discovery rides (activation, rotation) must drop it explicitly — this is
    // the invalidation the session manager and the activate RPC call.
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      models: { 'gemini-3.8-flash-tiered': { displayName: 'Gemini 3.8 Flash' } },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const adapter = new AgyAdapter({
      getSession: async () => session({
        auth: { access: 'token-123', refresh: 'r', expires: Date.now() + 3600000 },
      }),
      reportFailure: async () => {},
    })

    await adapter.listAllModels()
    await adapter.listAllModels()
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    adapter.invalidateModelCache()
    await adapter.listAllModels()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('records one usage sample per generation, with its token buckets', async () => {
    const recorded: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":120,"cachedContentTokenCount":20,"candidatesTokenCount":7}}]',
      'data: [DONE]',
    ]), { status: 200 })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      recordUsage: (sample) => { recorded.push(sample as Record<string, unknown>) },
    })
    for await (const _ of adapter.stream(generateOptions())) void _

    expect(recorded).toHaveLength(1)
    const sample = recorded[0] as {
      ok: boolean
      model?: string
      account?: string
      usage?: { input: number, output: number, cacheRead: number }
    }
    expect(sample.ok).toBe(true)
    expect(sample.account).toBe('a@b.c')
    // Buckets stay disjoint: input is uncached only (120 total minus 20 cached).
    expect(sample.usage).toMatchObject({ input: 100, output: 7, cacheRead: 20 })
  })

  it('records a failed attempt without token usage', async () => {
    const recorded: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 403 })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      recordUsage: (sample) => { recorded.push(sample as Record<string, unknown>) },
    })
    await expect(async () => {
      for await (const _ of adapter.stream(generateOptions())) void _
    }).rejects.toThrow()

    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.ok).toBe(false)
    expect(recorded[0]?.usage).toBeUndefined()
  })

  it('never lets a usage-recording failure break a generation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(sseStream([
      'data: [{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}]',
      'data: [DONE]',
    ]), { status: 200 })))
    const adapter = new AgyAdapter({
      getSession: async () => session(),
      reportFailure: async () => {},
      recordUsage: () => { throw new Error('ledger exploded') },
    })
    const chunks: unknown[] = []
    for await (const chunk of adapter.stream(generateOptions())) chunks.push(chunk)
    expect(chunks.length).toBeGreaterThan(0)
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

  it('prepareCall binds model and stream to one generation (inherited from LlmAdapter)', async () => {
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
