import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MULTIMODAL_DEFAULT_MB,
  MULTIMODAL_ENV_VAR,
  MULTIMODAL_FILE,
  MULTIMODAL_MAX_MB,
  MULTIMODAL_MIN_MB,
  MultimodalConfigStore,
  isValidMultimodalMb,
  parseMultimodalDocument,
  sanitizeMultimodalDocument,
} from '../src/multimodal-config.ts'

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'agy-multimodal-test-')), MULTIMODAL_FILE)
}

/** Run `body` with the env override set, restoring the previous value after. */
function withEnv(value: string | undefined, body: () => void): void {
  const previous = process.env[MULTIMODAL_ENV_VAR]
  if (value === undefined) delete process.env[MULTIMODAL_ENV_VAR]
  else process.env[MULTIMODAL_ENV_VAR] = value
  try {
    body()
  } finally {
    if (previous === undefined) delete process.env[MULTIMODAL_ENV_VAR]
    else process.env[MULTIMODAL_ENV_VAR] = previous
  }
}

afterEach(() => { delete process.env[MULTIMODAL_ENV_VAR] })

describe('multimodal config store', () => {
  it('starts unset, so the shipped default is unchanged', () => {
    // The feature must be a no-op until configured: no stored value means the
    // built-in 20MB cap, which is the behaviour before #101 existed.
    const store = new MultimodalConfigStore({ file: scratch() })
    expect(store.maxInlineMb()).toBeUndefined()
    expect(store.effectiveMaxInlineMb()).toEqual({ value: MULTIMODAL_DEFAULT_MB, source: 'default' })
    expect(store.maxInlineBytes()).toBe(MULTIMODAL_DEFAULT_MB * 1024 * 1024)
  })

  it('persists the cap and reads it back, in the documented on-disk shape', () => {
    const file = scratch()
    const store = new MultimodalConfigStore({ file })
    expect(store.setMaxInlineMb(30)).toEqual({ value: 30, source: 'stored', max: MULTIMODAL_MAX_MB })
    // A fresh instance sees it, i.e. it really went to disk.
    expect(new MultimodalConfigStore({ file }).maxInlineMb()).toBe(30)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, maxInlineMb: 30 })
    // A clear drops the FIELD rather than writing null, so "unset" has one form.
    store.setMaxInlineMb(undefined)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1 })
    expect(store.maxInlineMb()).toBeUndefined()
  })

  it('rejects out-of-interval and non-integer values instead of clamping', () => {
    // A clamped value would silently inline files the user asked to keep out,
    // and the fallback (no stored value) is a valid state, so dropping beats
    // "close enough".
    const store = new MultimodalConfigStore({ file: scratch() })
    for (const bad of [0, 1.5, MULTIMODAL_MAX_MB + 1, NaN, '30']) {
      expect(() => store.setMaxInlineMb(bad as number)).toThrow(/multimodal inline cap/)
    }
    expect(store.maxInlineMb()).toBeUndefined()
    // The interval's boundaries themselves are accepted.
    store.setMaxInlineMb(MULTIMODAL_MIN_MB)
    store.setMaxInlineMb(MULTIMODAL_MAX_MB)
    expect(store.maxInlineMb()).toBe(MULTIMODAL_MAX_MB)
  })

  it('ignores unusable stored values, tolerating hand edits', () => {
    const file = scratch()
    writeFileSync(file, JSON.stringify({ version: 1, maxInlineMb: 'nope' }))
    expect(new MultimodalConfigStore({ file }).maxInlineMb()).toBeUndefined()
    writeFileSync(file, JSON.stringify({ version: 1, maxInlineMb: 0 }))
    expect(new MultimodalConfigStore({ file }).maxInlineMb()).toBeUndefined()
    expect(parseMultimodalDocument('{ not json')).toEqual({ version: 1 })
    expect(sanitizeMultimodalDocument(null)).toEqual({ version: 1 })
    expect(sanitizeMultimodalDocument([1, 2])).toEqual({ version: 1 })
  })

  it('does not create the file on a read', () => {
    // A settings read runs in processes that never write; creating the document
    // on read would leave an empty file behind and make "unset" ambiguous with
    // "deliberately empty".
    const file = scratch()
    const store = new MultimodalConfigStore({ file })
    store.effectiveMaxInlineMb()
    store.snapshot()
    expect(existsSync(file)).toBe(false)
  })

  it('writes the file owner-only', () => {
    // Same atomic-write convention as the other stores; skipped on Windows,
    // where POSIX modes are not enforced (see keyring.ts).
    const file = scratch()
    new MultimodalConfigStore({ file }).setMaxInlineMb(30)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('serves the in-memory copy inside the revalidation window', () => {
    // The hot path must not touch disk per request. A reader that just
    // revalidated keeps its copy even though the file changed underneath it —
    // that is the throttle working, not a bug.
    const file = scratch()
    const reader = new MultimodalConfigStore({ file, revalidateIntervalMs: 60_000 })
    expect(reader.maxInlineMb()).toBeUndefined()
    new MultimodalConfigStore({ file }).setMaxInlineMb(30)
    expect(reader.maxInlineMb()).toBeUndefined()
    // A reader whose window has elapsed picks the change up on its next read.
    expect(new MultimodalConfigStore({ file }).maxInlineMb()).toBe(30)
  })

  it('sees a concurrent writer once its revalidation window elapses', () => {
    // Two instances coexist in one process (main plugin + web entry); the editor
    // writes while the generation path reads, so a stale read would make the
    // setting appear to do nothing until restart.
    const file = scratch()
    const reader = new MultimodalConfigStore({ file, revalidateIntervalMs: 0 })
    expect(reader.maxInlineMb()).toBeUndefined()
    new MultimodalConfigStore({ file }).setMaxInlineMb(30)
    expect(reader.maxInlineMb()).toBe(30)
  })

  it('never lets the throttle drop a concurrent write', () => {
    // The write path bypasses the throttle on purpose: merging into a
    // throttled-skipped stale copy would silently discard the other instance's
    // edit, which is exactly what the re-read exists to prevent.
    const file = scratch()
    new MultimodalConfigStore({ file, revalidateIntervalMs: 60_000 }).setMaxInlineMb(30)
    new MultimodalConfigStore({ file, revalidateIntervalMs: 60_000 }).setMaxInlineMb(45)
    expect(JSON.parse(readFileSync(file, 'utf8')).maxInlineMb).toBe(45)
    expect(new MultimodalConfigStore({ file }).maxInlineMb()).toBe(45)
  })

  it('ranks env above the stored value, and the stored value above the default', () => {
    const file = scratch()
    const store = new MultimodalConfigStore({ file })
    expect(store.effectiveMaxInlineMb()).toEqual({ value: MULTIMODAL_DEFAULT_MB, source: 'default' })
    store.setMaxInlineMb(30)
    expect(store.effectiveMaxInlineMb()).toEqual({ value: 30, source: 'stored' })
    withEnv('7', () => {
      // Env wins even though a value IS stored: the box keeps showing what is
      // saved, and `source` is what tells the reader which one is in force.
      expect(store.effectiveMaxInlineMb()).toEqual({ value: 7, source: 'env' })
      expect(store.snapshot()).toEqual({ value: 30, source: 'env', max: MULTIMODAL_MAX_MB })
      expect(store.maxInlineBytes()).toBe(7 * 1024 * 1024)
    })
    // Restoring the env returns the stored value to force.
    expect(store.effectiveMaxInlineMb()).toEqual({ value: 30, source: 'stored' })
  })

  it('ignores a malformed env override rather than failing', () => {
    // Same posture as `risk.ts`'s envFlag: an unrecognized value falls back
    // rather than throwing, because the fallback chain is always valid.
    // Silently honouring a `30MB` or `1.5` would send a cap nobody wrote.
    const store = new MultimodalConfigStore({ file: scratch() })
    store.setMaxInlineMb(30)
    for (const bad of ['', '  ', '30MB', '1.5', '1e2', '-5', '101', '0', 'abc']) {
      withEnv(bad, () => {
        expect(store.effectiveMaxInlineMb(), `env=${JSON.stringify(bad)}`).toEqual({ value: 30, source: 'stored' })
      })
    }
    withEnv(' 45 ', () => {
      // Surrounding whitespace is tolerated: a shell-exported value often carries it.
      expect(store.effectiveMaxInlineMb()).toEqual({ value: 45, source: 'env' })
    })
  })

  it('validates the shared interval definition', () => {
    expect(isValidMultimodalMb(MULTIMODAL_MIN_MB)).toBe(true)
    expect(isValidMultimodalMb(MULTIMODAL_MAX_MB)).toBe(true)
    expect(isValidMultimodalMb(0)).toBe(false)
    expect(isValidMultimodalMb(1.5)).toBe(false)
    expect(isValidMultimodalMb(101)).toBe(false)
    expect(isValidMultimodalMb('30')).toBe(false)
  })
})
