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
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { FailureKind, ManagedAccount, OAuthAuthDetails } from '../types.ts'
import type { RateLimitCategory } from '../runtime/classify.ts'
import { fetchAgyFirstOk } from '../oauth/constants.ts'
import { classifyFetchError, classifyHttpError } from '../runtime/classify.ts'
import { deriveAntigravitySessionId, generateAntigravityRequestId } from '../runtime/identity.ts'
import { setThoughtSignature } from '../runtime/signature-cache.ts'
import { toAgyRequestBody } from './translate.ts'
import { parseAgySse } from './parse.ts'
import { AGY_PROVIDER, listAgyModels, resolveAgyModel } from './models.ts'

export interface AgyAccountSession {
  auth: OAuthAuthDetails
  account: ManagedAccount
  index: number
  /** Fingerprint + randomized impersonation headers for this request. */
  impersonation: {
    'User-Agent': string
    'X-Goog-Api-Client': string
    'Client-Metadata': string
  }
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
    const session = await this.options.getSession()
    return listAgyModels(session?.auth.access, session?.account.projectId)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return resolveAgyModel(provider, model)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const session = await this.options.getSession(options.model)
    if (!session) {
      throw new LlmError(
        'No agy account configured — run `dsh-agy login` to authenticate.',
        'NO_CREDENTIAL',
      )
    }

    const body = toAgyRequestBody(options, {
      projectId: session.account.projectId,
      sessionId: deriveAntigravitySessionId(session.account.email) ?? undefined,
    })
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
