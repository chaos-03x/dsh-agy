/**
 * Upstream failure classification: HTTP status + headers + body → FailureKind.
 * Conservative by design: only auth-failure may revoke an account; everything
 * else cools, rotates, or retries.
 */

import { isProxyRouted } from '../types.ts'
import type { AccountRouting, FailureKind } from '../types.ts'
import { isProxyUnreachableError } from '../proxy.ts'
import { redactCredentials } from '../redact.ts'

export interface ClassifiedError {
  kind: FailureKind
  status?: number
  /** Server-provided retry delay (ms), when the response carried it. */
  retryAfterMs?: number
  /** Server-provided absolute reset time, when the response carried it. */
  resetTime?: string
  message?: string
  /** 429 sub-category, present when kind is rate-limit. */
  rateLimitCategory?: RateLimitCategory
  /**
   * Appeal/verification link from a `verification-required` body, when the
   * upstream supplied one. Surfaced to the user, never followed automatically.
   */
  verificationUrl?: string
}

/**
 * Phrases the upstream uses to ask for account verification rather than
 * rejecting a credential. Matched case-insensitively on the raw body.
 *
 * Kept as a phrase list (not a bare `includes('verify')`) so an ordinary
 * permission error is not mistaken for a recoverable challenge — the cost of a
 * false positive is a healthy account parked behind a timed block.
 */
const VERIFICATION_PHRASES = [
  'validation_required',
  'verify your account',
  'verification required',
  'verification_required',
] as const

/** Whether a 403 body asks the account owner to verify rather than meaning dead credentials. */
export function isVerificationRequired(bodyText: string | undefined): boolean {
  if (!bodyText) return false
  const text = bodyText.toLowerCase()
  return VERIFICATION_PHRASES.some((phrase) => text.includes(phrase))
}

/**
 * Pull the appeal/verification link out of a Google RPC error body.
 *
 * Prefers the structured location — `error.details[].metadata.validation_url`,
 * then `appeal_url` — and only falls back to the first bare `https://` match,
 * because a loose match can pick up an unrelated link. Google escapes `&` as
 * `\u0026` inside the JSON string form, so the fallback unescapes it.
 */
export function extractVerificationUrl(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const data = JSON.parse(bodyText) as { error?: { details?: unknown } }
    const details = data.error?.details
    if (Array.isArray(details)) {
      for (const detail of details) {
        const meta = (detail as { metadata?: Record<string, unknown> } | null)?.metadata
        if (!meta) continue
        for (const field of ['validation_url', 'appeal_url'] as const) {
          const value = meta[field]
          if (typeof value === 'string' && value.length > 0) return value
        }
      }
    }
  } catch {
    // not JSON — fall through to the textual scan
  }
  // Unescape BEFORE matching: a URL inside a JSON string carries `&` as
  // `\u0026`, and a pattern that rejects backslashes would truncate the link at
  // its first query separator — handing the user a broken appeal URL.
  const unescaped = bodyText.replace(/\\u0026/gi, '&')
  const match = /https:\/\/[^\s"'\\]+/.exec(unescaped)
  return match ? match[0] : undefined
}

/**
 * 429 sub-category (mirrors CLIProxyAPI/OmniRoute's classify429):
 * - soft_rate_limit: transient burst, retry immediately on the same account
 * - rate_limited:    per-minute limit, short cooldown then retry (same account
 *                    when there is no other)
 * - quota_exhausted: daily/plan quota gone, long cooldown (24h)
 * - unknown:         exponential backoff
 */
export type RateLimitCategory = 'soft_rate_limit' | 'rate_limited' | 'quota_exhausted' | 'unknown'

const QUOTA_EXHAUSTED_KEYWORDS = [
  'quota_exhausted',
  'quota exhausted',
  'quota reached',
  'enable overages',
  'individual quota',
]

/** Classify a 429 body into the four upstream categories. */
export function classifyRateLimit(
  bodyText: string | undefined,
  retryAfterMs: number | undefined,
): RateLimitCategory {
  const text = (bodyText ?? '').toLowerCase()
  if (QUOTA_EXHAUSTED_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return 'quota_exhausted'
  }
  if (retryAfterMs !== undefined && retryAfterMs < 3000) {
    return 'soft_rate_limit'
  }
  if (retryAfterMs !== undefined) {
    return 'rate_limited'
  }
  // No explicit retry hint: "quota" wording → daily quota, otherwise unknown.
  return text.includes('quota') || text.includes('resource_exhausted') ? 'quota_exhausted' : 'unknown'
}

const RATE_LIMIT_RESET_FIELDS = ['resetTime', 'reset_time', 'resetAt', 'quotaResetTime'] as const

function extractResetTime(bodyText: string | undefined): string | undefined {
  if (!bodyText) return undefined
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>
    for (const field of RATE_LIMIT_RESET_FIELDS) {
      const value = data[field]
      if (typeof value === 'string' && value) return value
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Unix ms when large, seconds when small (relative to now).
        return value > 1_000_000_000_000 ? new Date(value).toISOString() : new Date(Date.now() + value * 1000).toISOString()
      }
    }
    const quotaInfo = data.quotaInfo as Record<string, unknown> | undefined
    if (quotaInfo && typeof quotaInfo.resetTime === 'string') return quotaInfo.resetTime
  } catch {
    // not JSON — no reset info
  }
  return undefined
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

/** Classify a completed HTTP response (non-2xx). */
export function classifyHttpError(
  status: number,
  headers: Headers,
  bodyText?: string,
): ClassifiedError {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'))
  const resetTime = extractResetTime(bodyText)

  if (status === 429) {
    const category = classifyRateLimit(bodyText, retryAfterMs)
    return {
      kind: 'rate-limit',
      rateLimitCategory: category,
      status,
      retryAfterMs,
      resetTime,
      message: bodyText ? bodyText.slice(0, 200) : undefined,
    }
  }
  if (status === 401) {
    return { kind: 'auth-failure', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
  }
  if (status === 403) {
    // A verification wall is its own signal, checked BEFORE the auth-failure
    // fallback: the credential is fine, the account is temporarily gated, and the
    // body carries a URL the user can act on. Collapsing it into `auth-failure`
    // permanently disabled a healthy account on a signal that meant "come back
    // after verifying", with no automatic way back.
    if (isVerificationRequired(bodyText)) {
      return {
        kind: 'verification-required',
        status,
        verificationUrl: extractVerificationUrl(bodyText),
        message: bodyText ? bodyText.slice(0, 200) : undefined,
      }
    }
    // Google also reports quota walls as 403 RESOURCE_EXHAUSTED, and the
    // endpoint fallback chain ends on hosts answering 403 for "no license"
    // (not bad auth). Only treat a 403 as auth-failure when the body carries
    // no quota wording — a false revoke permanently disables the account.
    const category = classifyRateLimit(bodyText, undefined)
    if (category === 'quota_exhausted') {
      return {
        kind: 'rate-limit',
        rateLimitCategory: category,
        status,
        message: bodyText ? bodyText.slice(0, 200) : undefined,
      }
    }
    // An HTML response (from autopush sandbox "no license" or an intermediary gateway)
    // is NOT an invalid account credential — Google API auth errors are structured JSON.
    // Classifying HTML 403 as auth-failure causes false revocations of healthy accounts.
    if (bodyText && /^\s*<(!doctype|html)/i.test(bodyText)) {
      return {
        kind: 'transient',
        status,
        message: bodyText.slice(0, 200),
      }
    }
    return { kind: 'auth-failure', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
  }
  if (status === 404) {
    // Model/route missing — nothing to rotate for; surface as transient request error.
    return { kind: 'transient', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
  }
  if (status >= 500) {
    return { kind: 'transient', status, retryAfterMs, message: bodyText ? bodyText.slice(0, 200) : undefined }
  }
  if (status === 400) {
    // A 400 is a request-construction error (permanent — retrying sends the
    // same broken payload). Only capacity-style phrases are recoverable
    // (context overflow / model unavailable), mirroring OmniRoute's
    // classifyProviderError: everything else surfaces as a terminal
    // request-error so rotation does not waste attempts.
    const text = (bodyText ?? '').toLowerCase()
    const recoverable = (
      (text.includes('context') && (text.includes('overflow') || text.includes('too long') || text.includes('exceeded')))
      || (text.includes('model') && (text.includes('not found') || text.includes('unavailable') || text.includes('not supported')))
    )
    if (recoverable) {
      return { kind: 'transient', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
    }
    return { kind: 'request-error', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
  }
  // 400-range others (401 handled above): request-level errors, no rotation semantics.
  return { kind: 'transient', status, message: bodyText ? bodyText.slice(0, 200) : undefined }
}

/**
 * Phrases the upstream returns when a conversation's SERVER-SIDE accumulated
 * input for one `sessionId` passes the 1M ceiling.
 *
 * This is not a request-construction error: the payload is fine, but the
 * upstream session that `sessionId` names has accumulated too much across turns.
 * The recovery is to derive a different `sessionId` (a "generation" bump) and
 * resend — hence this predicate is checked before {@link classifyHttpError} so
 * such a 400 is not collapsed into a terminal `request-error`.
 *
 * Matched on the measured upstream text; kept phrase-specific (rather than a
 * bare `includes('tokens')`) so a genuine model-capability 400 is not mistaken
 * for a bumpable session wall.
 */
const SESSION_ACCUMULATION_PHRASES = [
  'exceeds the maximum number of tokens',
  'input token count exceeds',
  'token count exceeds the maximum',
] as const

/**
 * Whether a failed response is the recoverable per-`sessionId` accumulation
 * wall rather than a malformed request.
 *
 * @param status - HTTP status of the failed response.
 * @param bodyText - response body, when readable.
 * @returns true when a session-generation bump plus one resend can recover.
 */
export function isSessionAccumulationOverflow(status: number, bodyText: string | undefined): boolean {
  if (status !== 400 || !bodyText) return false
  const text = bodyText.toLowerCase()
  return SESSION_ACCUMULATION_PHRASES.some((phrase) => text.includes(phrase))
}

/** Codes that carry a socket/syscall `code` worth surfacing in a failure message. */
const TRANSPORT_CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_ABORTED',
])

/**
 * Placeholder messages undici/Node emit while the real reason sits deeper in
 * the cause chain; they must not shadow a usable code further down.
 */
const GENERIC_CAUSE_MESSAGES = new Set(['fetch failed', 'terminated', 'other side closed', 'aborted'])

/**
 * Walk the error cause chain collecting the actionable `code` and message.
 * Node/undici reports `TypeError: fetch failed` and stores the real reason in
 * `error.cause` (verified against live failures): without this, DNS, TLS,
 * timeout, reset, and proxy failures are indistinguishable in DSH session
 * events and the GUI.
 */
function describeCause(error: unknown): { code?: string; message?: string } {
  const seen = new Set<unknown>()
  let current: unknown = (error as { cause?: unknown })?.cause ?? error
  let fallbackMessage: string | undefined
  // A recognized `code` anywhere wins over any message: the outer wrappers
  // (`TypeError: fetch failed`, or a refresh error repeating that text)
  // otherwise shadow the real reason.
  for (let depth = 0; current && depth < 6 && !seen.has(current); depth++) {
    seen.add(current)
    if (typeof current === 'object') {
      const code = (current as { code?: unknown }).code
      const message = (current as { message?: unknown }).message
      const usableMessage = typeof message === 'string' && message.length > 0 ? message : undefined
      if (typeof code === 'string' && TRANSPORT_CAUSE_CODES.has(code)) {
        return { code, message: usableMessage }
      }
      if (usableMessage && !GENERIC_CAUSE_MESSAGES.has(usableMessage) && !fallbackMessage) {
        fallbackMessage = usableMessage
      }
      // An AggregateError (Happy Eyeballs) carries its reasons in `errors`.
      const errors = (current as { errors?: unknown }).errors
      if (Array.isArray(errors)) {
        for (const nested of errors) {
          const described = describeCause({ cause: nested })
          if (described.code) return described
          if (described.message && !fallbackMessage) fallbackMessage = described.message
        }
      }
    }
    current = (current as { cause?: unknown })?.cause
  }
  return fallbackMessage ? { message: fallbackMessage } : {}
}

/**
 * Human-readable transport failure: `fetch failed (UND_ERR_SOCKET: other side
 * closed)`. The sanitized cause code/message is what makes a transient socket
 * error distinguishable from a DNS, TLS, or proxy failure in session records.
 */
export function describeFetchError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error)
  const { code, message } = describeCause(error)
  if (!code && !message) return redactCredentials(base)
  // Prefer the richer text: a syscall message already carrying the code
  // ("getaddrinfo ENOTFOUND host") keeps its host, while a bare reason
  // ("other side closed") is prefixed with the code.
  const detail = code && message
    ? (message.includes(code) ? message : `${code}: ${message}`)
    : (code ?? message)!
  // Skip a detail that merely repeats the base ("fetch failed (fetch failed)").
  if (detail === base) return redactCredentials(base)
  return redactCredentials(`${base} (${detail})`)
}

/**
 * Classify a fetch-level failure (DNS, refused, timeout, abort).
 * @param routing - how the failed request was routed; fail-closed applies only
 *   when it carried an explicit per-account proxy (see {@link AccountRouting}).
 */
export function classifyFetchError(error: unknown, routing?: AccountRouting): ClassifiedError {
  const message = describeFetchError(error)
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { kind: 'network-error', message }
  }
  // A tagged error is a definite proxy verdict (fast-fail pre-check, or a
  // dispatcher failure), so it stays authoritative in either context.
  const tagged = (error as { errorCode?: unknown })?.errorCode === 'proxy_unreachable'
    || (error as { code?: unknown })?.code === 'PROXY_UNREACHABLE'
  if (tagged) {
    return { kind: 'proxy-unreachable', message }
  }
  // Otherwise the bare socket codes in PROXY_UNREACHABLE_CODES are ambiguous:
  // they describe *the connection*, not *which* connection. Reading them as
  // "proxy unreachable" without a proxy in play skipped healthy accounts
  // un-cooldowned, so the context decides (issue #29).
  if (isProxyRouted(routing) && isProxyUnreachableError(error)) {
    return { kind: 'proxy-unreachable', message }
  }
  return { kind: 'network-error', message }
}

/** Classify the result of a refresh attempt (shared by adapter + verify paths). */
export function classifyRefreshFailure(status: number, code?: string): ClassifiedError {
  if (code === 'invalid_grant') return { kind: 'auth-failure', status, message: code }
  if (status === 429) return { kind: 'rate-limit', status, message: code }
  if (status >= 500) return { kind: 'transient', status, message: code }
  return { kind: 'transient', status, message: code }
}

export type { FailureKind }
