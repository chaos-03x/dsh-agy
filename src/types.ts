/** Shared domain types for dsh-agy. */

/**
 * Device fingerprint persisted per account (rate-limit mitigation).
 * Client-Metadata must only transmit ideType: the backend's enum validation
 * rejects freely-added platform/pluginType fields (AGENTS.md invariant).
 */
export interface ClientMetadata {
  ideType: string
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

/** Per-account quota cache keyed by model id. */
export interface CachedQuota {
  remainingFraction?: number
  resetTime?: string
  modelCount?: number
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
  verificationRequired?: boolean
  verificationRequiredAt?: number
  verificationRequiredReason?: string
  verificationUrl?: string
  fingerprint?: Fingerprint
  fingerprintHistory?: FingerprintVersion[]
  cachedQuota?: Record<string, CachedQuota>
  cachedQuotaUpdatedAt?: number
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
  /** Fingerprint + randomized impersonation headers for this request. */
  impersonation: {
    'User-Agent': string
    'X-Goog-Api-Client': string
    'Client-Metadata': string
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
  | 'network-error'
  | 'project-error'
  | 'request-error'
  | 'transient'

/** Rotation state machine decision for one failed attempt. */
export type RotationAction =
  | { action: 'retry'; backoffMs: number }
  | { action: 'cool'; backoffMs: number }
  | { action: 'rotate'; backoffMs: number }
  | { action: 'revoke' }
  /** Permanent request-construction error: no state change, surface as-is. */
  | { action: 'noop' }
