import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { transportFailureHint, writeBlobFile } from '../src/cli/index.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cli-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('dsh-agy export blob file', () => {
  // POSIX owner-only enforcement is skipped on win32 BY DESIGN (keyring.ts), and
  // that must cover the assertion too: Windows synthesizes the mode bits rather
  // than applying them, so this file reports 0o666 no matter what
  // `writeFileSync({ mode })` was given — `mode` is not the mechanism that
  // protects it there. Same convention as the mode checks in store.test.ts.
  // The CODE still passes 0o600 unconditionally; only the observation is
  // platform-specific, so nothing about the guarantee is lost on POSIX.
  it.skipIf(process.platform === 'win32')('writes the blob owner-only', () => {
    // A blob carries a live access+refresh token in plain base64. Without an
    // explicit mode the file lands at the umask default (0644), i.e. readable by
    // every user on the machine. Asserting the group/other bits rather than the
    // literal 0o600 keeps the test honest under a restrictive umask: umask can
    // only clear bits, and clearing owner bits is not a leak.
    const file = join(tempDir(), 'dsh-agy-0.blob')
    writeBlobFile(file, 'AGY-BLOB-PAYLOAD')

    const mode = statSync(file).mode & 0o777
    expect(mode & 0o077, `mode ${mode.toString(8)} is group/other accessible`).toBe(0)
    expect(mode & 0o400).toBe(0o400)
  })

  it('terminates the blob with a newline so `--out` files paste as one line', () => {
    const file = join(tempDir(), 'dsh-agy-1.blob')
    writeBlobFile(file, 'AGY-BLOB-PAYLOAD')
    expect(readFileSync(file, 'utf8')).toBe('AGY-BLOB-PAYLOAD\n')
  })
})

describe('login transport failure hint', () => {
  // The terminal surface has no i18n, so the hint is English by construction.
  // Issue #108 arrived as a screenshot of `Login failed: fetch failed`: the
  // browser leg had succeeded, so the only useful thing left to say is the
  // remedy the browser had and this process did not.
  it('names both remedies and states that the authorization itself succeeded', () => {
    const hint = transportFailureHint()
    expect(hint).toContain('--proxy')
    expect(hint).toContain('HTTPS_PROXY')
    expect(hint).toContain('authorization succeeded')
    // No template placeholder may survive into the terminal.
    expect(hint).not.toMatch(/\{|\}/)
  })
})
