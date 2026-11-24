/**
 * Core binary resolution for the embedded Clash/Mihomo egress.
 *
 * The promise this file keeps is "zero ops": a user who has never installed any
 * Clash client fills in a subscription URL and the plugin fetches a core for
 * them. That is why the binary is DOWNLOADED rather than required, and why the
 * download is pinned to one known release instead of "latest" — a plugin that
 * silently upgrades its own proxy core is a supply-chain surface nobody asked
 * for.
 *
 * Precedence:
 *  1. `DSH_AGY_CLASH_CORE` — an explicit path (tests, air-gapped hosts, or a
 *     user who already has a core they trust).
 *  2. `$DSH_HOME/agy/clash/mihomo[.exe]` — a previous download.
 *  3. Download that release asset, verify it is a real binary, and install it.
 *
 * Nothing here talks to the network unless a download is actually needed.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import AdmZip from 'adm-zip'
import { agyDataDir } from '../store/paths.ts'
import { CORE_PATH_ENV } from './types.ts'

/** Pinned core release. Bumping it is a deliberate, reviewable change. */
export const DEFAULT_CORE_VERSION = '1.19.34'

const RELEASE_BASE = 'https://github.com/MetaCubeX/mihomo/releases/download'

export interface CoreAsset {
  /** Release asset file name. */
  asset: string
  /** Executable name after extraction. */
  binary: string
  /** Archive kind decides the extraction path. */
  archive: 'zip' | 'gz'
}

/**
 * Release asset for the running platform.
 *
 * The `-compatible` windows/linux builds are used where they exist: they are the
 * plain Go build without the amd64 v2/v3 micro-architecture levels, which is the
 * safe default for a binary we cannot test on the user's CPU.
 */
export function coreAssetFor(platform: NodeJS.Platform = process.platform, arch: string = process.arch, version = DEFAULT_CORE_VERSION): CoreAsset {
  if (platform === 'win32') {
    if (arch === 'arm64') return { asset: `mihomo-windows-arm64-v${version}.zip`, binary: 'mihomo.exe', archive: 'zip' }
    return { asset: `mihomo-windows-amd64-compatible-v${version}.zip`, binary: 'mihomo.exe', archive: 'zip' }
  }
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? { asset: `mihomo-darwin-arm64-v${version}.gz`, binary: 'mihomo', archive: 'gz' }
      : { asset: `mihomo-darwin-amd64-compatible-v${version}.gz`, binary: 'mihomo', archive: 'gz' }
  }
  return arch === 'arm64'
    ? { asset: `mihomo-linux-arm64-v${version}.gz`, binary: 'mihomo', archive: 'gz' }
    : { asset: `mihomo-linux-amd64-compatible-v${version}.gz`, binary: 'mihomo', archive: 'gz' }
}

/** Directory holding the downloaded core. */
export function coreDir(dshHome?: string): string {
  return join(agyDataDir(dshHome), 'clash')
}

export interface ResolveCoreOptions {
  dshHome?: string
  version?: string
  fetchImpl?: typeof fetch
  /** Extraction hook, injected so tests never need a zip on disk. */
  extract?: (asset: CoreAsset, bytes: Uint8Array) => Uint8Array
}

/**
 * Pull the core binary out of a downloaded archive.
 *
 * Name matching is deliberately loose. The real release ships
 * `mihomo-windows-amd64-compatible.exe`, not `mihomo.exe`, so an exact-basename
 * match rejected a perfectly good download; the rule is "the largest entry whose
 * name mentions mihomo", falling back to the only file in a single-file archive.
 */
export function extractDownloadedCore(asset: CoreAsset, bytes: Uint8Array): Uint8Array {
  if (asset.archive === 'gz') return new Uint8Array(gunzipSync(bytes))
  // Windows ships a zip; extracting it needs a real unzip, which is why the
  // package depends on `adm-zip` (pure JS, no native build).
  const zip = new AdmZip(Buffer.from(bytes))
  const files = zip.getEntries().filter((e) => !e.isDirectory)
  const named = files.filter((e) => /mihomo/i.test(e.entryName))
  // A rename in a future release should still work, but a stray README must not:
  // the fallback only accepts a single, plausibly executable blob.
  const fallback = files.filter((e) => e.header.size >= 1_048_576 && !/\.(md|txt|json|ya?ml|dat|sha256)$/i.test(e.entryName))
  const pool = named.length > 0 ? named : fallback
  if (pool.length === 0) throw new Error('downloaded archive does not contain a mihomo binary')
  const entry = pool.reduce((best, current) => (current.header.size > best.header.size ? current : best))
  return new Uint8Array(entry.getData())
}

/**
 * Resolve (and if necessary download) the core executable.
 *
 * Throws with an actionable message on every failure path: a download failure
 * must not look like "the proxy is off", because the user then has no idea what
 * to fix.
 */
export async function resolveCoreBinary(options: ResolveCoreOptions = {}): Promise<string> {
  const override = process.env[CORE_PATH_ENV]
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new Error(`${CORE_PATH_ENV} points at a missing file: ${override}`)
    return override
  }

  const version = options.version ?? DEFAULT_CORE_VERSION
  const asset = coreAssetFor(process.platform, process.arch, version)
  const dir = coreDir(options.dshHome)
  const target = join(dir, asset.binary)
  if (existsSync(target)) return target

  mkdirSync(dir, { recursive: true })
  const fetchImpl = options.fetchImpl ?? fetch
  const url = `${RELEASE_BASE}/v${version}/${asset.asset}`
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`core download failed: HTTP ${response.status} for ${asset.asset}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const binary = (options.extract ?? extractDownloadedCore)(asset, bytes)
  if (binary.byteLength < 1_000_000) {
    // A truncated download or an error page would otherwise be installed and
    // then fail at spawn with an opaque "not a valid Win32 application".
    throw new Error(`core download looks truncated (${binary.byteLength} bytes)`)
  }
  const tmp = `${target}.download`
  writeFileSync(tmp, binary, { mode: 0o755 })
  if (process.platform !== 'win32') chmodSync(tmp, 0o755)
  renameSync(tmp, target)
  return target
}

/** Remove a core this plugin installed (used by the uninstall docs and tests). */
export function removeDownloadedCore(dshHome?: string): void {
  rmSync(coreDir(dshHome), { recursive: true, force: true })
}

/** Read a downloaded core's size without loading it (diagnostics). */
export function coreBinarySize(path: string): number {
  try {
    return readFileSync(path).byteLength
  } catch {
    return 0
  }
}
