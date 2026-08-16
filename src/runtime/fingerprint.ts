/**
 * Device fingerprint generation for rate-limit mitigation (two layers):
 *
 * 1. Per-request randomized headers — platform/arch/SDK-client pools.
 * 2. Per-account persistent fingerprint — deviceId/sessionToken/UA snapshot
 *    with bounded history (≤5 versions, restorable), regenerated when an
 *    account's capacity looks exhausted.
 *
 * All tunable pools live in fingerprint-data.json so they can be updated
 * without a code release (the reference implementation stopped at an old
 * version string once archived — that staleness is the detectable signal).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { ClientMetadata, Fingerprint, FingerprintVersion } from '../types.ts'
import fingerprintData from './fingerprint-data.json'

export interface FingerprintData {
  versionPool: string[]
  platforms: string[]
  architectures: string[]
  osVersions: Record<string, string[]>
  sdkClients: string[]
  ideTypes: string[]
  pluginTypes: string[]
}

export const DEFAULT_FINGERPRINT_DATA = fingerprintData as FingerprintData

export const MAX_FINGERPRINT_HISTORY = 5

const USER_OVERRIDE_FILE = 'agy-fingerprint-data.json'

/**
 * Effective fingerprint data: a user override at `$DSH_HOME/agy-fingerprint-data.json`
 * wins when present and parseable (hot-updatable without a code release — the
 * bundled copy is compiled in), otherwise the bundled defaults.
 */
let cachedData: FingerprintData | null = null
export function getFingerprintData(): FingerprintData {
  if (cachedData) return cachedData
  try {
    const dshHome = process.env.DSH_HOME ? process.env.DSH_HOME : join(process.env.HOME ?? '.', '.dsh')
    const overrideFile = join(dshHome, USER_OVERRIDE_FILE)
    if (existsSync(overrideFile)) {
      const parsed = JSON.parse(readFileSync(overrideFile, 'utf8')) as FingerprintData
      if (parsed && Array.isArray(parsed.versionPool) && parsed.versionPool.length > 0) {
        cachedData = parsed
        return cachedData
      }
    }
  } catch {
    // unreadable override — fall through to bundled defaults
  }
  cachedData = DEFAULT_FINGERPRINT_DATA
  return cachedData
}

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

/** Generate a randomized device fingerprint representing one apparent device. */
export function generateFingerprint(
  data: FingerprintData = getFingerprintData(),
  version = randomFrom(data.versionPool),
): Fingerprint {
  const platform = randomFrom(data.platforms)
  return {
    deviceId: randomUUID(),
    sessionToken: randomBytes(16).toString('hex'),
    userAgent: `antigravity/${version} ${platform}`,
    apiClient: randomFrom(data.sdkClients),
    // Client-Metadata must only transmit ideType (backend enum validation
    // rejects freely-added platform/pluginType; AGENTS.md invariant).
    clientMetadata: {
      ideType: randomFrom(data.ideTypes),
    },
    createdAt: Date.now(),
  }
}

/** The only header composed from a fingerprint (the rest are per-request random). */
export function buildFingerprintHeaders(fingerprint: Fingerprint | null): { 'User-Agent'?: string } {
  if (!fingerprint) return {}
  return { 'User-Agent': fingerprint.userAgent }
}

/** Per-request randomized headers (platform + SDK client pools). */
export function getRandomizedHeaders(
  data: FingerprintData = getFingerprintData(),
  version = randomFrom(data.versionPool),
): { 'User-Agent': string; 'X-Goog-Api-Client': string; 'Client-Metadata': string } {
  const platform = randomFrom(data.platforms)
  return {
    'User-Agent': `antigravity/${version} ${platform}`,
    'X-Goog-Api-Client': randomFrom(data.sdkClients),
    'Client-Metadata': JSON.stringify({
      ideType: randomFrom(data.ideTypes),
    }),
  }
}

/**
 * Deterministic fallback headers for the `stable` fingerprint mode: the first
 * entry of each pool, every call — one fixed client identity instead of
 * per-request randomization (OMP-style fixed-client posture).
 */
export function getStableHeaders(
  data: FingerprintData = getFingerprintData(),
  version = data.versionPool[0] ?? '',
): { 'User-Agent': string; 'X-Goog-Api-Client': string; 'Client-Metadata': string } {
  const platform = data.platforms[0] ?? 'windows/amd64'
  return {
    'User-Agent': `antigravity/${version || '1.18.3'} ${platform}`,
    'X-Goog-Api-Client': data.sdkClients[0] ?? '',
    'Client-Metadata': JSON.stringify({
      ideType: data.ideTypes[0] ?? 'ANTIGRAVITY',
    }),
  }
}

/** Rewrite the version inside a fingerprint UA; reports whether it changed. */
export function updateFingerprintVersion(fingerprint: Fingerprint, version: string): boolean {
  const pattern = /^(antigravity\/)([\d.]+)/
  const match = fingerprint.userAgent.match(pattern)
  if (!match || match[2] === version) return false
  fingerprint.userAgent = fingerprint.userAgent.replace(pattern, `$1${version}`)
  return true
}

/** Append a fingerprint to the account history (bounded), then use it as current. */
export function recordFingerprintVersion(
  history: FingerprintVersion[] | undefined,
  fingerprint: Fingerprint,
  reason: FingerprintVersion['reason'],
): FingerprintVersion[] {
  const next = [...(history ?? []), { fingerprint, timestamp: Date.now(), reason }]
  return next.slice(-MAX_FINGERPRINT_HISTORY)
}

/**
 * Restore a stable prior identity: the oldest restorable fingerprint
 * (`initial`, else most recent `restored`). Returns `current` when the history
 * holds nothing restorable (e.g. the initial entry was evicted).
 */
export function restoreFingerprint(
  history: FingerprintVersion[] | undefined,
  current: Fingerprint | undefined,
): Fingerprint | undefined {
  if (!history || history.length === 0) return current
  const initial = history.find((v) => v.reason === 'initial')
  const restored = [...history].reverse().find((v) => v.reason === 'restored')
  const restorable = initial ?? restored
  if (!restorable) return current
  return restorable.fingerprint
}
