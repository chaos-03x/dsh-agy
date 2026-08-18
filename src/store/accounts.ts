/**
 * Account pool store: an interface plus a JSON-file implementation
 * (proper-lockfile cross-process mutual exclusion, 0600 permissions, versioned
 * migrations, AES-encrypted refresh tokens) and an in-memory fake for tests.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import type {
  AccountStorage,
  AccountStorageV1,
  AccountStorageV2,
  AccountStorageV3,
  AccountStorageV4,
  ManagedAccount,
} from '../types.ts'
import { assertOwnerOnly } from './keyring.ts'
import type { SecretCodec } from './keyring.ts'

export const CURRENT_STORAGE_VERSION = 4
const ENC_PREFIX = 'enc:v1:'

/** Cross-process file lock adapter (proper-lockfile behind a small seam for tests). */
export interface FileLock {
  withLock<T>(file: string, fn: () => Promise<T>): Promise<T>
}

export const properFileLock: FileLock = {
  async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const release = await lockfile.lock(file, {
      stale: 30_000,
      update: 10_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 50, maxTimeout: 2_000 },
    })
    try {
      return await fn()
    } finally {
      await release()
    }
  },
}

/** No-op lock for tests / single-process use. */
export const noopFileLock: FileLock = {
  async withLock<T>(_file: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  },
}

export interface AccountStore {
  /** Load the current (migrated) storage document. */
  load(): Promise<AccountStorageV4>
  /** Persist the full document (encrypting secrets). */
  save(storage: AccountStorageV4): Promise<void>
  /** Load-mutate-save atomically under the file lock; returns the mutation result. */
  mutate<T>(fn: (storage: AccountStorageV4) => T | Promise<T>): Promise<T>
}

export interface JsonAccountStoreOptions {
  file: string
  codec: SecretCodec
  lock?: FileLock
}

function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX)
}

/** Decrypt one account's refresh field when encrypted; plaintext passes through (legacy). */
function decryptAccount(account: ManagedAccount, codec: SecretCodec): ManagedAccount {
  if (isEncrypted(account.refresh)) {
    return { ...account, refresh: codec.decrypt(account.refresh) }
  }
  return account
}

/** Encrypt one account's refresh field (plaintext stays plaintext if no codec change). */
function encryptAccount(account: ManagedAccount, codec: SecretCodec): ManagedAccount {
  if (!isEncrypted(account.refresh)) {
    return { ...account, refresh: codec.encrypt(account.refresh) }
  }
  return account
}

export function ensureAccountIds(storage: AccountStorageV4): { storage: AccountStorageV4; mutated: boolean } {
  let mutated = false
  const seenIds = new Set<string>()
  for (const account of storage.accounts) {
    if (!account.id || seenIds.has(account.id)) {
      account.id = randomUUID()
      mutated = true
    }
    seenIds.add(account.id)
  }
  return { storage, mutated }
}

export function decryptStorage(storage: AccountStorageV4, codec: SecretCodec): AccountStorageV4 {
  return { ...storage, accounts: storage.accounts.map((a) => decryptAccount(a, codec)) }
}

export function encryptStorage(storage: AccountStorageV4, codec: SecretCodec): AccountStorageV4 {
  return { ...storage, accounts: storage.accounts.map((a) => encryptAccount(a, codec)) }
}
// ──── Migrations ────────────────────────────────────────────────────────────

export function migrateV1ToV2(v1: AccountStorageV1): AccountStorageV2 {
  return {
    version: 2,
    accounts: v1.accounts.map((acc) => ({
      email: acc.email,
      refreshToken: acc.refreshToken,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      lastSwitchReason: acc.lastSwitchReason,
      rateLimitResetTimes: acc.isRateLimited && acc.rateLimitResetTime
        ? { default: acc.rateLimitResetTime }
        : undefined,
    })),
    activeIndex: v1.activeIndex,
  }
}

export function migrateV2ToV3(v2: AccountStorageV2): AccountStorageV3 {
  return {
    version: 3,
    accounts: v2.accounts.map((acc) => ({
      email: acc.email,
      refresh: `${acc.refreshToken}|${acc.projectId ?? ''}|${acc.managedProjectId ?? ''}`,
      projectId: acc.projectId,
      managedProjectId: acc.managedProjectId,
      addedAt: acc.addedAt,
      lastUsed: acc.lastUsed,
      enabled: true,
      lastSwitchReason: acc.lastSwitchReason,
      rateLimitResetTimes: acc.rateLimitResetTimes,
    })),
    activeIndex: v2.activeIndex,
  }
}

export function migrateV3ToV4(v3: AccountStorageV3): AccountStorageV4 {
  return { version: 4, accounts: v3.accounts, activeIndex: v3.activeIndex }
}

export function migrateStorage(raw: AccountStorage): AccountStorageV4 {
  switch (raw.version) {
    case 1:
      return migrateStorage(migrateV1ToV2(raw))
    case 2:
      return migrateStorage(migrateV2ToV3(raw))
    case 3:
      return migrateStorage(migrateV3ToV4(raw))
    case 4:
      return raw
    default:
      throw new Error(`migrateStorage: unsupported storage version ${(raw as { version: number }).version}`)
  }
}

// ──── JSON file implementation ──────────────────────────────────────────────

export class JsonAccountStore implements AccountStore {
  private readonly file: string
  private readonly codec: SecretCodec
  private readonly lock: FileLock

  constructor(options: JsonAccountStoreOptions) {
    this.file = options.file
    this.codec = options.codec
    this.lock = options.lock ?? properFileLock
  }

  private ensureFile(): void {
    if (existsSync(this.file)) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-init`
    writeFileSync(tmp, JSON.stringify({ version: CURRENT_STORAGE_VERSION, accounts: [], activeIndex: 0 }) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private readAndMigrateUnlocked(): { storage: AccountStorageV4; mutated: boolean } {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { storage: { version: CURRENT_STORAGE_VERSION, accounts: [], activeIndex: 0 }, mutated: false }
      }
      throw error
    }
    assertOwnerOnly(this.file)
    const raw = JSON.parse(text) as AccountStorage
    const migrated = migrateStorage(raw)
    const decrypted = decryptStorage(migrated, this.codec)
    return ensureAccountIds(decrypted)
  }

  private writeUnlocked(storage: AccountStorageV4): void {
    const encrypted = encryptStorage(ensureAccountIds(storage).storage, this.codec)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(encrypted, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /**
   * Materialize and persist generated/repaired UUIDs under the file lock:
   * re-reads the fresh on-disk state under the lock so concurrent mutations
   * are never clobbered by a stale pre-lock snapshot.
   */
  private async materializeIdsWithLock(): Promise<AccountStorageV4> {
    this.ensureFile()
    return this.lock.withLock(this.file, async () => {
      const { storage, mutated } = this.readAndMigrateUnlocked()
      if (mutated) {
        this.writeUnlocked(storage)
      }
      return storage
    })
  }

  async load(): Promise<AccountStorageV4> {
    const { storage, mutated } = this.readAndMigrateUnlocked()
    if (mutated) {
      // Missing or duplicate IDs detected: atomically materialize and persist under the lock.
      return this.materializeIdsWithLock()
    }
    return storage
  }

  async save(storage: AccountStorageV4): Promise<void> {
    this.ensureFile()
    await this.lock.withLock(this.file, async () => {
      this.writeUnlocked(storage)
    })
  }

  async mutate<T>(fn: (storage: AccountStorageV4) => T | Promise<T>): Promise<T> {
    this.ensureFile()
    return this.lock.withLock(this.file, async () => {
      const { storage } = this.readAndMigrateUnlocked()
      const result = await fn(storage)
      this.writeUnlocked(storage)
      return result
    })
  }
}

// ──── In-memory fake (the second adapter that justifies the seam) ───────────

export class InMemoryAccountStore implements AccountStore {
  private storage: AccountStorageV4
  private mutateChain: Promise<unknown> = Promise.resolve()

  constructor(initial: AccountStorageV4 = { version: CURRENT_STORAGE_VERSION, accounts: [], activeIndex: 0 }) {
    this.storage = ensureAccountIds(initial).storage
  }

  async load(): Promise<AccountStorageV4> {
    const { storage, mutated } = ensureAccountIds(this.storage)
    if (mutated) this.storage = storage
    return structuredClone(this.storage)
  }

  async save(storage: AccountStorageV4): Promise<void> {
    this.storage = structuredClone(ensureAccountIds(storage).storage)
  }

  async mutate<T>(fn: (storage: AccountStorageV4) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const storage = structuredClone(ensureAccountIds(this.storage).storage)
      const result = await fn(storage)
      this.storage = ensureAccountIds(storage).storage
      return result
    }
    const next = this.mutateChain.then(run, run)
    this.mutateChain = next
    return next
  }
}

// ──── Pool helpers ──────────────────────────────────────────────────────────

/** Keep one account per email (case-insensitive), first occurrence wins. */
export function deduplicateAccountsByEmail(accounts: ManagedAccount[]): ManagedAccount[] {
  const seen = new Set<string>()
  const result: ManagedAccount[] = []
  for (const account of accounts) {
    const key = account.email?.toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    result.push(account)
  }
  return result
}

/** Pick the active account, falling back to the first enabled one. */
export function resolveActiveAccount(
  storage: AccountStorageV4,
): { account: ManagedAccount; index: number } | undefined {
  const accounts = storage.accounts
  if (accounts.length === 0) return undefined
  const active = accounts[storage.activeIndex]
  if (active && active.enabled !== false) return { account: active, index: storage.activeIndex }
  const fallbackIndex = accounts.findIndex((a) => a.enabled !== false)
  if (fallbackIndex === -1) return undefined
  return { account: accounts[fallbackIndex]!, index: fallbackIndex }
}
