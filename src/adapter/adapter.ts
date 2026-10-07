/**
 * AgyAdapter: the DSH seam. A thin orchestrator over the deep modules —
 * account session resolution (shell-provided), request translation, SSE
 * parsing, failure classification, and rotation reporting. All wire details
 * live in translate.ts / parse.ts / models.ts.
 */

import {
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'

import { AgyAuthError, AgyPoolBlockedError } from '../types.ts'
import type { AgyAccountSession, FailureKind, ManagedAccount, OAuthAuthDetails } from '../types.ts'
import type { RateLimitCategory } from '../runtime/classify.ts'
import { fetchAgyFirstOk } from '../oauth/constants.ts'
import {
  classifyFetchError,
  classifyHttpError,
  describeFetchError,
  isSessionAccumulationOverflow,
} from '../runtime/classify.ts'
import { accountFetch } from '../proxy.ts'
import {
  bumpSessionGeneration,
  currentSessionGeneration,
  deriveAntigravitySessionId,
  generateAntigravityRequestId,
} from '../runtime/identity.ts'
import { setThoughtSignature } from '../runtime/signature-cache.ts'
import { toAgyRequestBody } from './translate.ts'
import type { AgyResolvedImage } from './translate.ts'
import { resolveMultimodalFiles } from './multimodal.ts'
import { parseAgySse, UnmappedFinishReasonError } from './parse.ts'
import { AGY_PROVIDER, catalogModelList, listAgyModels, resolveAgyModel } from './models.ts'

export type { AgyAccountSession }

/**
 * Structural view of the harness attachment service (ctx.attachments).
 * Deliberately not an import of @deepseek-ai/dsh-attachment: the CLI bundle
 * must stay free of harness runtime dependencies, and the real store
 * satisfies this shape.
 */
export interface AgyAttachmentStore {
  readImage(ref: {
    attachmentId: string
    mediaType: string
  }): Promise<{ ref: { mediaType: string }; data: Uint8Array }>
}

/** Collect image refs from user-message content only (spec scope: user images; tool-result nesting out of scope). */
function collectImageRefs(options: GenerateOptions): Array<{ attachmentId: string; mediaType: string }> {
  const refs: Array<{ attachmentId: string; mediaType: string }> = []
  for (const message of options.messages) {
    if (message.role !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'image') refs.push(block.attachment)
    }
  }
  return refs
}

export interface AgyAdapterOptions {
  /**
   * Resolve the active account for a request (model-aware: family-scoped quota
   * ranking). `conversationKey` scopes account affinity, so concurrent
   * conversations hold independent pins.
   */
  getSession(model?: string, conversationKey?: string): Promise<AgyAccountSession | undefined>
  /** Report a classified upstream failure so the shell can cool/rotate/revoke. */
  reportFailure(
    kind: FailureKind,
    session: AgyAccountSession,
    info?: {
      retryAfterMs?: number
      status?: number
      rateLimitCategory?: RateLimitCategory
      /** Server-reported absolute reset time; drives precise cooldowns. */
      resetTime?: string
      /** Requested model id; drives family-scoped rate-limit bookkeeping. */
      model?: string
      /** Appeal link from a `verification-required` body; surfaced to the user. */
      verificationUrl?: string
    },
  ): Promise<void>
  /** Report a clean stream completion (resets the failure counter). */
  markSuccess?(session: AgyAccountSession): Promise<void>
  /**
   * Configured token budget for a reasoning level (see `thinking-budget.ts`).
   *
   * Supplied as a resolver rather than a snapshot so an edit in the settings UI
   * applies to the next request without rebuilding the adapter.
   *
   * @param level - the lowercased effort id (`low`/`medium`/`high`).
   * @returns the budget to send, or undefined to let the level stand alone.
   */
  thinkingBudgetFor?(level: string): number | undefined
  /**
   * Configured Claude thinking budget, or undefined when unset.
   *
   * Separate from `thinkingBudgetFor` because the Claude family is id-bound and
   * carries its own validation (floor 1024, and `max_tokens` must exceed it).
   */
  claudeBudgetFor?(): number | undefined
  /** Budget for the tiered slot (the selector's "Default" effort). */
  tieredBudgetFor?(): number | undefined
  /** Resolve the harness attachment store; undefined outside the harness (standalone CLI). */
  resolveAttachments?(): AgyAttachmentStore | undefined
  /**
   * In-flight accounting for per-account request fan-out. Takes the account
   * rather than a key so the session manager derives the identity itself —
   * `accountKey` (id-first) and `ledgerAccountKey` (email-first) differ, and
   * mixing them would count against an account nobody selects.
   *
   * `noteRequestSettled` MUST run on every path, including an abandoned stream:
   * the adapter calls it from a `finally`, which async generators run on
   * completion, error, and early consumer termination alike.
   */
  noteRequestStarted?(account: ManagedAccount): void
  noteRequestSettled?(account: ManagedAccount): void
  /**
   * Hidden-model lookup. Optional so an adapter stays constructible without the
   * settings layer (tests, standalone use); absent means nothing is hidden.
   */
  modelVisibility?: { disabledFor(provider: string): ReadonlySet<string> }
  /**
   * Record one request's usage. Optional by design: the CLI must be able to
   * build an adapter without the stats ledger, and a statistics failure must
   * never break a generation.
   */
  recordUsage?(record: {
    account?: string
    model?: string
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
    ok: boolean
    rateLimited?: boolean
    /** Failure classification, when the record failed. */
    reason?: string
    latencyMs?: number
    ttftMs?: number
  }): void
}

const UPSTREAM_ERROR_CODE = 'UPSTREAM'
/** First-class DSH retryable code: the default retry policy honors SERVER (5xx), not UPSTREAM. */
const SERVER_ERROR_CODE = 'SERVER'

/** Abort-aware delay helper for transient stream retries. */
async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException('aborted', 'AbortError')
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Stable ledger key for an account: email when present, else the generated id. */
function ledgerAccountKey(session: AgyAccountSession): string | undefined {
  return session.account.email ?? session.account.id
}

/**
 * Build the impersonation headers for one request.
 *
 * There is NO request-id header. `x-goog-request-id` used to be sent here and is
 * present in neither official binary; the id the backend correlates on is the
 * body's `requestId` field, which this request already carries. An invented
 * header is a shape no official client emits, which is precisely the anomaly the
 * impersonation set exists to avoid.
 *
 * `User-Agent` carries the Antigravity client string and NOTHING else. The
 * harness's `attributionHeaders()` is deliberately not merged in: it returns a
 * lowercase `user-agent` key, so spreading it alongside the camel-case
 * `session.impersonation` produced TWO distinct object properties that `fetch`
 * folded into one comma-joined value —
 *
 *   `deepseek-harness/<v> (+url), antigravity/<v> <platform>`
 *
 * — a header no official client can emit, byte-identical for every dsh-agy
 * user, and therefore a stronger fingerprint than the one it was trying to
 * avoid. There is exactly one `User-Agent` field on the wire and the upstream
 * requires it to be the client identity, so this request cannot carry both.
 *
 * This adapter performs its own dispatch (see the `fetchAgyFirstOk` call in
 * `stream()`); nothing downstream re-adds the header.
 */
export function buildRequestHeaders(session: AgyAccountSession): Record<string, string> {
  return {
    authorization: `Bearer ${session.auth.access}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    // Exactly the two impersonation HEADERS, named individually rather than
    // spread. `session.impersonation.clientMetadata` is a body message and must
    // not become a header — and it is deliberately not added to this envelope
    // either: the only `metadata` field the official descriptor evidences is on
    // the control-plane calls (`LoadCodeAssistRequest`/`OnboardUserRequest`), so
    // on this generate request the identity carrier is the body's existing
    // `userAgent`/`requestType` pair.
    'User-Agent': session.impersonation['User-Agent'],
    'X-Goog-Api-Client': session.impersonation['X-Goog-Api-Client'],
  }
}

/** How long discovered models stay cached before re-probing upstream (10 minutes). */
export const MODEL_LIST_CACHE_TTL_MS = 10 * 60 * 1000

export class AgyAdapter extends LlmAdapter {
  private readonly options: AgyAdapterOptions
  private cachedModels: { models: readonly LlmModelInfo[]; at: number } | null = null
  private inFlightModels: Promise<readonly LlmModelInfo[]> | null = null

  constructor(options: AgyAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: AGY_PROVIDER, name: 'Antigravity (agy)' }
  }

  /**
   * The catalog as DSH's model selector sees it: discovered models minus the
   * user's hidden set. Filtering here is what makes "turn a model off" hide it
   * from the picker — the selector reads this, and DSH itself is untouched.
   */
  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    const all = await this.listAllModels()
    const hidden = this.options.modelVisibility?.disabledFor(AGY_PROVIDER)
    if (hidden === undefined || hidden.size === 0) return all
    return all.filter((model) => !hidden.has(model.id))
  }

  /**
   * The complete catalog, ignoring the user's hidden set.
   *
   * Cached in memory for `MODEL_LIST_CACHE_TTL_MS` with in-flight deduplication.
   * DSH 0.2.0-rc.1 calls `listModels` on every model and effort selection via
   * `requireModel`; without caching, each click paid a multi-second round-trip to
   * Google's `fetchAvailableModels` through the proxy, showing a loading spinner
   * on every interaction.
   *
   * The settings page lists models through this rather than `listModels`: if it
   * read the filtered list, a hidden model would vanish from the page along
   * with the switch that hides it, leaving no way to turn it back on without
   * hand-editing the file.
   */
  async listAllModels(force = false): Promise<readonly LlmModelInfo[]> {
    const now = Date.now()
    if (!force && this.cachedModels && now - this.cachedModels.at < MODEL_LIST_CACHE_TTL_MS) {
      return this.cachedModels.models
    }
    if (this.inFlightModels) return this.inFlightModels

    const task = (async () => {
      try {
        const session = await this.options.getSession()
        // Model discovery is account-scoped: route it through the account's proxy
        // (control-plane class, so the standard timeouts apply).
        const routing = { proxyUrl: session?.account.proxy }
        const models = await listAgyModels(session?.auth.access, session?.account.projectId, accountFetch(routing))
        this.cachedModels = { models, at: Date.now() }
        return models
      } catch (error) {
        if (error instanceof AgyPoolBlockedError || error instanceof AgyAuthError) {
          return catalogModelList()
        }
        if (this.cachedModels) return this.cachedModels.models
        throw error
      } finally {
        this.inFlightModels = null
      }
    })()

    this.inFlightModels = task
    return task
  }

  /**
   * Drop the cached model list.
   *
   * Model discovery is account-scoped (what `fetchAvailableModels` reports and
   * which proxy it rides depend on the account), but the cache is deliberately
   * keyed to NO account: a keyed read would have to call `getSession()` on
   * every hit, and that call can probe quota or refresh a token — the network
   * cost this cache exists to remove. Every event that can switch the account
   * discovery rides (activation, rotation) therefore drops the cache instead.
   */
  invalidateModelCache(): void {
    this.cachedModels = null
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
  }

  // `prepareCall` is deliberately NOT overridden: the LlmAdapter base class
  // (dsh-llm 0.1.1-rc.2+) already binds the resolved model to the stream, which
  // is exactly what this adapter would do. The base implementation also
  // forwards the cancellation signal, which the previous hand-written copy
  // dropped. Only dynamic adapters — those needing different capabilities per
  // generation — should override it.

  /**
   * Pre-resolve every image attachment into base64 bytes before translation.
   * Image input hard-fails with UNSUPPORTED_CONTENT (terminal, never retried)
   * when the store is missing or a read fails — silently dropping images and
   * sending text-only is the exact failure mode this path exists to prevent.
   */
  private async resolveRequestImages(options: GenerateOptions): Promise<Map<string, AgyResolvedImage>> {
    const refs = collectImageRefs(options)
    const images = new Map<string, AgyResolvedImage>()
    if (refs.length === 0) return images
    const store = this.options.resolveAttachments?.()
    if (!store) {
      throw new LlmError(
        'agy image input requires the durable attachment service (in-harness plugin only)',
        'UNSUPPORTED_CONTENT',
      )
    }
    // Read every attachment concurrently (N images cost one round-trip, not N).
    // allSettled rather than all: more than one read may reject, and the
    // surfaced error must be deterministic (first failure in ref order) instead
    // of whichever concurrent read happened to reject first — and no rejection
    // may escape as unhandled.
    const settled = await Promise.allSettled(
      refs.map(async (ref) => {
        const stored = await store.readImage(ref)
        return {
          attachmentId: ref.attachmentId,
          image: {
            mediaType: stored.ref.mediaType,
            data: Buffer.from(stored.data).toString('base64'),
          },
        }
      }),
    )
    const failedIndex = settled.findIndex((outcome) => outcome.status === 'rejected')
    if (failedIndex !== -1) {
      const ref = refs[failedIndex]!
      const cause: unknown = (settled[failedIndex] as PromiseRejectedResult).reason
      throw new LlmError(
        `agy image attachment "${ref.attachmentId}" could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`,
        'UNSUPPORTED_CONTENT',
        { cause: cause instanceof Error ? cause : undefined },
      )
    }
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        images.set(outcome.value.attachmentId, outcome.value.image)
      }
    }
    return images
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // The in-flight slot must be released on EVERY path — clean completion, a
    // thrown error, and a consumer that abandons the stream mid-turn. An async
    // generator's `finally` is the one hook covering all three, so the slot is
    // released here rather than at each exit inside `streamInner`.
    const holder: { account?: ManagedAccount } = {}
    try {
      yield* this.streamInner(options, holder)
    } finally {
      if (holder.account !== undefined) this.options.noteRequestSettled?.(holder.account)
    }
  }

  private async *streamInner(
    options: GenerateOptions,
    holder: { account?: ManagedAccount },
  ): AsyncIterable<StreamChunk> {
    // Spec D1 sequence: resolve images first — a locally-failing image request
    // must surface UNSUPPORTED_CONTENT (user story 8) instead of being masked
    // by account-pool errors, and must not touch pool state at all.
    const images = await this.resolveRequestImages(options)
    /**
     * The DSH agent loop stamps `options.sessionId` on every request it builds,
     * so it is the conversation identity — used both to scope account affinity
     * here and to derive the upstream `sessionId` below.
     */
    const conversationKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    let session: AgyAccountSession | undefined
    try {
      session = await this.options.getSession(options.model, conversationKey)
    } catch (error) {
      if (error instanceof AgyAuthError) {
        if (error.kind === 'transport') {
          throw new LlmError(error.message, 'TRANSPORT', { cause: error })
        }
        if (error.kind === 'rate-limit') {
          throw new LlmError(error.message, 'RATE_LIMIT', {
            requestId: ProviderRequestId(generateAntigravityRequestId()),
          })
        }
        throw new LlmError(error.message, 'INVALID_CREDENTIAL', { cause: error })
      }
      if (error instanceof AgyPoolBlockedError) {
        if (error.kind === 'quota-exhausted') {
          throw new LlmError(error.message, QUOTA_EXCEEDED_CODE)
        }
        const delta = Math.ceil(error.blockedUntil - Date.now())
        const providerRetryAfterMs = Number.isFinite(delta) && delta > 0 ? delta : 1
        throw new LlmError(error.message, 'RATE_LIMIT', {
          providerRetryAfterMs,
          requestId: ProviderRequestId(generateAntigravityRequestId()),
        })
      }
      throw error
    }
    if (!session) {
      throw new LlmError(
        'No agy account configured — run `dsh-agy login` to authenticate.',
        'NO_CREDENTIAL',
      )
    }

    const multimodalFiles = await resolveMultimodalFiles(options)
    // The account is now fixed for this request; take the in-flight slot that the
    // `stream` wrapper releases (see its comment for why release lives there).
    holder.account = session.account
    this.options.noteRequestStarted?.(session.account)
    // `conversationKey` is resolved above and shared with account affinity.
    // Standalone CLI callers leave `options.sessionId` unset, so the upstream
    // session id degrades to the per-account value rather than inventing a
    // conversation.
    const conversationAccount = ledgerAccountKey(session)
    /** Wall-clock origin for this attempt's latency figures. */
    const startedAt = Date.now()
    // Streaming dispatch: the account proxy MUST carry the generation request
    // (it carried only the control-plane calls before, so a proxied account
    // silently generated from the host's real IP), and the streaming
    // dispatcher drops the per-gap body timeout a reasoning pause would trip.
    const routing = { proxyUrl: session.account.proxy, streaming: true }

    /**
     * Send one request, resending at most once when the upstream reports the
     * per-`sessionId` accumulation wall.
     *
     * The upstream accumulates a conversation's input server-side per
     * `sessionId`; once that passes 1M tokens every request reusing the id fails
     * with a 400 until the upstream session expires. Bumping the generation
     * names a fresh upstream session and recovers the conversation. This is not
     * an account fault, so it does not go through `reportFailure`: the account
     * stays healthy and only the derived id changes.
     */
    const sendAttempt = async (): Promise<{ response: Response; bodyText?: string }> => {
      for (let attempt = 0; ; attempt++) {
        const generation = conversationKey !== undefined && conversationAccount !== undefined
          ? currentSessionGeneration(conversationAccount, conversationKey)
          : 0
        // One id per attempt, carried by the body. A resend under a bumped
        // session generation is a new upstream request, so it gets a new id.
        const requestId = generateAntigravityRequestId()
        const body = toAgyRequestBody(options, {
          projectId: session.account.projectId,
          sessionId:
            deriveAntigravitySessionId(session.account.email, conversationKey, generation) ?? undefined,
          requestId,
          ...(this.options.thinkingBudgetFor === undefined
            ? {}
            : { thinkingBudgetFor: this.options.thinkingBudgetFor }),
          ...(this.options.claudeBudgetFor === undefined
            ? {}
            : { claudeBudgetFor: this.options.claudeBudgetFor }),
          ...(this.options.tieredBudgetFor === undefined
            ? {}
            : { tieredBudgetFor: this.options.tieredBudgetFor }),
          ...(images.size > 0 ? { images } : {}),
          ...(multimodalFiles.size > 0 ? { multimodalFiles } : {}),
        })
        let response: Response
        try {
          response = await fetchAgyFirstOk(
            '/v1internal:streamGenerateContent?alt=sse',
            {
              method: 'POST',
              headers: buildRequestHeaders(session),
              body: JSON.stringify(body),
              signal: options.signal,
            },
            accountFetch(routing),
            routing,
          )
        } catch (error) {
          const classified = classifyFetchError(error, { proxyUrl: session.account.proxy })
          await this.options.reportFailure(classified.kind, session)
          // A transport failure consumed no tokens, but it is a real attempt
          // against this account's quota — record the request, not the usage.
          this.recordUsage(session, options.model, { ok: false, reason: 'network-error' }, startedAt)
          throw new LlmError(classified.message ?? 'agy fetch failed', 'TRANSPORT', { cause: error })
        }
        if (response.ok) return { response }
        const bodyText = await response.text().catch(() => undefined)
        if (
          attempt === 0
          && conversationKey !== undefined
          && conversationAccount !== undefined
          && isSessionAccumulationOverflow(response.status, bodyText)
        ) {
          bumpSessionGeneration(conversationAccount, conversationKey)
          continue
        }
        return { response, bodyText }
      }
    }

    /**
     * Maximum internal retries when the upstream ends a stream with
     * `MALFORMED_FUNCTION_CALL` before any user-facing text chunks have been
     * yielded to DSH. Gemini models occasionally glitch on tool-call JSON syntax;
     * re-sampling cleanly recovers the turn without crashing the conversation.
     */
    const MAX_MALFORMED_RETRIES = 3

    for (let malformedAttempt = 0; ; malformedAttempt++) {
      const attemptStartedAt = Date.now()
      const { response, bodyText } = await sendAttempt()

      if (!response.ok) {
        const classified = classifyHttpError(response.status, response.headers, bodyText)
        await this.options.reportFailure(classified.kind, session, {
          retryAfterMs: classified.retryAfterMs,
          status: response.status,
          rateLimitCategory: classified.rateLimitCategory,
          resetTime: classified.resetTime,
          model: options.model,
          verificationUrl: classified.verificationUrl,
        })
        this.recordUsage(session, options.model, {
          ok: false,
          rateLimited: classified.kind === 'rate-limit',
          reason: classified.kind,
        }, attemptStartedAt)
        if (classified.kind === 'rate-limit') {
          // soft/rate limits are retryable by the harness (RATE_LIMIT + delay);
          // daily quota exhaustion is terminal (QUOTA, 24h cooldown already set).
          if (classified.rateLimitCategory === 'quota_exhausted') {
            throw new LlmError(
              `agy daily quota exhausted (${response.status}): ${classified.message ?? ''}`,
              QUOTA_EXCEEDED_CODE,
            )
          }
          throw new LlmError(
            `agy rate-limited (${response.status}): ${classified.message ?? ''}`,
            'RATE_LIMIT',
            {
              providerRetryAfterMs: classified.retryAfterMs ?? undefined,
              requestId: ProviderRequestId(generateAntigravityRequestId()),
            },
          )
        }
        if (classified.kind === 'verification-required') {
          // Recoverable, so deliberately NOT INVALID_CREDENTIAL: the account is
          // parked for a timed window, not disabled, and the pool moves on. The
          // appeal link goes in the message because a message is the only channel
          // DSH surfaces to the user.
          //
          // Deliberately NO `providerRetryAfterMs`: the park IS the cooldown, and a
          // delay above DSH's `maxDelayMs` makes its `normal` retry mode give up
          // outright (`llm-retry`: `providerRetryAfterMs > maxDelayMs` -> `next()`),
          // turning a recoverable challenge into a failed turn. With no delay DSH
          // backs off locally and retries, and that retry lands on another account
          // because this one is already parked.
          const appeal = classified.verificationUrl ? ` Verify at: ${classified.verificationUrl}` : ''
          throw new LlmError(
            `agy account needs verification (${response.status}): ${classified.message ?? ''}${appeal}`,
            'RATE_LIMIT',
            {
              requestId: ProviderRequestId(generateAntigravityRequestId()),
            },
          )
        }
        if (classified.kind === 'auth-failure') {
          throw new LlmError(
            `agy authentication failed (${response.status}) — run \`dsh-agy login\``,
            'INVALID_CREDENTIAL',
          )
        }
        // 5xx upstream failures (e.g. 503 "No capacity available") are transient:
        // the DSH retry policy honors SERVER but treats UPSTREAM as terminal, so
        // classifying 5xx as UPSTREAM kills the turn with zero retries. Non-5xx
        // transient/request errors (404, generic 400, other 4xx) stay terminal.
        if (classified.status !== undefined && classified.status >= 500) {
          throw new LlmError(
            `agy upstream error (${response.status}): ${classified.message ?? ''}`,
            SERVER_ERROR_CODE,
            {
              providerRetryAfterMs: classified.retryAfterMs ?? undefined,
              requestId: ProviderRequestId(generateAntigravityRequestId()),
            },
          )
        }
        throw new LlmError(
          `agy upstream error (${response.status}): ${classified.message ?? ''}`,
          UPSTREAM_ERROR_CODE,
        )
      }

      if (!response.body) {
        throw new LlmError('agy stream returned no body', UPSTREAM_ERROR_CODE)
      }

      // Buffer stream chunks while reasoning or tool calls accumulate. If
      // `text-delta` arrives, flush the buffer and stream directly to preserve
      // real-time token streaming for user-facing responses. If
      // `MALFORMED_FUNCTION_CALL` arrives before any text deltas were yielded,
      // the buffer is discarded and the attempt is cleanly retried.
      const bufferedChunks: StreamChunk[] = []
      let yieldedDirect = false
      let usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined
      let ttftMs: number | undefined

      try {
        for await (const chunk of parseAgySse(response.body, {
          signal: options.signal,
          onToolSignature: (toolCallId, signature) => {
            setThoughtSignature(toolCallId, signature)
          },
        })) {
          if (chunk.type === 'usage') {
            usage = {
              input: chunk.usage.inputTokens,
              output: chunk.usage.outputTokens,
              cacheRead: chunk.usage.cacheReadTokens ?? 0,
              cacheWrite: chunk.usage.cacheWriteTokens ?? 0,
            }
          } else if (ttftMs === undefined && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')) {
            // First model-authored output: the honest end of "time to first token".
            ttftMs = Date.now() - attemptStartedAt
          }

          if (yieldedDirect) {
            yield chunk
          } else if (chunk.type === 'text-delta') {
            yieldedDirect = true
            for (const buffered of bufferedChunks) yield buffered
            bufferedChunks.length = 0
            yield chunk
          } else {
            bufferedChunks.push(chunk)
          }
        }

        // Flush remaining buffered chunks (tool-call or completed reasoning turns).
        for (const buffered of bufferedChunks) yield buffered
        bufferedChunks.length = 0

        await this.options.markSuccess?.(session)
        this.recordUsage(session, options.model, { ok: true, usage, ttftMs }, attemptStartedAt)
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new LlmError('agy stream aborted', 'ABORTED', { cause: error })
        }

        // MALFORMED_FUNCTION_CALL is a transient model syntax fluke during tool calling.
        // If no text chunks were committed to DSH, discard the buffered chunks, record
        // this attempt's usage, and retry with exponential backoff.
        const isMalformed = error instanceof UnmappedFinishReasonError && error.reason === 'MALFORMED_FUNCTION_CALL'
        if (isMalformed && !yieldedDirect && malformedAttempt < MAX_MALFORMED_RETRIES) {
          this.recordUsage(session, options.model, { ok: false, reason: 'request-error' }, attemptStartedAt)
          await sleepWithSignal(200 * (malformedAttempt + 1), options.signal)
          continue
        }

        // An unmapped finishReason (SAFETY, unrecovered MALFORMED_FUNCTION_CALL, ...) is a
        // CONTENT-level verdict: the request reached a healthy account and the
        // upstream chose to stop the response. Reporting network-error would
        // cool and rotate the account for a wall the next request may never
        // hit; request-error is a no-op at account level. DSH sees a terminal
        // UPSTREAM error either way (below).
        const unmappedFinish = error instanceof UnmappedFinishReasonError
        await this.options.reportFailure(unmappedFinish ? 'request-error' : 'network-error', session)
        // A stream that died mid-body may already have delivered billable
        // content, so the attempt is recorded even though no usage chunk arrived.
        this.recordUsage(session, options.model, { ok: false, reason: unmappedFinish ? 'request-error' : 'network-error' }, attemptStartedAt)
        // Deliberately UPSTREAM (terminal), not TRANSPORT: content may already
        // have been emitted, and DSH's retry policy honours TRANSPORT, so retrying
        // here would replay a partially-delivered turn. The account-level report
        // above already absorbs the transient case by cooling/rotating. The cause
        // code is still surfaced so the socket failure is legible in session events.
        throw new LlmError(
          error instanceof Error ? describeFetchError(error) : 'agy stream parse failed',
          UPSTREAM_ERROR_CODE,
          { cause: error },
        )
      }
    }
  }

  /**
   * Fold one attempt into the usage ledger.
   *
   * Statistics are diagnostics, never load-bearing: a ledger failure must not
   * fail a generation, so this swallows its own errors.
   */
  private recordUsage(
    session: AgyAccountSession,
    model: string | undefined,
    result: {
      ok: boolean
      rateLimited?: boolean
      reason?: string
      usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
      ttftMs?: number
    },
    startedAt: number,
  ): void {
    const record = this.options.recordUsage
    if (record === undefined) return
    try {
      record({
        ...(ledgerAccountKey(session) === undefined ? {} : { account: ledgerAccountKey(session) }),
        ...(model === undefined ? {} : { model }),
        ok: result.ok,
        ...(result.rateLimited === true ? { rateLimited: true } : {}),
        ...(result.reason === undefined ? {} : { reason: result.reason }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }),
        latencyMs: Math.max(0, Date.now() - startedAt),
      })
    } catch {
      // Swallowed by design.
    }
  }
}

export type { ToolSchema }
