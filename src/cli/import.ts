/**
 * Import agy credentials: parse the `agy` CLI auth.json token file or a
 * paste credential blob, enrich with the Code Assist backend (email/project),
 * and persist into the account store. Adapted from OmniRoute's agyAuthImport
 * (MIT, see NOTICE.md).
 */
import { randomUUID } from 'node:crypto'
import { AGY_ENDPOINT_FALLBACKS, getAgyBootstrapClientMetadata, getAgyBootstrapUserAgent } from '../oauth/constants.ts'
import { decodeCredentialBlob } from '../oauth/blob.ts'
import { proxiedFetch } from '../proxy.ts'
import type { AccountStore } from '../store/accounts.ts'
import type { ManagedAccount } from '../types.ts'

export class AgyAuthFileError extends Error {
  status: number
  code: string

  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message)
    this.name = 'AgyAuthFileError'
    this.status = status
    this.code = code
  }
}

export interface ParsedAgyAuth {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresAt: string | null
  authMethod: string | null
  clientId?: string | null
}

export interface EnrichedAgyAuth extends ParsedAgyAuth {
  email: string | null
  projectId: string | null
  clientId?: string | null
}
function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Parse the agy CLI token file: tokens nest under `.token` with an ISO
 * `expiry` string and no id_token; a flat top-level shape is accepted too.
 */
export function parseAndValidateAgyToken(raw: unknown): ParsedAgyAuth {
  const doc = toRecord(raw)
  const token = toRecord(doc.token ?? doc)

  const accessToken = toNonEmptyString(token.access_token)
  const refreshToken = toNonEmptyString(token.refresh_token)
  if (!accessToken) throw new AgyAuthFileError('access_token is missing or empty in the agy token file', 400, 'missing_access_token')
  if (!refreshToken) throw new AgyAuthFileError('refresh_token is missing or empty in the agy token file', 400, 'missing_refresh_token')

  let expiresAt: string | null = null
  const isoExpiry = toNonEmptyString(token.expiry) ?? toNonEmptyString(token.expires_at)
  if (isoExpiry) {
    const ms = new Date(isoExpiry).getTime()
    expiresAt = Number.isNaN(ms) ? null : new Date(ms).toISOString()
  } else if (typeof token.expiry_date === 'number' && Number.isFinite(token.expiry_date)) {
    expiresAt = new Date(token.expiry_date).toISOString()
  }

  return {
    accessToken,
    refreshToken,
    tokenType: toNonEmptyString(token.token_type) ?? 'Bearer',
    expiresAt,
    authMethod: toNonEmptyString(doc.auth_method) ?? toNonEmptyString(token.auth_method),
    clientId: toNonEmptyString(token.client_id) ?? toNonEmptyString(doc.client_id) ?? toNonEmptyString(token.clientId) ?? toNonEmptyString(doc.clientId),
  }
}

/** Best-effort enrichment: email (userinfo) + projectId (loadCodeAssist), time-boxed. */
export async function enrichWithAntigravityBackend(parsed: ParsedAgyAuth): Promise<EnrichedAgyAuth> {
  let email: string | null = null
  let projectId: string | null = null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await proxiedFetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${parsed.accessToken}` },
      signal: controller.signal,
    })
    if (res.ok) {
      email = toNonEmptyString(toRecord(await res.json()).email)
    }
  } catch {
    // best effort — email stays null
  } finally {
    clearTimeout(timer)
  }

  const loadController = new AbortController()
  const loadTimer = setTimeout(() => loadController.abort(), 8000)
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${parsed.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': getAgyBootstrapUserAgent(),
      'Client-Metadata': getAgyBootstrapClientMetadata(),
    }
    for (const endpoint of AGY_ENDPOINT_FALLBACKS) {
      try {
        const res = await proxiedFetch(`${endpoint}/v1internal:loadCodeAssist`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
          signal: loadController.signal,
        })
        if (!res.ok) continue
        const data = toRecord(await res.json())
        const project = data.cloudaicompanionProject
        projectId = (typeof project === 'string' ? toNonEmptyString(project) : null)
          ?? toNonEmptyString(toRecord(project).id)
        if (projectId) break
      } catch {
        // try next endpoint
      }
    }
  } catch {
    // best effort — projectId stays null
  } finally {
    clearTimeout(loadTimer)
  }

  return {
    ...parsed,
    email,
    projectId,
    clientId: parsed.clientId ?? null,
  }
}

/** Parse either a raw token document or a paste blob into an enriched account. */
export async function parseImportSource(source: unknown, kind: 'json' | 'blob'): Promise<EnrichedAgyAuth> {
  if (kind === 'blob') {
    if (typeof source !== 'string') throw new AgyAuthFileError('blob must be a string', 400, 'invalid_blob')
    const blob = decodeCredentialBlob(source)
    return enrichWithAntigravityBackend(
      parseAndValidateAgyToken({ token: blob.tokens, auth_method: 'paste-blob' }),
    )
  }
  return enrichWithAntigravityBackend(parseAndValidateAgyToken(source))
}

/** Batch-import many sources (CLI multi-file / web multi-line paste). Each item
 * is independent: a failure is collected, the rest still import. */
export async function importManySources(
  items: Array<{ source: unknown; kind: 'json' | 'blob' }>,
  store: AccountStore,
  options: { email?: string; overwriteExisting?: boolean } = {},
): Promise<{ imported: number; replaced: number; errors: string[] }> {
  const result = { imported: 0, replaced: 0, errors: [] as string[] }
  for (const item of items) {
    try {
      const enriched = await parseImportSource(item.source, item.kind)
      const { created } = await upsertImportedAccount(store, enriched, options)
      if (created) result.imported++
      else result.replaced++
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return result
}

/** Upsert the account into the store, deduping by email. */
export async function upsertImportedAccount(
  store: AccountStore,
  enriched: EnrichedAgyAuth,
  options: { email?: string; overwriteExisting?: boolean } = {},
): Promise<{ account: ManagedAccount; created: boolean }> {
  const resolvedEmail = options.email || enriched.email
  const refresh = `${enriched.refreshToken}|${enriched.projectId ?? ''}`

  return store.mutate((storage) => {
    const existingIndex = resolvedEmail
      ? storage.accounts.findIndex((a) => a.email?.toLowerCase() === resolvedEmail.toLowerCase())
      : -1

    if (existingIndex !== -1) {
      if (!options.overwriteExisting) {
        throw new AgyAuthFileError(
          'An agy account for this email already exists. Pass --overwrite to replace it.',
          409,
          'duplicate_account',
        )
      }
      const existing = storage.accounts[existingIndex]!
      storage.accounts[existingIndex] = {
        ...existing,
        id: existing.id || randomUUID(),
        refresh,
        email: existing.email ?? resolvedEmail ?? undefined,
        clientId: enriched.clientId ? enriched.clientId : existing.clientId,
        addedAt: existing.addedAt,
        lastUsed: Date.now(),
        enabled: true,
        verificationRequired: false,
        verificationRequiredAt: undefined,
        verificationRequiredReason: undefined,
      }
      return { account: storage.accounts[existingIndex]!, created: false }
    }

    const account: ManagedAccount = {
      id: randomUUID(),
      email: resolvedEmail ?? undefined,
      refresh,
      projectId: enriched.projectId ?? undefined,
      clientId: enriched.clientId ?? undefined,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      enabled: true,
    }
    storage.accounts.push(account)
    if (storage.activeIndex >= storage.accounts.length - 1 && storage.accounts.length === 1) {
      storage.activeIndex = 0
    }
    return { account, created: true }
  })
}
