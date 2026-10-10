/**
 * Translate a DSH GenerateOptions into the Antigravity wrapped request.
 *
 * Envelope shape follows the actively-maintained OmniRoute wire format
 * (the archived opencode reference predates it): top-level `project`,
 * `requestId`, `model`, `userAgent`, `requestType`, with the Gemini-style
 * body under `request` (contents/systemInstruction/tools/generationConfig/
 * sessionId). `toolConfig` VALIDATED is attached when tools are present, and
 * Claude-path requests strip trailing model turns (Vertex rejects "assistant
 * message prefill").
 *
 * Thinking blocks are carried as-is on the Gemini path (Gemini `thought`
 * parts); no thought is ever re-signed — that signature dance was an artifact
 * of the reference plugin's interception architecture (see
 * docs/ARCHITECTURE.md). The Claude path is stricter and drops thought parts
 * entirely, because its validator demands a real thinking signature that only
 * the originating model can produce (docs/ANTIGRAVITY-API.md §3.3).
 */

import { createHash } from 'node:crypto'
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { generateAntigravityRequestId } from '../runtime/identity.ts'
import { getThoughtSignature, THOUGHT_SIGNATURE_SENTINEL } from '../runtime/signature-cache.ts'
import { catalogModel, isLevelThinkingModel } from './catalog.ts'
import { isClaudeModel, supportsMultimodalFiles, type AgyResolvedMultimodalFile } from './multimodal.ts'
import {
  conversationMessages,
  normalizeMessages,
  systemTextFromMessages,
  type AgyBlockView,
  type AgyMessageView,
} from './dsh-view.ts'

export { isClaudeModel, supportsMultimodalFiles }
export type { AgyResolvedMultimodalFile }

export type AgyPart =
  | { text: string }
  | { thought: true; text: string }
  | { thoughtSignature: string; functionCall: { id: string; name: string; args: unknown } }
  | { functionResponse: { id: string; name: string; response: unknown } }
  | { inlineData: { mimeType: string; data: string } }

/** Image bytes pre-resolved from the durable attachment store, keyed by attachment id. */
export interface AgyResolvedImage {
  mediaType: string
  /** Pure base64 (no data: prefix). */
  data: string
}

export interface AgyContent {
  role: 'user' | 'model'
  parts: AgyPart[]
}

export interface AgyRequestBody {
  project?: string
  requestId?: string
  model: string
  userAgent?: string
  requestType?: 'agent'
  request: {
    contents: AgyContent[]
    systemInstruction?: { parts: Array<{ text: string }> }
    tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parameters: unknown }> }>
    toolConfig?: { functionCallingConfig: { mode: 'VALIDATED' } }
    generationConfig?: {
      temperature?: number
      maxOutputTokens?: number
      stopSequences?: string[]
      thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean; thinkingBudget?: number }
    }
    sessionId?: string
  }
}

// isClaudeModel is imported from ./multimodal.ts and re-exported above

/**
 * Vertex (the Antigravity Claude backend) rejects conversations ending on an
 * assistant/model turn ("assistant message prefill"); never strip to empty.
 */
export function stripTrailingModelTurn(contents: AgyContent[]): AgyContent[] {
  while (contents.length > 1 && contents[contents.length - 1]?.role === 'model') {
    contents.pop()
  }
  return contents
}

/**
 * The Antigravity backend parses tool `parameters` as a strict protobuf
 * schema and rejects ANY unknown keyword with 400 (verified empirically:
 * `$schema`, `propertyNames`, `pattern`, `minLength`, ... each fail in turn).
 * Denylisting is whack-a-mole, so keep only the keywords the upstream
 * accepts. Container shapes are handled distinctly: `properties` is a
 * name->schema map (keys preserved), `items`/`additionalProperties` are
 * nested schemas (additionalProperties also accepts a boolean — live-verified
 * against the Antigravity upstream), `required`/`enum` are plain arrays.
 *
 * Keyword VALUES are also constrained by the protobuf shape (verified
 * empirically): `type` must be a single enum string (union arrays like
 * `["string","number"]` are rejected) and every `enum` item must be a
 * non-empty string (booleans/numbers/empty strings are rejected). Values are
 * normalized to the nearest valid form instead of being dropped wholesale.
 *
 * Schema SHAPE is constrained too: an `array` schema with no `items` is
 * rejected outright — `GenerateContentRequest.tools[0].functionDeclarations
 * [N].parameters.properties[steps].items: missing field` — because protobuf
 * Schema has no "any item" form, so the field cannot be absent. JSON Schema
 * itself allows it (DSH's enforced subset documents `items` as optional), and
 * a hand-written tool parameter map drops it as easily as it writes it, so
 * the sanitizer supplies `{"type":"string"}` for a missing `items` — the
 * shape the register already declares by hand whenever an author spells it
 * out (`{type:'array', items:{type:'string'}}`), and permissive in the same
 * way a missing `items` is: the tool's own argument validation never depends
 * on it. An `items` that EXISTS but carries no `type` is equally rejected, so
 * a nested schema with neither `type` nor `properties` is typed `string` too.
 */
// Exported for the contract invariant test (tests/adapter.test.ts); not part of
// the package public API (translate.ts is an internal module).
export const AGY_SCHEMA_ALLOWLIST = new Set([
  'type', 'format', 'title', 'description', 'nullable',
  'items', 'enum', 'default', 'properties', 'required', 'additionalProperties',
])
const AGY_SCHEMA_MAP_KEYS = new Set(['properties'])
const AGY_SCHEMA_NESTED_KEYS = new Set(['items', 'additionalProperties'])
const AGY_SCHEMA_LIST_KEYS = new Set(['required', 'enum'])

/** The item schema substituted for an `array` whose author declared no `items`. */
const AGY_MISSING_ITEMS_SCHEMA: Record<string, unknown> = { type: 'string' }

/**
 * Give an `array` schema an `items` the protobuf parser accepts, and give a
 * nested schema that declares neither `type` nor `properties` one it accepts
 * (see the shape paragraph on the contract above). Purely additive: a schema
 * that already carries either stays byte-identical.
 */
function ensureItemSchema(node: Record<string, unknown>): void {
  if (node.type !== 'array' || 'items' in node) return
  node.items = { ...AGY_MISSING_ITEMS_SCHEMA }
}

/**
 * The `items` (or typed `additionalProperties`) slot must itself be typed;
 * `{}`, `{description:'x'}` and a keywords-only union carrier all arrive here
 * and are rejected as `missing field`. A `properties`-bearing schema is left
 * alone — its `type` is inferred by the same rule that lets an untyped object
 * schema through elsewhere. `additionalProperties: true|false` is a boolean
 * and never reaches this function.
 */
function ensureNestedType(node: Record<string, unknown>): void {
  if ('type' in node || 'properties' in node) return
  node.type = 'string'
}

function sanitizeToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map((entry) => sanitizeToolSchema(entry))

  // Normalize union types: upstream `type` is a single enum string. Pick the
  // first non-null string type (`"null"` maps to the `nullable` keyword);
  // fall back to `string` when no usable type remains.
  let normalized = schema as Record<string, unknown>
  if (Array.isArray(normalized.type)) {
    const types = normalized.type.filter((t): t is string => typeof t === 'string' && t !== 'null')
    normalized = { ...normalized, type: types[0] ?? 'string' }
  }

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(normalized)) {
    if (!AGY_SCHEMA_ALLOWLIST.has(key)) continue
    if (AGY_SCHEMA_MAP_KEYS.has(key)) {
      const map: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        map[name] = sanitizeToolSchema(child)
      }
      result[key] = map
      continue
    }
    if (AGY_SCHEMA_NESTED_KEYS.has(key)) {
      const nested = sanitizeToolSchema(value)
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const nestedRecord = nested as Record<string, unknown>
        ensureNestedType(nestedRecord)
        if (key === 'items') ensureItemSchema(nestedRecord)
      }
      result[key] = nested
      continue
    }
    if (AGY_SCHEMA_LIST_KEYS.has(key)) {
      // Upstream `enum` items must be non-empty strings; filter the rest
      // and omit an empty enum entirely (an empty array would be rejected too).
      if (key === 'enum' && Array.isArray(value)) {
        const filtered = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
        if (filtered.length > 0) result[key] = filtered
      } else {
        result[key] = value
      }
      continue
    }
    result[key] = value
  }
  ensureItemSchema(result)
  return result
}

/**
 * Every name a tool-call id was ever seen with, in document order, plus how
 * many of them have already been answered.
 *
 * A tool-call id is NOT unique across a conversation: `parse.ts` falls back to
 * `String(blockIndex)` when the upstream omits `functionCall.id` and that block
 * counter restarts at 0 for every stream, so two distant turns routinely answer
 * the same id (issue #99). A single `Map<string, string>` therefore had to
 * declare a winner with last-write-wins, and an earlier turn's result was
 * emitted with a LATER turn's tool name — which Google rejects with 400
 * `INVALID_ARGUMENT`, permanently, because retrying replays the same history.
 *
 * The cursor rather than a `shift()`: consuming from the front of a shared array
 * would destroy the record the drained fallback below needs.
 */
interface ToolNameIndexEntry {
  readonly names: readonly string[]
  /** How many of `names` have been handed to a result already. */
  cursor: number
}

type ToolNameIndex = Map<string, ToolNameIndexEntry>

/**
 * Collect tool-call names by id so tool results can name their function.
 *
 * Names are PUSHED rather than set, so a repeated id keeps every occurrence in
 * document order; resolution consumes them FIFO (see {@link resolveToolName}).
 */
function buildToolNameIndex(messages: readonly AgyMessageView[]): ToolNameIndex {
  const index: ToolNameIndex = new Map()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool-call') {
        const entry = index.get(block.id)
        if (entry) (entry.names as string[]).push(block.name)
        else index.set(block.id, { names: [block.name], cursor: 0 })
      }
    }
  }
  return index
}

/**
 * The name one `functionResponse` must carry, or undefined when the id answers
 * no recorded call (the caller then falls back to the raw id, as it always did).
 *
 * FIFO per id: the calls recorded under an id are consumed in the order the
 * results arrive in, so each result meets its OWN call even when the id
 * repeats. Distinct ids never interact — the two cases a single-valued index
 * conflated (a repeated id across distant turns, and two calls sharing one id
 * inside one assistant turn) are handled by the same queue.
 *
 * Drained (more results than calls — a call dropped from the history while its
 * result survived) is the one case with nothing left to pair: guessing the LAST
 * name recorded for the id beats the pre-fix behaviour in both directions. The
 * old lookup answered every extra result with that same last name, which was
 * right whenever the repeated calls were the same tool and wrong the moment
 * they were not; answering with the raw id instead would be wrong EVERY time,
 * because an id is not a function name and upstream rejects it outright. So the
 * last name is kept, and only a never-recorded id falls through to the raw id.
 */
function resolveToolName(toolNames: ToolNameIndex, toolCallId: string): string | undefined {
  const entry = toolNames.get(toolCallId)
  if (entry === undefined) return undefined
  if (entry.cursor < entry.names.length) {
    const name = entry.names[entry.cursor]
    entry.cursor += 1
    return name
  }
  return entry.names[entry.names.length - 1]
}

/**
 * The single producer of a `functionResponse` part.
 *
 * Both supported dsh-llm vocabularies funnel through here: a 0.1.5
 * `tool-result` CONTENT BLOCK and a 0.2.0 `tool`-ROLE message describe the same
 * result, and this channel's wire shape must not depend on which one arrived.
 */
function toolResultPart(
  toolCallId: string,
  isError: boolean,
  content: readonly AgyBlockView[],
  toolNames: ToolNameIndex,
): AgyPart {
  const name = resolveToolName(toolNames, toolCallId) ?? toolCallId
  const text = content
    .filter((block): block is Extract<AgyBlockView, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return {
    functionResponse: {
      // The Anthropic-backed Claude path requires tool_result.tool_use_id
      // and 400s without it ("messages.N.content.M.tool_result.tool_use_id:
      // Field required"); the Gemini path accepts the id too, so it is
      // always carried rather than branched per family (live-verified).
      id: toolCallId,
      name,
      response: { result: text, is_error: isError },
    },
  }
}

function blockToParts(
  block: AgyBlockView,
  toolNames: ToolNameIndex,
  images: Map<string, AgyResolvedImage>,
  /** Claude path: replayed thought blocks are rejected outright (see below). */
  dropThoughts = false,
): AgyPart[] {
  switch (block.type) {
    case 'text':
      // An empty text part is rejected by the Anthropic-backed Claude path
      // ("messages.N.content.M.text.text: Field required") while the Gemini
      // path tolerates it. Upstream's own parts normalization drops empty
      // text, so drop it here for every family (live-verified). DSH emits
      // these as trailing zero-length blocks after a tool call.
      return block.text === '' ? [] : [{ text: block.text }]
    case 'reasoning':
      // Empty thought: same rejection class as `text` ("thinking.thinking:
      // Field required").
      if (block.text === '') return []
      // A replayed thought block cannot be sent to the Claude path at all: the
      // backend demands a thinking `signature`, and the
      // `skip_thought_signature_validator` sentinel that works for functionCall
      // parts is rejected here as an invalid signature (live-verified). Only
      // the model that produced the thought could re-sign it, so a thought that
      // came from another family (e.g. a mid-session switch from a Gemini
      // tiered model) has no valid form — drop it rather than 400. Gemini
      // accepts replayed thoughts, so this is Claude-only.
      if (dropThoughts) return []
      return [{ thought: true, text: block.text }]
    case 'tool-call': {
      // Upstream parses functionCall.args as google.protobuf.Struct and
      // rejects a raw string with 400. Guarantee an object: parse the string
      // form, fall back to {} when it is truncated/malformed (the failure
      // mode for long multi-turn histories).
      let args: unknown = {}
      if (typeof block.arguments === 'object' && block.arguments !== null && !Array.isArray(block.arguments)) {
        args = block.arguments
      } else if (typeof block.arguments === 'string') {
        try {
          const parsed: unknown = JSON.parse(block.arguments)
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            args = parsed
          }
        } catch {
          // truncated/malformed JSON -> empty object
        }
      }
      // Antigravity rejects functionCall parts without a thoughtSignature
      // (400). Replay the signature captured for this tool call id on the
      // previous turn; the sentinel is the established bypass when nothing is
      // cached (both reference implementations default to it).
      //
      // OPEN QUESTION, deliberately not changed yet: another implementation of
      // this client stamps the sentinel ONLY on the FIRST functionCall of a model
      // turn and leaves sibling calls unsigned ("unsigned sibling functionCalls
      // preserve native parallel-call shape"), and never synthesizes a bypass
      // signature anywhere else. This path stamps every call. Which is right is
      // unverified for THIS channel — the sentinel is live-verified to work here,
      // and a wrong change turns working parallel tool calls into 400s — so it
      // needs one real multi-tool turn measured before any edit.
      const signature = getThoughtSignature(block.id) ?? THOUGHT_SIGNATURE_SENTINEL
      return [{
        thoughtSignature: signature,
        functionCall: { id: block.id, name: block.name, args },
      }]
    }
    case 'tool-result':
      return [toolResultPart(
        block.toolCallId,
        block.isError === true,
        block.content,
        toolNames,
      )]
    case 'image': {
      // Bytes are pre-resolved by the adapter before translation; a missing
      // entry breaks that invariant and must fail loudly, never silently drop.
      const resolved = images.get(block.attachment.attachmentId)
      if (!resolved) {
        throw new Error(`agy translate: unresolved image attachment "${block.attachment.attachmentId}"`)
      }
      return [{ inlineData: { mimeType: resolved.mediaType, data: resolved.data } }]
    }
    default:
      return [] // unknown block types (merge-extensible) are skipped
  }
}

function messageToContent(
  message: AgyMessageView,
  toolNames: ToolNameIndex,
  images: Map<string, AgyResolvedImage>,
  multimodalFiles?: Map<string, AgyResolvedMultimodalFile[]>,
  messageIndex?: number,
  dropThoughts = false,
): AgyContent | null {
  // 0.2.0 promotes a tool result to a `tool`-ROLE message, with the correlation
  // (`toolCallId`/`isError`) on the message instead of on a `tool-result` block.
  // It projects to the same wire part, and a `functionResponse` always belongs
  // to a user-side turn on this channel.
  if (message.role === 'tool') {
    if (message.toolCallId === undefined) {
      // Uncorrelated: the Claude path 400s without an id, and inventing one
      // would mis-address a real call. Dropped like any other unreadable shape.
      return null
    }
    return {
      role: 'user',
      parts: [toolResultPart(message.toolCallId, message.isError === true, message.content, toolNames)],
    }
  }

  const parts = message.content.flatMap((block) =>
    // Non-user images are out of scope by policy (docs ANTIGRAVITY-API §3.2):
    // skip them like any other untranslatable block instead of tripping the
    // unresolved-map guard, which protects only the user-image invariant.
    block.type === 'image' && message.role !== 'user'
      ? []
      : blockToParts(block, toolNames, images, dropThoughts),
  )

  if (message.role === 'user' && multimodalFiles) {
    const files =
      (message.id ? multimodalFiles.get(message.id) : undefined) ??
      (multimodalFiles as Map<unknown, AgyResolvedMultimodalFile[]>).get(message) ??
      (messageIndex !== undefined ? multimodalFiles.get(`msg-${messageIndex}`) : undefined) ??
      (messageIndex !== undefined ? multimodalFiles.get(String(messageIndex)) : undefined)

    if (files) {
      for (const file of files) {
        parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } })
      }
    }
  }

  if (parts.length === 0) return null
  const role = message.role === 'assistant' ? 'model' : 'user'
  return { role, parts }
}

/**
 * Whether a part makes its turn a tool-result turn (`functionResponse` family).
 * Every other part kind — text, media, thought, functionCall — belongs to the
 * ordinary-content family.
 */
function isFrPart(part: AgyPart): boolean {
  return 'functionResponse' in part
}

/**
 * Merge adjacent same-role contents into single turns, functionResponse-family
 * aware.
 *
 * The harness emits a fragmented per-step vocabulary — prompt, runtime-context
 * snapshot, and injected `<system-reminder>` messages as separate `user`
 * messages, one message per tool result — and its own first-party serializer
 * coalesces adjacent same-role messages at the wire boundary. Forwarding the
 * fragments 1:1 instead opened every request with a run of `user` turns that
 * all belong to one logical prompt, and sent parallel tool results as separate
 * one-`functionResponse` turns where the official Gemini tooling groups them
 * into a single user turn.
 *
 * Family rule: a turn carrying `functionResponse` parts never merges with (or
 * receives) other part kinds, so a mixed content is segmented in part order.
 * The harness's serializer instead re-sorts tool results to the front of one
 * merged message, but the Gemini-family validator is measured to reject a user
 * content mixing `functionResponse` with text (400; langchainjs#11445, on the
 * model family), and this channel's tolerance for the mixed shape is
 * unmeasured. Separate adjacent turns keep every part while keeping each turn
 * unmixed; parts are never reordered.
 *
 * Known boundary loss (pinned in tests): a model turn whose parts all drop
 * (thoughts-only turn replayed on the Claude path) is filtered to null before
 * this point, so the user turns around it fuse into one content. A text
 * placeholder would fabricate a model utterance, and the acceptance of a
 * structural empty turn (`parts: []`) is unmeasured here — so the fusion
 * stands (issue #93).
 */
export function coalesceContents(contents: AgyContent[]): AgyContent[] {
  const result: AgyContent[] = []
  let lastFamily: boolean | undefined
  for (const content of contents) {
    for (const part of content.parts) {
      const family = isFrPart(part)
      const last = result[result.length - 1]
      if (last && lastFamily === family && last.role === content.role) {
        last.parts.push(part)
      } else {
        result.push({ role: content.role, parts: [part] })
        lastFamily = family
      }
    }
  }
  return result
}

/**
 * Builtin Gemini tools must not shadow functionDeclarations names (upstream
 * treats them as native tools; verified by OmniRoute's GEMINI_BUILTIN_TOOL_NAMES).
 */
const AGY_BUILTIN_TOOL_NAMES = new Set(['google_search', 'web_search', 'search_web', 'googleSearch'])

/** Level-thinking: single id + selectable low/medium/high via thinkingLevel (catalog thinking:'level'). */
const LEVEL_THINKING_LEVELS = new Set(['low', 'medium', 'high'])

/**
 * Claude-family output ceiling on the Antigravity channel (live-measured).
 *
 * The Claude models are served through the Gemini-style
 * `generationConfig.maxOutputTokens` field here, and this channel rejects the
 * Claude family above 64000: 64000 answers 200, 64001 answers 400
 * `INVALID_ARGUMENT: Request contains an invalid argument` (deterministic
 * across both Claude ids, with and without the full 87-tool payload). The
 * Gemini family accepts 65536 on the same endpoint, so the limit is
 * model-family-specific, not endpoint-wide.
 *
 * Do NOT reason about this number from Anthropic's public API limits. Agy may
 * front a self-hosted or otherwise gated Claude deployment whose capacity and
 * validation rules are its own; the only authority is what this channel
 * accepts, which is what the probe measures. The value here is that
 * measurement, nothing more.
 *
 * The catalog's `maxOutputTokens` is the harness-injected default
 * (`LlmResolvedModelInfo.defaultMaxTokens`), so a wrong value there makes every
 * Claude request fail. This clamp is the second line of defense: it also covers
 * an explicit `maxTokens` (agent preset / call config) and a dynamically
 * discovered Claude id absent from the pinned catalog.
 */
export const AGY_CLAUDE_MAX_OUTPUT_TOKENS = 64_000

/** Upstream functionDeclarations names are `[a-zA-Z0-9_]` and ≤64 chars (OmniRoute-verified). */
const AGY_TOOL_NAME_MAX_LENGTH = 64

/** Sanitize a tool name to the upstream charset/length; dedupe via a short hash. */
function sanitizeToolName(name: string, seen: Set<string>): string {
  let candidate = name.replace(/[^a-zA-Z0-9_]/g, '_') || 'tool'
  if (candidate.length > AGY_TOOL_NAME_MAX_LENGTH || seen.has(candidate)) {
    const hash = createHash('sha256').update(candidate).digest('hex').slice(0, 8)
    const prefix = candidate.slice(0, AGY_TOOL_NAME_MAX_LENGTH - hash.length - 1)
    candidate = `${prefix}_${hash}`
    let i = 2
    while (seen.has(candidate)) candidate = `${prefix}_${i++}_${hash}`
  }
  seen.add(candidate)
  return candidate
}

function toolsToDeclarations(tools: ToolSchema[] | undefined): AgyRequestBody['request']['tools'] {
  if (!tools || tools.length === 0) return undefined
  const seenNames = new Set<string>()
  const declarations = []
  for (const tool of tools) {
    if (AGY_BUILTIN_TOOL_NAMES.has(tool.name)) continue
    declarations.push({
      name: sanitizeToolName(tool.name, seenNames),
      description: tool.description,
      parameters: sanitizeToolSchema(tool.parameters),
    })
  }
  if (declarations.length === 0) return undefined
  return [{ functionDeclarations: declarations }]
}

/** Build the wrapped Antigravity request body for one call. */
export function toAgyRequestBody(
  options: GenerateOptions,
  context: {
    projectId?: string
    sessionId?: string
    images?: Map<string, AgyResolvedImage>
    multimodalFiles?: Map<string, AgyResolvedMultimodalFile[]>
    /**
     * The request id, when the caller also stamps it on the wire
     * (`x-goog-request-id`). Generating it here as well produced TWO different
     * ids for one request — the body and the header disagreed, a shape no client
     * produces. Callers that send the header must pass the same value.
     */
    requestId?: string
    /**
     * A configured token budget for a reasoning level, or undefined to leave the
     * level's own budget to upstream.
     *
     * When this returns a number the budget REPLACES `thinkingLevel` rather than
     * joining it, because measurement shows the level wins when both are sent:
     * `{thinkingLevel:"low", thinkingBudget:16000}` spends what `low` alone
     * spends (~180 thoughts, against ~330 for the budget alone), and
     * `{thinkingLevel:"high", thinkingBudget:1000}` likewise tracks `high`
     * (~316 vs ~173). Sending both would therefore make a configured number
     * silently inert, which is worse than not offering the setting.
     */
    thinkingBudgetFor?: (level: string) => number | undefined
    /**
     * The configured Claude thinking budget, or undefined when unset.
     *
     * A single value, not a per-level map: the Claude family is id-bound (each
     * capability is its own model id with no level selector), so there is no
     * level to key by.
     */
    claudeBudgetFor?: () => number | undefined
    /**
     * The configured budget for the TIERED slot (the selector's "Default"
     * effort), or undefined when unset.
     *
     * That effort arrives with NO level id, so it cannot go through
     * `thinkingBudgetFor`. A value here sends a bare `thinkingBudget` with no
     * `thinkingLevel` — the tiered model's adaptive entry, given an explicit cap.
     */
    tieredBudgetFor?: () => number | undefined
  },
): AgyRequestBody {
  const messages = normalizeMessages(options.messages)
  const toolNames = buildToolNameIndex(messages)
  const images = context.images ?? new Map<string, AgyResolvedImage>()
  const multimodalFiles = supportsMultimodalFiles(options.model) ? context.multimodalFiles : undefined
  const claude = isClaudeModel(options.model)
  let contents = coalesceContents(
    conversationMessages(messages)
      .map((message, index) => messageToContent(message, toolNames, images, multimodalFiles, index, claude))
      .filter((c): c is AgyContent => c !== null),
  )
  if (claude) {
    contents = stripTrailingModelTurn(contents)
  }

  // `options.system` is the one-shot channel and is undefined for a loop-built
  // request, whose derived history carries the prompt as a `system`-role message
  // (documented identically on both supported dsh-llm lines). Both sources feed
  // the system slot; routing the message through `contents` instead would put
  // the system prompt on the wire as a USER turn.
  const systemText = [options.system, systemTextFromMessages(messages)]
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .join('\n\n')

  const tools = toolsToDeclarations(options.tools)
  const generationConfig: NonNullable<AgyRequestBody['request']['generationConfig']> = {}
  if (options.temperature !== undefined) generationConfig.temperature = options.temperature
  if (options.maxTokens !== undefined) {
    // Claude family: the platform rejects >64000 with 400, and the value the
    // harness injects comes from the catalog default, so clamp before the wire.
    generationConfig.maxOutputTokens = isClaudeModel(options.model)
      ? Math.min(options.maxTokens, AGY_CLAUDE_MAX_OUTPUT_TOKENS)
      : options.maxTokens
  }
  if (options.stop !== undefined && options.stop.length > 0) generationConfig.stopSequences = options.stop
  // Level-thinking: map the DSH reasoning effort to thinkingConfig.
  // Id-bound models (thinking !== 'level') never emit it, and a tiered model
  // emits NOTHING when no effort is requested — there is deliberately no default
  // level, because "no level chosen" is what lets the model allocate its own
  // thinking (see `LEVEL_REASONING` for why declaring a default broke that).
  // When purpose is 'session-title' or reasoning is off, thinkingBudget: 0 prevents
  // default thinking tokens from exhausting tight output caps (e.g. maxTokens: 64).
  const effort = options.reasoningEffort?.toLowerCase()
  if (isLevelThinkingModel(options.model)) {
    if (options.purpose === 'session-title' || effort === 'none' || effort === 'off') {
      generationConfig.thinkingConfig = { thinkingBudget: 0 }
    } else if (effort === undefined) {
      // The selector's "Default" effort: no level was chosen. A configured tiered
      // budget turns this into Max by sending a bare `thinkingBudget` (no
      // `thinkingLevel`, so the number alone decides). Unset sends nothing at all,
      // which leaves upstream's own adaptive allocation in charge.
      const tiered = context.tieredBudgetFor?.()
      if (tiered !== undefined) {
        generationConfig.thinkingConfig = { thinkingBudget: tiered, includeThoughts: true }
      }
    } else if (LEVEL_THINKING_LEVELS.has(effort)) {
      // A configured number for this level takes the place of the level token:
      // both together would let the level win (see `thinkingBudgetFor`).
      const configured = context.thinkingBudgetFor?.(effort)
      generationConfig.thinkingConfig = configured === undefined
        ? { thinkingLevel: effort, includeThoughts: true }
        : { thinkingBudget: configured, includeThoughts: true }
    }
  } else if (claude && options.purpose !== 'session-title') {
    // Claude thinking models are id-bound (no level selector), so their budget is
    // a single configured value rather than one per level. Measured constraints,
    // all of which must hold or the request is a 400:
    //   - `max_tokens` must be STRICTLY greater than the budget. `budget=1024`
    //     with `max_tokens=1024` is rejected, and so is a budget sent with no
    //     `maxOutputTokens` at all.
    //   - the floor is 1024 (not `-1`); the store validates that on save.
    // So a budget that does not leave room is DROPPED rather than forced through
    // by raising `maxTokens`: silently enlarging the caller's output cap would
    // change the request's cost and truncation behaviour, while omitting the
    // budget merely means this turn thinks with upstream's default. A 400 would
    // be worse than either.
    const claudeBudget = context.claudeBudgetFor?.()
    const outputCap = generationConfig.maxOutputTokens
    if (claudeBudget !== undefined && outputCap !== undefined && outputCap > claudeBudget) {
      generationConfig.thinkingConfig = { thinkingBudget: claudeBudget, includeThoughts: true }
    }
  }

  return {
    project: context.projectId || undefined,
    requestId: context.requestId ?? generateAntigravityRequestId(),
    model: options.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: {
      contents,
      ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
      ...(tools ? { tools } : {}),
      ...(tools ? { toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } } : {}),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    },
  }
}
