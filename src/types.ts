/** Shared domain types for dsh-agy. */

/**
 * Device fingerprint persisted per account (rate-limit mitigation).
 *
 * Mirrors `google.internal.cloud.code.v1internal.ClientMetadata`, read out of the
 * installed official CLI's own descriptor (`docs/official-identity.json`). The
 * message has eight fields; only the three below are populated, because the rest
 * (`pluginVersion`, `updateChannel`, `duetProject`, `pluginType`, `ideName`) have
 * no captured value and a wrong value is a worse anomaly than an absent one.
 *
 * This is the BODY message (`metadata`), not a header. Nothing here is sent as a
 * `Client-Metadata` header: neither official binary contains that header name.
 */
export interface ClientMetadata {
  ideType: string
  /** Client version for the claimed product line (the CLI's, not the IDE's). */
  ideVersion?: string
  /**
   * `ClientMetadata.platform` enum NAME (`DARWIN_ARM64`), which is a DIFFERENT
   * vocabulary from the UA's `darwin/arm64` token — both exist, and conflating
   * them is how `"MACOS"` came to be sent and rejected.
   */
  platform?: string
}

export interface Fingerprint {
  deviceId: string
  sessionToken: string
  userAgent: string
  apiClient: string
  clientMetadata: ClientMetadata
  createdAt: number
}

export interface FingerprintVersion {
  fingerprint: Fingerprint
  timestamp: number
  reason: 'initial' | 'regenerated' | 'restored'
}

export type CooldownReason =
  | 'auth-failure'
  | 'network-error'
  | 'project-error'
  | 'quota-exhausted'
  | 'validation-required'

/**
 * Per-account quota cache keyed by model FAMILY (`google` / `anthropic` /
 * `openai`, or `unknown`) — never by model id. See `familyKeyOf` in
 * `runtime/quota.ts`.
 *
 * The keying is load-bearing for the fields below: a family has exactly ONE
 * record, so a family-scoped reading stored here cannot disagree with a
 * per-model copy of itself, and there is no second key to keep in sync.
 */
export interface CachedQuota {
  /** 0..1 left in the family's rolling 5-hour window. */
  remainingFraction?: number
  /** When the 5-hour window refills (RFC3339). */
  resetTime?: string
  /**
   * 0..1 left in the family's 7-day window, when `retrieveUserQuotaSummary`
   * reported one.
   *
   * A genuinely SEPARATE window, not a second view of `remainingFraction`: the
   * 5-hour bucket refills four times a day while the weekly budget only drains,
   * so an account can be comfortable on one and exhausted on the other.
   *
   * It always travels with its own `weeklyResetTime`, and that timestamp is what
   * bounds the value's life: once it passes, every consumer ignores the reading
   * (`isFamilyDrained`, `parseFutureResetMs`, `rankPoolCandidates`), so a weekly
   * value carried forward across a failed probe cannot outlive its window.
   */
  weeklyFraction?: number
  /** When the 7-day window refills (RFC3339). */
  weeklyResetTime?: string
  /** How many models the per-model probe contributed to this family's reading. */
  modelCount?: number
}

/**
 * One window of one `QuotaGroup`, as `retrieveUserQuotaSummary` reports it.
 *
 * Declared here (the dependency-free leaf) because it is PERSISTED on the
 * account; the parser that produces it lives in `adapter/quota-summary.ts`, which
 * imports this module rather than the reverse.
 */
export interface QuotaWindow {
  /** Upstream's own bucket id, e.g. `gemini-5h`, `3p-weekly`. Kept verbatim. */
  bucketId: string
  /** Upstream's window token: `5h` or `weekly` today. */
  window: string
  /** 0..1, or null when upstream omitted the fraction (unknown, not empty). */
  remainingFraction: number | null
  /** RFC3339 reset moment, or null when upstream omitted it. */
  resetTime: string | null
}

/** One group of models sharing a 5-hour and a weekly window. */
export interface QuotaGroup {
  /** Upstream's group label, e.g. `Gemini Models`. */
  name: string
  windows: QuotaWindow[]
}

/**
 * The grouped 5-hour / weekly windows, cached per account.
 *
 * Deliberately SEPARATE from `cachedQuota`: that map is per-FAMILY and feeds the
 * rotation/ranking path (`familyQuotaFor`, `isFamilyDrained`), while this is
 * per-GROUP and display-only. Merging them would put two different shapes under
 * one key and let a display refresh influence scheduling.
 */
export interface CachedLimits {
  groups: QuotaGroup[]
  /** When this snapshot was taken (Unix ms). */
  updatedAt: number
}

/** One account in the pool. `refresh` is the packed `refreshToken|projectId|managedProjectId` string. */
export interface ManagedAccount {
  id?: string
  email?: string
  refresh: string
  projectId?: string
  managedProjectId?: string
  clientId?: string
  addedAt: number
  lastUsed: number
  enabled?: boolean
  rateLimitResetTimes?: Record<string, number>
  coolingDownUntil?: number
  cooldownReason?: CooldownReason
  /**
   * When the CURRENT cooldown began (Unix ms).
   *
   * Separate from `coolingDownUntil`, which is its END: the duration is a
   * backoff computed from the consecutive-failure count, so the start cannot be
   * recovered from the end. Persisted because the reason is only useful with an
   * age attached — "network-error" alone cannot distinguish a blip from seconds
   * ago from one that has been sitting there for days. Cleared together with
   * `cooldownReason` when the window expires.
   */
  cooldownSetAt?: number
  verificationRequired?: boolean
  verificationRequiredAt?: number
  verificationRequiredReason?: string
  verificationUrl?: string
  fingerprint?: Fingerprint
  fingerprintHistory?: FingerprintVersion[]
  cachedQuota?: Record<string, CachedQuota>
  cachedQuotaUpdatedAt?: number
  /** Grouped 5h/weekly windows, display-only (see `CachedLimits`). */
  cachedLimits?: CachedLimits
  /** Per-account proxy URL (e.g. http://user:pass@host:8080 or socks5://host:1080). Undefined = follow env. */
  proxy?: string
}

export interface AccountStorageV1 {
  version: 1
  accounts: Array<{
    email?: string
    refreshToken: string
    projectId?: string
    managedProjectId?: string
    addedAt: number
    lastUsed: number
    isRateLimited?: boolean
    rateLimitResetTime?: number
    lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
  }>
  activeIndex: number
}

export interface AccountStorageV2 {
  version: 2
  accounts: Array<{
    email?: string
    refreshToken: string
    projectId?: string
    managedProjectId?: string
    addedAt: number
    lastUsed: number
    lastSwitchReason?: 'rate-limit' | 'initial' | 'rotation'
    rateLimitResetTimes?: Record<string, number>
  }>
  activeIndex: number
}

export interface AccountStorageV3 {
  version: 3
  accounts: ManagedAccount[]
  activeIndex: number
}

export interface AccountStorageV4 {
  version: 4
  accounts: ManagedAccount[]
  activeIndex: number
}

export type AccountStorage = AccountStorageV1 | AccountStorageV2 | AccountStorageV3 | AccountStorageV4

/**
 * How one account-scoped request is routed — and therefore how its transport
 * failures must be read. `proxyUrl` is the single source of truth: fail-closed
 * applies exactly when it is set, so routing and failure classification can
 * never disagree (splitting them into two arguments let them drift).
 */
export interface AccountRouting {
  /** Per-account proxy; unset means the env/direct route. */
  proxyUrl?: string
  /**
   * Generation stream: long model silences are normal, so the per-gap body
   * inactivity timer must be disabled (AGENTS.md "Proxy Routing").
   */
  streaming?: boolean
}

/** Whether a request ran through an explicit per-account proxy. */
export function isProxyRouted(routing: AccountRouting | undefined): boolean {
  return Boolean(routing?.proxyUrl)
}

/** Parsed halves of the packed refresh string. */
export interface RefreshParts {
  refreshToken?: string
  projectId?: string
  managedProjectId?: string
}

/** OAuth token view of an account used by the refresh path. */
export interface OAuthAuthDetails {
  access: string
  expires: number
  refresh: string
}

/** Result of the OAuth token exchange. */
export interface TokenExchangeSuccess {
  type: 'success'
  refresh: string
  access: string
  expires: number
  email?: string
  projectId: string
  tier?: string
  clientId?: string
}

export interface TokenExchangeFailure {
  type: 'failed'
  error: string
}

export type TokenExchangeResult = TokenExchangeSuccess | TokenExchangeFailure

export interface AgyAccountSession {
  auth: OAuthAuthDetails
  account: ManagedAccount
  index: number
  /**
   * Impersonation headers for this request.
   *
   * `clientMetadata` rides alongside rather than inside: it is a BODY message
   * (`metadata` on the control-plane calls), because the `Client-Metadata` header
   * this used to be is present in neither official binary.
   */
  impersonation: {
    'User-Agent': string
    'X-Goog-Api-Client': string
    clientMetadata: ClientMetadata
  }
}

/** Authentication failure while resolving an account session. */
export type AgyAuthErrorKind = 'transport' | 'rate-limit' | 'invalid-credential'

/**
 * Host-independent authentication error. The adapter maps `kind` to the DSH
 * error protocol without coupling the session or CLI layers to dsh-llm.
 */
export class AgyAuthError extends Error {
  readonly kind: AgyAuthErrorKind

  constructor(kind: AgyAuthErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AgyAuthError'
    this.kind = kind
  }
}

/** Why an enabled account pool cannot currently serve one model family. */
export type PoolBlockedKind = 'retryable' | 'quota-exhausted'

/**
 * Enabled accounts exist, but every candidate is temporarily blocked. Kept
 * independent of dsh-llm so CLI and web entry points do not gain a host import.
 */
export class AgyPoolBlockedError extends Error {
  readonly kind: PoolBlockedKind
  readonly blockedUntil: number

  constructor(kind: PoolBlockedKind, blockedUntil: number) {
    super(kind === 'quota-exhausted'
      ? 'All agy accounts have exhausted quota for the requested model family.'
      : 'All agy accounts are temporarily blocked for the requested model family.')
    this.name = 'AgyPoolBlockedError'
    this.kind = kind
    this.blockedUntil = blockedUntil
  }
}

/** Classified upstream failure kinds consumed by the rotation state machine. */
export type FailureKind =
  | 'rate-limit'
  | 'auth-failure'
  /**
   * Upstream asked for account verification (`VALIDATION_REQUIRED`) rather than
   * rejecting the credential. Deliberately distinct from `auth-failure` because
   * it is RECOVERABLE: the account is temporarily walled, not dead, and the user
   * can act on the returned URL. Treating it as `auth-failure` permanently
   * disabled a healthy account on a signal that meant "come back after
   * verifying", with no automatic way back.
   */
  | 'verification-required'
  | 'network-error'
  | 'project-error'
  | 'request-error'
  | 'transient'
  | 'proxy-unreachable'

/**
 * Rotation state machine decision for one failed attempt.
 *
 * `backoffMs` is **advisory**, and for `retry`/`rotate` no caller consumes it.
 * It is not the mechanism that paces the pool: the account-level `cool` paths
 * write it into `coolingDownUntil` themselves, `rotate` blocks the failed
 * account through `rateLimitResetTimes`, and the delay before the retry of a
 * single request belongs to DSH's retry policy (`providerRetryAfterMs`, else its
 * own exponential `localDelay`). Do NOT "wire it up" by feeding it into
 * `providerRetryAfterMs`: a tier above DSH's `maxDelayMs` makes the normal retry
 * mode give up entirely, turning a recoverable 5xx into a failed turn.
 */
export type RotationAction =
  | { action: 'retry'; backoffMs: number }
  | { action: 'cool'; backoffMs: number }
  | { action: 'rotate'; backoffMs: number }
  | { action: 'revoke' }
  /** Permanent request-construction error: no state change, surface as-is. */
  | { action: 'noop' }
