/**
 * Core binary resolution. The download path is exercised with a synthetic zip:
 * the real release names its windows entry `mihomo-windows-amd64-compatible.exe`
 * (not `mihomo.exe`), and a name-exact matcher silently produced "archive does
 * not contain a mihomo binary" on a perfectly good download.
 */

import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { coreAssetFor, extractDownloadedCore } from '../src/clash/core.ts'

function zipWith(entries: Array<{ name: string, size: number }>): Uint8Array {
  const zip = new AdmZip()
  for (const entry of entries) zip.addFile(entry.name, Buffer.alloc(entry.size, 7))
  return new Uint8Array(zip.toBuffer())
}

describe('coreAssetFor', () => {
  it('picks the windows-compatible build for win32 x64', () => {
    expect(coreAssetFor('win32', 'x64', '1.2.3')).toEqual({
      asset: 'mihomo-windows-amd64-compatible-v1.2.3.zip',
      binary: 'mihomo.exe',
      archive: 'zip',
    })
  })

  it('picks the arm64 build for darwin arm64', () => {
    expect(coreAssetFor('darwin', 'arm64', '1.2.3')).toEqual({
      asset: 'mihomo-darwin-arm64-v1.2.3.gz',
      binary: 'mihomo',
      archive: 'gz',
    })
  })
})

describe('extractDownloadedCore', () => {
  it('finds the platform-named binary inside the windows zip', () => {
    const zip = zipWith([{ name: 'mihomo-windows-amd64-compatible.exe', size: 4096 }])
    const binary = extractDownloadedCore({ asset: 'x.zip', binary: 'mihomo.exe', archive: 'zip' }, zip)
    expect(binary.byteLength).toBe(4096)
  })

  it('prefers the mihomo entry when the archive carries other files', () => {
    const zip = zipWith([
      { name: 'README.md', size: 128 },
      { name: 'mihomo-windows-amd64-compatible.exe', size: 4096 },
      { name: 'geoip.dat', size: 64 },
    ])
    const binary = extractDownloadedCore({ asset: 'x.zip', binary: 'mihomo.exe', archive: 'zip' }, zip)
    expect(binary.byteLength).toBe(4096)
  })

  it('rejects an archive with no binary at all instead of installing junk', () => {
    const zip = zipWith([{ name: 'README.md', size: 128 }])
    expect(() => extractDownloadedCore({ asset: 'x.zip', binary: 'mihomo.exe', archive: 'zip' }, zip))
      .toThrow(/does not contain/i)
  })
})
