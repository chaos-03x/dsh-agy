/**
 * Parse Antigravity SSE responses (Gemini-style `candidates[]` events) into the
 * DSH StreamChunk protocol: block-start / text-delta / reasoning-delta /
 * tool-call-delta / block-end / usage / finish.
 *
 * Wire shape: each `data:` payload is a JSON array of candidate objects with
 * `content.parts[]` (text / {thought:true} / functionCall), `usageMetadata`,
 * and `finishReason`. MEASURED (2026-10-03, daily endpoint, 3/3): a normal
 * stream terminates via the candidate `finishReason` alone — the endpoint
 * sends NO `data: [DONE]`; the SSE `[DONE]` convention is accepted but never
 * observed on the wire.
 *
 * Robustness contract: a cut-short stream must FAIL, never masquerade as a
 * completed turn. Three cases throw:
 * - an error body in-band (`data:` prefixed) or BARE (the upstream emits its
 *   `{"error":{...}}` vocabulary without the prefix right before dropping the
 *   connection), including in the final unterminated line;
 * - a clean EOF carrying neither `data: [DONE]` nor any `finishReason`
 *   (either signal alone completes the stream);
 * - an explicit `finishReason` this parser does not map
 *   ({@link UnmappedFinishReasonError}).
 */

import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as DshLlm from '@deepseek-ai/dsh-llm'

// ponytail: DSH 0.0.1-rc.1 exports CallId, 0.1.x renames to ToolCallId — pick whichever exists at runtime
const CallId = ((DshLlm as unknown as { ToolCallId?: (id: string) => unknown }).ToolCallId
  ?? (DshLlm as unknown as { CallId?: (id: string) => unknown }).CallId) as (id: string) => never
if (!CallId) throw new Error('dsh-llm: neither ToolCallId nor CallId found')

export interface SsePart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { id?: string; name?: string; args?: unknown }
}

export interface SseCandidate {
  index?: number
  content?: {
    role?: string
    parts?: SsePart[]
  }
  finishReason?: string
}

/** The upstream error-vocabulary shape, in-band or bare. */
export interface SseError {
  code?: number
  status?: string
  message?: string
}

export interface SsePayload {
  candidates?: SseCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
  error?: SseError
}

/**
 * Parse one SSE `data:` line; returns null for `[DONE]` or empty lines.
 * Accepts the `{"response": {...}}` envelope (daily endpoint wire shape) and
 * the bare array/object shapes older clients emitted.
 */
export function parseSseDataLine(line: string): SsePayload | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  const data = trimmed.slice(5).trim()
  if (data === '' || data === '[DONE]') return null
  const parsed = JSON.parse(data) as unknown
  const root = (parsed as { response?: unknown })?.response ?? parsed
  const payload = (Array.isArray(root) ? root[0] : root) as SsePayload | undefined
  return payload ?? null
}

/**
 * Extract an error body from a line that does not carry the SSE `data:`
 * prefix. The upstream occasionally drops its `{"error":{...}}` vocabulary as
 * a bare JSON line right before terminating the stream — the socket closes
 * cleanly and nothing else surfaces the failure. Returns null for anything
 * that is not a JSON object carrying an `error` object; SSE comments and
 * event/id/retry fields stay skipped.
 */
function extractBareJsonError(line: string): SseError | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    const parsed = JSON.parse(trimmed) as { error?: SseError }
    if (parsed.error && typeof parsed.error === 'object') return parsed.error
  } catch {
    // not JSON (or truncated) — nothing to extract
  }
  return null
}

/**
 * Thrown when the upstream ends a stream with a `finishReason` this parser
 * does not map (SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, ...). A silent
 * default to `stop` presented policy-blocked and malformed-call turns as
 * completed. This is a CONTENT-level verdict, not account health: the adapter
 * reports it as `request-error` (no cooldown, no rotation), never
 * `network-error`.
 */
export class UnmappedFinishReasonError extends Error {
  constructor(readonly reason: string) {
    super(`agy upstream ended the stream with unrecognized finishReason: ${reason}`)
    this.name = 'UnmappedFinishReasonError'
  }
}

/**
 * Thrown when the SSE body produces no bytes for longer than the idle timeout.
 *
 * The streaming dispatcher deliberately runs with `bodyTimeout: 0` (a reasoning
 * pause must not be killed mid-turn), so a connection that stops producing
 * bytes without ever closing has no transport-level reclaim: the read simply
 * never settles and the turn hangs until the user cancels it. The watchdog
 * exists only for that shape.
 */
export class AgyStreamIdleTimeoutError extends Error {
  constructor(readonly idleTimeoutMs: number) {
    super(idleTimeoutMs >= 1000
      ? `agy stream idle timeout: no data received for ${Math.round(idleTimeoutMs / 1000)}s`
      : `agy stream idle timeout: no data received for ${idleTimeoutMs}ms`)
    this.name = 'AgyStreamIdleTimeoutError'
  }
}

/** Silence budget for one body read before the stream is declared stalled. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000

/**
 * Resolve the idle timeout from `DSH_AGY_IDLE_TIMEOUT_MS` (or the `AGY_IDLE_TIMEOUT_MS` alias).
 * Deliberately generous: measured reasoning gaps on a real tunnel reach ~35s, so the default is
 * ~5x that and only a connection that has genuinely stopped trips it. `0` disables the watchdog;
 * negative or non-numeric values fall back to the default rather than silently disabling it.
 */
export function resolveStreamIdleTimeoutMs(): number {
  const dsh = process.env.DSH_AGY_IDLE_TIMEOUT_MS?.trim()
  const agy = process.env.AGY_IDLE_TIMEOUT_MS?.trim()
  const raw = dsh && dsh.length > 0 ? dsh : agy && agy.length > 0 ? agy : undefined
  if (raw === undefined) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  return parsed
}

/**
 * Map the upstream `finishReason` vocabulary onto DSH's. WHITELIST, not
 * blacklist: the completable reasons map to their kinds and every other
 * explicit reason throws. `FINISH_REASON_UNSPECIFIED` is granted `stop` — it
 * carries no information, exactly like the absent field.
 */
function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' }
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
      return { kind: 'stop' }
    case 'TOOL_CALLS':
    case 'FUNCTION_CALL':
      return { kind: 'tool-calls' }
    default:
      throw new UnmappedFinishReasonError(reason)
  }
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

/**
 * Await one body read, failing after `timeoutMs` of silence (0 = no watchdog)
 * or as soon as `signal` aborts.
 *
 * The timer measures the GAP between reads, so any byte resets it: a slow but
 * live generation is untouched, while a connection that died without closing —
 * or an upstream that accepted the request and then went away — fails instead
 * of hanging forever. The abort leg exists for the same reason: without it a
 * cancelled turn keeps waiting out the whole idle window, because the read loop
 * only checks `signal.aborted` BETWEEN reads.
 *
 * Each abandonment rejects BEFORE cancelling the reader, and the order is
 * load-bearing (measured on undici 7 and synthetic streams): the rejection is
 * what settles this race — `reader.cancel()` settles the outstanding read only
 * on a later turn — while the cancel reclaims the connection the streaming
 * dispatcher (`bodyTimeout: 0`) would otherwise leave pinned. The abandoned
 * read rejects with the release error once the caller's `finally` drops the
 * lock, and `Promise.race` is what keeps that rejection handled.
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StreamReadResult> {
  const pending = reader.read()
  if (timeoutMs <= 0 && signal === undefined) return pending
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const watchdog = new Promise<never>((_resolve, reject) => {
    const abandon = (error: Error): void => {
      reject(error)
      void reader.cancel(error).catch(() => {})
    }
    if (signal?.aborted) {
      abandon(new DOMException('aborted', 'AbortError'))
      return
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => abandon(new AgyStreamIdleTimeoutError(timeoutMs)), timeoutMs)
    }
    if (signal) {
      onAbort = () => abandon(new DOMException('aborted', 'AbortError'))
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    return await Promise.race([pending, watchdog])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Consume an SSE text stream and yield StreamChunks. One accumulating block is
 * kept open at a time; tool-call argument deltas accumulate until a different
 * part kind, usage metadata, or stream end closes it.
 */
export interface ParseAgySseOptions {
  signal?: AbortSignal
  /**
   * Milliseconds of silence on the body before the read is abandoned. Defaults
   * to `resolveStreamIdleTimeoutMs()`; 0 disables the watchdog.
   */
  idleTimeoutMs?: number
  /**
   * Invoked when a functionCall part carries a sibling thoughtSignature, and
   * when a thought part carries one, keyed by the functionCall id (or the
   * thought signature is ignored unless paired). The adapter persists these
   * for replay on the next turn (see signature-cache.ts).
   */
  onToolSignature?(toolCallId: string, signature: string): void
}

export async function* parseAgySse(
  body: ReadableStream<Uint8Array>,
  options: ParseAgySseOptions = {},
): AsyncGenerator<StreamChunk> {
  const { signal, idleTimeoutMs = resolveStreamIdleTimeoutMs() } = options
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let blockIndex = 0
  let finishReason: FinishReason = { kind: 'stop' }
  let sawDone = false
  let sawFinishReason = false
  let sawUsage = false
  let lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null = null

  interface OpenBlock {
    kind: 'text' | 'reasoning' | 'tool-call'
    id?: string
    name?: string
    arguments: string
    text: string
  }
  let open: OpenBlock | null = null

  const closeBlock = (): StreamChunk | null => {
    if (!open) return null
    const block: StreamChunk = open.kind === 'tool-call'
      ? {
          type: 'block-end',
          index: blockIndex,
          block: {
            type: 'tool-call',
            id: CallId(open.id ?? `call-${blockIndex}`),
            name: open.name ?? '',
            arguments: open.arguments,
          },
        }
      : {
          type: 'block-end',
          index: blockIndex,
          block: { type: open.kind, text: open.text },
        }
    open = null
    blockIndex += 1
    return block
  }

  /**
   * Ensure a block of the given kind is open, switching when needed.
   * Returns chunks to yield (a closed block's end, then the new block's start).
   * Callers MUST yield everything returned — dropping the end silently corrupts
   * the block stream for DSH (verified: multi-tool turns and text→tool
   * transitions lost their block-end).
   */
  const ensureBlock = (kind: OpenBlock['kind'], meta: { id?: string; name?: string } = {}): StreamChunk[] => {
    const out: StreamChunk[] = []
    if (open && open.kind !== kind) {
      const end = closeBlock()
      if (end) out.push(end)
    }
    if (!open) {
      open = { kind, arguments: '', text: '', id: meta.id, name: meta.name }
      const blockType = kind === 'tool-call' ? 'tool-call' : kind
      out.push({ type: 'block-start', index: blockIndex, blockType })
    }
    return out
  }

  /**
   * Handle one wire line and return the chunks to yield. Shared by the read
   * loop and the EOF residual so a final line without a trailing newline is
   * processed exactly like a newline-terminated one — dropping it would lose
   * content AND, since the completeness guard landed, falsify a premature
   * termination on streams that end bare.
   */
  const handleLine = (line: string): StreamChunk[] => {
    const out: StreamChunk[] = []
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) {
      const bare = extractBareJsonError(trimmed)
      if (bare) {
        const message = bare.message ?? bare.status ?? 'upstream error'
        throw new Error(`agy stream error (${bare.code ?? 'unknown'}): ${message}`)
      }
      return out
    }
    const data = trimmed.slice(5).trim()
    if (data === '[DONE]') {
      sawDone = true
      return out
    }
    const payload = parseSseDataLine(trimmed)
    if (!payload) return out
    if (payload.error) {
      const message = payload.error.message ?? payload.error.status ?? 'upstream error'
      throw new Error(`agy stream error (${payload.error.code ?? 'unknown'}): ${message}`)
    }
    if (payload.usageMetadata) {
      // The upstream sends usageMetadata on EVERY SSE event (cumulative).
      // Do NOT close the block here: closing per event would split one
      // continuous text stream into a block per chunk (frontend renders
      // block boundaries as line breaks). Stash the last (full) totals
      // and emit one usage chunk at stream end.
      //
      // Stashed BEFORE the candidates loop below, because that loop is where an
      // unmapped `finishReason` throws: the totals ride on the same event that
      // ends the stream, and `drainLine` can only flush a stash that exists.
      sawUsage = true
      // DSH TokenUsage buckets are DISJOINT: inputTokens must be the
      // uncached portion only; cache reads are reported separately.
      // Reporting the full promptTokenCount here double-counts cached
      // tokens in the stats line's cache-hit percentage (it divides by
      // uncached + cacheRead + cacheWrite).
      const promptTokens = payload.usageMetadata.promptTokenCount ?? 0
      const cachedTokens = payload.usageMetadata.cachedContentTokenCount ?? 0
      lastUsage = {
        inputTokens: Math.max(0, promptTokens - cachedTokens),
        outputTokens: payload.usageMetadata.candidatesTokenCount ?? 0,
        cacheReadTokens: cachedTokens,
      }
    }
    for (const candidate of payload.candidates ?? []) {
      if (candidate.finishReason) {
        sawFinishReason = true
        finishReason = mapFinishReason(candidate.finishReason)
      }
      for (const part of candidate.content?.parts ?? []) {
        // A zero-length text part is a routine wire shape (the daily endpoint
        // ends turns with `{thoughtSignature, text: ""}`) — fabricating an
        // empty block from it poisoned session history for stricter
        // downstream serializers (issue #77). Skip it without touching an
        // open block, so "Hel" + "" + "lo" stays one block; `!part.functionCall`
        // keeps a text+functionCall part on its current branch. Signatures
        // ride functionCall parts only, so the skip loses nothing.
        if (part.text === '' && !part.functionCall) continue
        if (part.text !== undefined && part.thought !== true) {
          out.push(...ensureBlock('text'))
          open!.text += part.text
          out.push({ type: 'text-delta', index: blockIndex, text: part.text })
        } else if (part.text !== undefined && part.thought === true) {
          out.push(...ensureBlock('reasoning'))
          open!.text += part.text
          out.push({ type: 'reasoning-delta', index: blockIndex, text: part.text })
        } else if (part.functionCall) {
          // Use the upstream functionCall id when present so the signature
          // captured on this part can be replayed for the same id next turn.
          const upstreamId = part.functionCall.id || String(blockIndex)
          // Each functionCall part is an ATOMIC block: a stream can carry
          // several functionCall parts in one turn (multi-tool responses),
          // and they share kind "tool-call" — ensureBlock alone would not
          // switch between them, concatenating their args JSON into one
          // invalid string. Close any open block (yielding its end) first.
          if (open) {
            const end = closeBlock()
            if (end) out.push(end)
          }
          const start = ensureBlock('tool-call', {
            id: upstreamId,
            name: part.functionCall.name,
          })
          out.push(...start)
          if (part.thoughtSignature) {
            options.onToolSignature?.(upstreamId, part.thoughtSignature)
          }
          const argsJson = typeof part.functionCall.args === 'string'
            ? part.functionCall.args
            : JSON.stringify(part.functionCall.args ?? {})
          open!.arguments += argsJson
          out.push({
            type: 'tool-call-delta',
            index: blockIndex,
            id: CallId(open!.id ?? ''),
            name: open!.name,
            argumentsDelta: argsJson,
          })
        }
      }
    }
    return out
  }

  /**
   * Yield one line's chunks, but flush the stashed usage first if the line
   * aborts the stream.
   *
   * An unmapped `finishReason` throws from inside `handleLine`, i.e. BEFORE the
   * usageMetadata stash on that same line AND before the end-of-stream usage
   * chunk below. Without this the caller sees no usage at all for an attempt
   * that the upstream really did bill — and the adapter's `MALFORMED_FUNCTION_CALL`
   * re-sample discards exactly such an attempt, so its tokens would silently
   * never reach the ledger (AGENTS.md: the ledger accumulates per attempt).
   */
  const drainLine = function* (line: string): Generator<StreamChunk> {
    try {
      yield* handleLine(line)
    } catch (error) {
      if (error instanceof UnmappedFinishReasonError && lastUsage !== null) {
        yield { type: 'usage', usage: lastUsage }
      }
      throw error
    }
  }

  try {
    while (true) {
      if (signal?.aborted) {
        if (lastUsage !== null) {
          yield { type: 'usage', usage: lastUsage }
        }
        throw new DOMException('aborted', 'AbortError')
      }
      let read: StreamReadResult
      try {
        read = await readWithIdleTimeout(reader, idleTimeoutMs, signal)
      } catch (error) {
        // Same rescue `drainLine` performs for an unmapped finishReason, for the
        // same reason: this attempt really did consume quota (the ledger
        // accumulates per attempt), and the totals the upstream already
        // reported would otherwise be dropped with the stalled or aborted stream.
        const isTimeout = error instanceof AgyStreamIdleTimeoutError
        const isAbort = error instanceof DOMException && error.name === 'AbortError'
        if ((isTimeout || isAbort) && lastUsage !== null) {
          yield { type: 'usage', usage: lastUsage }
        }
        throw error
      }
      if (read.done) break
      buffer += decoder.decode(read.value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        for (const chunk of drainLine(line)) yield chunk
      }
    }
    // Flush the decoder and process a final line that arrived without its
    // trailing newline: content, usage, finishReason, `[DONE]`, and bare
    // error bodies all ride it.
    buffer += decoder.decode()
    if (buffer.trim() !== '') {
      const line = buffer
      buffer = ''
      for (const chunk of drainLine(line)) yield chunk
    }
    // Completeness guard: a CLEAN close carrying neither `[DONE]` nor any
    // `finishReason` is a cut-short stream, not a completed turn — yielding
    // the default `stop` here presented truncated replies as successful
    // (issue #85). Either signal alone completes the stream.
    if (!sawDone && !sawFinishReason) {
      throw new Error('agy stream terminated prematurely without [DONE] or finishReason')
    }
    const closed = closeBlock()
    if (closed) yield closed
    if (lastUsage) {
      yield { type: 'usage', usage: lastUsage }
    } else if (sawUsage) {
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    }
    yield { type: 'finish', reason: finishReason }
  } finally {
    reader.releaseLock()
  }
}
