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
  attributionHeaders,
  contentHasImage,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { Buffer } from 'node:buffer'
import { AgyAuthError, AgyPoolBlockedError } from '../types.ts'
import type { AgyAccountSession, FailureKind, ManagedAccount, OAuthAuthDetails } from '../types.ts'
import type { RateLimitCategory } from '../runtime/classify.ts'
import { fetchAgyFirstOk } from '../oauth/constants.ts'
import { classifyFetchError, classifyHttpError } from '../runtime/classify.ts'
import { deriveAntigravitySessionId, generateAntigravityRequestId } from '../runtime/identity.ts'
import { setThoughtSignature } from '../runtime/signature-cache.ts'
import { catalogModel } from './catalog.ts'
import { toAgyRequestBody, collectImageRefs } from './translate.ts'
import type { AgyInlineImages } from './translate.ts'
import { parseAgySse } from './parse.ts'
import { AGY_PROVIDER, catalogModelList, listAgyModels, resolveAgyModel } from './models.ts'

export type { AgyAccountSession }

/**
 * Structural view of the DSH attachment service (`ctx.attachments`), matching
 * the pattern of the credentials seam (plugin-common.ts). Only the surface the
 * agy adapter needs is named, so the optional dependency carries no runtime
 * import of @deepseek-ai/dsh-attachment.
 */
export interface AgyAttachments {
  readImage(
    ref: { attachmentId: string; mediaType: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array }>
}

export interface AgyAdapterOptions {
  /** Resolve the active account for a request (model-aware: family-scoped quota ranking). */
  getSession(model?: string): Promise<AgyAccountSession | undefined>
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
    },
  ): Promise<void>
  /** Report a clean stream completion (resets the failure counter). */
  markSuccess?(session: AgyAccountSession): Promise<void>
  /** Durable image-byte resolver (optional: image requests fail without it). */
  attachments?(): AgyAttachments | undefined
}

const UPSTREAM_ERROR_CODE = 'UPSTREAM'

/** Build the impersonation headers for one request (per-request randomization applied by the shell). */
export function buildRequestHeaders(session: AgyAccountSession): Record<string, string> {
  return {
    authorization: `Bearer ${session.auth.access}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-goog-request-id': generateAntigravityRequestId(),
    ...attributionHeaders(),
    ...session.impersonation,
  }
}

/**
 * Resolve base64 image bytes for every image block the translation emits.
 *
 * Returns undefined when the request carries no images. Image-bearing requests
 * fail with UNSUPPORTED_CONTENT instead of degrading silently: an image in a
 * non-user message is not representable on the Gemini wire as a user part, a
 * catalog entry declared text-only cannot take one, and without the DSH
 * attachment service there is no byte source at all (dropping the block would
 * answer a question the user believes the model has seen).
 */
async function resolveInlineImages(
  messages: readonly Message[],
  attachments: AgyAttachments | undefined,
  model: string,
  signal: AbortSignal | undefined,
): Promise<AgyInlineImages | undefined> {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(`agy cannot represent an image in an in-history ${message.role} message`, 'UNSUPPORTED_CONTENT')
    }
  }
  const refs = collectImageRefs(messages)
  if (refs.length === 0) return undefined
  const meta = catalogModel(model)
  if (meta !== undefined && meta.supportsVision !== true) {
    throw new LlmError(`agy model "${model}" does not support image input`, 'UNSUPPORTED_CONTENT')
  }
  if (attachments === undefined) {
    throw new LlmError('agy image input requires the DSH attachment service (ctx.attachments)', 'UNSUPPORTED_CONTENT')
  }
  const images = new Map<string, string>()
  for (const ref of refs) {
    const stored = await attachments.readImage(ref, signal)
    images.set(ref.attachmentId, Buffer.from(stored.data).toString('base64'))
  }
  return images
}

export class AgyAdapter extends LlmAdapter {
  private readonly options: AgyAdapterOptions

  constructor(options: AgyAdapterOptions) {
    super()
    this.options = options
  }

  override providerInfo(_provider: string): LlmProviderInfo {
    return { id: AGY_PROVIDER, name: 'Antigravity (agy)' }
  }

  override async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    try {
      const session = await this.options.getSession()
      return await listAgyModels(session?.auth.access, session?.account.projectId)
    } catch (error) {
      if (error instanceof AgyPoolBlockedError || error instanceof AgyAuthError) {
        return catalogModelList()
      }
      throw error
    }
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let session: AgyAccountSession | undefined
    try {
      session = await this.options.getSession(options.model)
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

    const inlineImages = await resolveInlineImages(
      options.messages,
      this.options.attachments?.(),
      options.model,
      options.signal,
    )
    const body = toAgyRequestBody(options, {
      projectId: session.account.projectId,
      sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined,
    }, inlineImages)
    const headers = buildRequestHeaders(session)

    let response: Response
    try {
      response = await fetchAgyFirstOk('/v1internal:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (error) {
      const classified = classifyFetchError(error)
      await this.options.reportFailure(classified.kind, session)
      throw new LlmError(classified.message ?? 'agy fetch failed', 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => undefined)
      const classified = classifyHttpError(response.status, response.headers, bodyText)
      await this.options.reportFailure(classified.kind, session, {
        retryAfterMs: classified.retryAfterMs,
        status: response.status,
        rateLimitCategory: classified.rateLimitCategory,
        resetTime: classified.resetTime,
        model: options.model,
      })
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
      if (classified.kind === 'auth-failure') {
        throw new LlmError(
          `agy authentication failed (${response.status}) — run \`dsh-agy login\``,
          'INVALID_CREDENTIAL',
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

    try {
      yield* parseAgySse(response.body, {
        signal: options.signal,
        onToolSignature: (toolCallId, signature) => {
          setThoughtSignature(toolCallId, signature)
        },
      })
      await this.options.markSuccess?.(session)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new LlmError('agy stream aborted', 'ABORTED', { cause: error })
      }
      await this.options.reportFailure('network-error', session)
      throw new LlmError(
        error instanceof Error ? error.message : 'agy stream parse failed',
        UPSTREAM_ERROR_CODE,
        { cause: error },
      )
    }
  }
}

export type { ToolSchema }
