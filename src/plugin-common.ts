/**
 * Shared runtime construction for the in-harness plugin entries: master-key
 * codec resolution (credentials seam first, credentials document fallback),
 * account store, session manager, and adapter. Used by the main plugin
 * (adapter registration) and the web plugin (route registration) so both
 * entries operate on the same store.
 */

import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { AgyAdapter } from './adapter/adapter.ts'
import type { AgyAttachments } from './adapter/adapter.ts'
import { AGY_PROVIDER } from './adapter/models.ts'
import { resolveAntigravityVersion } from './runtime/version.ts'
import { AgySessionManager } from './session.ts'
import { JsonAccountStore } from './store/accounts.ts'
import type { AccountStore } from './store/accounts.ts'
import {
  MASTER_KEY_REF,
  createAesGcmCodec,
  deriveKey,
  loadMasterKey,
  persistMasterKey,
  resolveDshHome,
  resolveMasterKeyCodec,
} from './store/keyring.ts'
import type { SecretCodec } from './store/keyring.ts'

export interface CredentialsSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
  set(ref: string, value: string): Promise<void>
}

function codecFrom(masterKey: string): SecretCodec {
  return createAesGcmCodec(deriveKey(masterKey))
}

/** Resolve or create the master key, preferring the credentials seam when available. */
export async function resolveCodec(ctx: Context): Promise<{ codec: SecretCodec; created: boolean }> {
  const dshHome = resolveDshHome()
  const credentials = ctx.get('credentials') as CredentialsSeam | undefined

  if (credentials) {
    const resolved = await credentials.resolve(MASTER_KEY_REF)
    if (resolved) return { codec: codecFrom(resolved.value), created: false }
    const fileKey = loadMasterKey(dshHome)
    if (fileKey) return { codec: codecFrom(fileKey), created: false }
    const fresh = randomBytes(32).toString('hex')
    try {
      await credentials.set(MASTER_KEY_REF, fresh)
      return { codec: codecFrom(fresh), created: true }
    } catch {
      // Read-only shadowing: persist to the credentials document directly.
      persistMasterKey(dshHome, fresh)
      return { codec: codecFrom(fresh), created: true }
    }
  }

  return resolveMasterKeyCodec(dshHome)
}

/** Build the store, session manager, and adapter for one plugin entry. */
export async function createAgyRuntime(ctx: Context): Promise<{
  store: AccountStore
  sessions: AgySessionManager
  adapter: AgyAdapter
}> {
  // Warm the version cache (non-blocking) so fingerprint generation inside
  // the rate-limit path never waits on a cold feed.
  void resolveAntigravityVersion().catch(() => {})
  const { codec } = await resolveCodec(ctx)
  const dshHome = resolveDshHome()
  const store = new JsonAccountStore({ file: `${dshHome}/agy-accounts.json`, codec })
  const sessions = new AgySessionManager({ store })
  // Optional background health probe (DSH_AGY_HEALTH_INTERVAL_MS), off by default.
  const healthIntervalMs = Number(process.env.DSH_AGY_HEALTH_INTERVAL_MS ?? 0)
  if (Number.isFinite(healthIntervalMs) && healthIntervalMs > 0) {
    sessions.startHealthProbe(healthIntervalMs)
  }
  const adapter = new AgyAdapter({
    getSession: (model) => sessions.getSession(model),
    reportFailure: (kind, session, info) => sessions.reportFailure(kind, session, info),
    markSuccess: (session) => sessions.markSuccess(session),
    // Optional DSH seam (the same strict-ctx.get pattern as the credentials
    // seam above): the attachment service activates before the llm service in
    // the base bundle, so a lazy lookup at stream time is always live when it
    // exists at all. Absent -> image requests fail loudly (UNSUPPORTED_CONTENT).
    attachments: () => ctx.get('attachments') as unknown as AgyAttachments | undefined,
  })
  return { store, sessions, adapter }
}

export { AGY_PROVIDER }
