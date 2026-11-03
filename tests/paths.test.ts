import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agyDataDir, agyDataFile, migrateToAgyDir } from '../src/store/paths.ts'
import { RecentActivityStore, mergeRecentEntries, parseRecentActivity, noopRecentLock, RECENT_FLUSH_EVERY } from '../src/recent-store.ts'
import { RECENT_MAX, UsageStats } from '../src/stats.ts'
import type { RecentActivity } from '../src/stats.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'agy-paths-test-'))
}

function entry(over: Partial<RecentActivity> = {}): RecentActivity {
  return {
    at: 1_700_000_000_000,
    account: 'a@x',
    model: 'm1',
    kind: 'chat',
    ok: true,
    rateLimited: false,
    latencyMs: 100,
    ttftMs: 50,
    output: 10,
    reason: null,
    actualModel: null,
    ...over,
  }
}

describe('agy data dir paths', () => {
  it('places every file under $DSH_HOME/agy', () => {
    const home = scratch()
    expect(agyDataDir(home)).toBe(join(home, 'agy'))
    expect(agyDataFile('agy-stats.json', home)).toBe(join(home, 'agy', 'agy-stats.json'))
  })
})

describe('migrateToAgyDir', () => {
  it('fresh install: no legacy file, returns the new path, creates nothing', () => {
    const home = scratch()
    const result = migrateToAgyDir('agy-stats.json', home)
    expect(result).toEqual({ file: join(home, 'agy', 'agy-stats.json'), migrated: false, skew: false })
    // Nothing materializes until a write actually needs it.
    expect(existsSync(join(home, 'agy'))).toBe(false)
  })

  it('legacy only: renames content AND the 0600 mode into the new layout', () => {
    const home = scratch()
    const legacy = join(home, 'agy-stats.json')
    writeFileSync(legacy, '{"version":2}', { mode: 0o600 })
    const result = migrateToAgyDir('agy-stats.json', home)
    expect(result).toEqual({ file: join(home, 'agy', 'agy-stats.json'), migrated: true, skew: false })
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(result.file, 'utf8')).toBe('{"version":2}')
    if (process.platform !== 'win32') {
      expect(statSync(result.file).mode & 0o777).toBe(0o600)
    }
  })

  it('both files present (version skew): keeps the new file and reports skew', () => {
    const home = scratch()
    const legacy = join(home, 'agy-stats.json')
    const file = agyDataFile('agy-stats.json', home)
    mkdirSync(join(home, 'agy'))
    writeFileSync(legacy, '{"legacy":true}', { mode: 0o600 })
    writeFileSync(file, '{"new":true}', { mode: 0o600 })
    const result = migrateToAgyDir('agy-stats.json', home)
    expect(result).toEqual({ file, migrated: false, skew: true })
    expect(readFileSync(file, 'utf8')).toBe('{"new":true}')
  })

  it('rename failure degrades to the legacy path rather than an empty pool', () => {
    const home = scratch()
    // `agy/` exists as a FILE, so the rename's own mkdirSync/renameSync both
    // fail — exactly the read-only/foreign-object failure the contract covers.
    writeFileSync(join(home, 'agy'), 'not a directory', { mode: 0o600 })
    const legacy = join(home, 'agy-stats.json')
    writeFileSync(legacy, '{"accounts":1}', { mode: 0o600 })
    const result = migrateToAgyDir('agy-stats.json', home)
    expect(result).toEqual({ file: legacy, migrated: false, skew: true })
    // The legacy content is untouched.
    expect(readFileSync(legacy, 'utf8')).toBe('{"accounts":1}')
  })

  it('rebuild after migration triggers the skew detector on the next process', () => {
    const home = scratch()
    writeFileSync(join(home, 'agy-stats.json'), '{"v":1}', { mode: 0o600 })
    expect(migrateToAgyDir('agy-stats.json', home).migrated).toBe(true)
    // An old-version process recreates the legacy file after the migration.
    writeFileSync(join(home, 'agy-stats.json'), '{"v":1,"reborn":true}', { mode: 0o600 })
    const next = migrateToAgyDir('agy-stats.json', home)
    expect(next.skew).toBe(true)
    expect(next.file).toBe(agyDataFile('agy-stats.json', home))
  })
})

describe('parseRecentActivity', () => {
  it('accepts a well-formed record and drops junk fields', () => {
    const parsed = parseRecentActivity({ ...entry(), extra: 'ignored' })
    expect(parsed).toEqual(entry())
  })

  it('carries the routed model version through the round trip', () => {
    // The quota popover derives each account's "actual route" from this ring;
    // dropping the field on read would blank that line after every restart.
    const withRoute = parseRecentActivity(entry({ actualModel: 'gemini-3.8-flash-n' }))
    expect(withRoute?.actualModel).toBe('gemini-3.8-flash-n')
    // Absent stays absent (not an empty string), so the UI can keep hiding it.
    expect(parseRecentActivity(entry())?.actualModel).toBeNull()
    expect(parseRecentActivity(entry({ actualModel: '' }))?.actualModel).toBeNull()
  })

  it('returns null for shapes it cannot trust', () => {
    expect(parseRecentActivity(null)).toBeNull()
    expect(parseRecentActivity('x')).toBeNull()
    expect(parseRecentActivity({})).toBeNull()
    expect(parseRecentActivity(entry({ at: 'no' } as never))).toBeNull()
    expect(parseRecentActivity(entry({ kind: 'mystery' } as never))).toBeNull()
    expect(parseRecentActivity(entry({ ok: 1 } as never))).toBeNull()
    // Bad optional fields normalize to null rather than rejecting the row.
    expect(parseRecentActivity(entry({ latencyMs: -5 }))?.latencyMs).toBeNull()
    expect(parseRecentActivity(entry({ account: '' }))?.account).toBeNull()
  })
})

describe('mergeRecentEntries', () => {
  it('dedupes on the capture key and sorts by time', () => {
    const onDisk = [entry({ at: 1 }), entry({ at: 2 })]
    const batch = [entry({ at: 2 }), entry({ at: 3 })]
    const merged = mergeRecentEntries(onDisk, batch)
    expect(merged.map((e) => e.at)).toEqual([1, 2, 3])
  })

  it('caps at RECENT_MAX, evicting the oldest', () => {
    const many = Array.from({ length: RECENT_MAX + 10 }, (_, i) => entry({ at: i }))
    const merged = mergeRecentEntries([], many)
    expect(merged).toHaveLength(RECENT_MAX)
    expect(merged[0]?.at).toBe(10)
  })
})

describe('RecentActivityStore', () => {
  function storeAt(file: string, clock: () => number, over: Partial<ConstructorParameters<typeof RecentActivityStore>[0]> = {}): RecentActivityStore {
    return new RecentActivityStore({ file, lock: noopRecentLock, now: clock, flushEvery: 0, flushIntervalMs: 0, ...over })
  }

  it('seeds the ring from an existing file, newest first', () => {
    const dir = scratch()
    const file = join(dir, 'agy-recent.json')
    writeFileSync(file, JSON.stringify([entry({ at: 1 }), entry({ at: 2 })]), { mode: 0o600 })
    const store = storeAt(file, () => 5)
    expect(store.recentRequests().map((e) => e.at)).toEqual([2, 1])
  })

  it('a corrupt or non-array file degrades to an empty ring', () => {
    const dir = scratch()
    const file = join(dir, 'agy-recent.json')
    writeFileSync(file, '{not json', { mode: 0o600 })
    const store = storeAt(file, () => 1)
    expect(store.recentRequests()).toEqual([])
  })

  it('flushes a batch of 25 captures (the count trigger) and dedupes on re-flush', () => {
    const dir = scratch()
    const file = join(dir, 'agy-recent.json')
    let tick = 0
    const store = new RecentActivityStore({
      file,
      lock: noopRecentLock,
      now: () => 1_700_000_000_000 + tick++,
      flushEvery: RECENT_FLUSH_EVERY,
      flushIntervalMs: 0,
    })
    for (let i = 0; i < RECENT_FLUSH_EVERY; i++) {
      store.capture(entry({ at: 1_700_000_000_000 + i }))
    }
    expect(store.pendingCount).toBe(0)
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RecentActivity[]
    expect(onDisk).toHaveLength(RECENT_FLUSH_EVERY)
    // A second flush of the SAME window must not duplicate rows.
    store.capture(entry({ at: 1_700_000_000_000 }))
    store.flush()
    const again = JSON.parse(readFileSync(file, 'utf8')) as RecentActivity[]
    expect(again).toHaveLength(RECENT_FLUSH_EVERY)
  })

  it("preserves another process's entries it did not write (merge under the lock)", () => {
    const dir = scratch()
    const file = join(dir, 'agy-recent.json')
    const theirs = [entry({ at: 1, account: 'other@x' })]
    writeFileSync(file, JSON.stringify(theirs), { mode: 0o600 })
    const store = storeAt(file, () => 9)
    store.capture(entry({ at: 2, account: 'mine@x' }))
    store.flush()
    const merged = JSON.parse(readFileSync(file, 'utf8')) as RecentActivity[]
    expect(merged.map((e) => e.account)).toEqual(['other@x', 'mine@x'])
  })

  it('creates the file 0600 on first flush', () => {
    const dir = scratch()
    const file = join(dir, 'nested', 'agy-recent.json')
    const store = storeAt(file, () => 1)
    store.capture(entry())
    store.flush()
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('caps the file at RECENT_MAX entries', () => {
    const dir = scratch()
    const file = join(dir, 'agy-recent.json')
    const store = storeAt(file, () => 0)
    for (let i = 0; i < RECENT_MAX + 30; i++) {
      store.capture(entry({ at: i }))
    }
    store.flush()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as RecentActivity[]
    expect(onDisk).toHaveLength(RECENT_MAX)
    expect(onDisk[0]?.at).toBe(30)
  })

  it('a failed flush keeps the batch and reports once per run', () => {
    const dir = scratch()
    const errors: unknown[] = []
    let tick = 0
    const store = new RecentActivityStore({
      // A lock seam that throws stands in for every write-failure shape
      // (read-only home, EACCES) the real seam can produce.
      file: join(dir, 'blocked.json'),
      lock: { withLock: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } },
      now: () => tick++,
      flushEvery: 0,
      flushIntervalMs: 0,
      onFlushError: (error) => { errors.push(error) },
    })
    // Pre-create the target so the pre-lock creation passes and the LOCK fails.
    writeFileSync(store.path, '[]', { mode: 0o600 })
    store.capture(entry({ at: 1 }))
    store.flush()
    expect(errors).toHaveLength(1)
    expect(store.flushFailing).toBe(true)
    expect(store.pendingCount).toBe(1)
    // The next failing run does not re-report (once per run).
    store.capture(entry({ at: 2 }))
    store.flush()
    expect(errors).toHaveLength(1)
  })

  it('defaults to the agy dir under $DSH_HOME and migrates a legacy file', () => {
    const home = scratch()
    process.env.DSH_HOME = home
    try {
      const legacy = join(home, 'agy-recent.json')
      writeFileSync(legacy, JSON.stringify([entry({ at: 7 })]), { mode: 0o600 })
      const store = new RecentActivityStore({ lock: noopRecentLock })
      expect(store.path).toBe(join(home, 'agy', 'agy-recent.json'))
      expect(existsSync(legacy)).toBe(false)
      expect(store.recentRequests().map((e) => e.at)).toEqual([7])
    } finally {
      delete process.env.DSH_HOME
    }
  })
})

describe('UsageStats persistRecent wiring', () => {
  it('hands every captured record to the store without touching the ledger file', () => {
    const dir = scratch()
    const captured: RecentActivity[] = []
    let tick = 0
    const stats = new UsageStats({
      file: join(dir, 'agy-stats.json'),
      lock: { withLock: (_f, fn) => fn() },
      now: () => 1_700_000_000_000 + tick++ * 1_000,
      flushEvery: 0,
      flushIntervalMs: 0,
      persistRecent: (entry) => { captured.push(entry) },
    })
    stats.record({ account: 'a@x', model: 'm1', source: 'chat', ok: true, usage: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 } })
    stats.record({ account: 'a@x', source: 'chat', ok: false, poolEvent: true, reason: 'rate-limit' })
    expect(captured).toHaveLength(2)
    expect(captured[1]).toMatchObject({ kind: 'rotation', reason: 'rate-limit' } as never)
    // The ledger file was never created: record() stays I/O-free.
    expect(existsSync(join(dir, 'agy-stats.json'))).toBe(false)
  })

  it('a throwing persistRecent never breaks record()', () => {
    const dir = scratch()
    let tick = 0
    const stats = new UsageStats({
      file: join(dir, 'agy-stats.json'),
      lock: { withLock: (_f, fn) => fn() },
      now: () => tick++,
      flushEvery: 0,
      flushIntervalMs: 0,
      persistRecent: () => { throw new Error('sink is full') },
    })
    expect(() => stats.record({ source: 'chat', ok: true })).not.toThrow()
    expect(stats.recentRequests()).toHaveLength(1)
  })
})
