/**
 * Persisted recent-activity ring: `$DSH_HOME/agy/agy-recent.json`.
 *
 * The in-memory ring in `UsageStats` answers "just now" but dies with the
 * process; the ledger answers "in aggregate" only. This store is the bridge:
 * it persists the SAME flattened records to their own file so history survives
 * a restart, and cross-process history becomes visible (Desktop, a web-profile
 * server, and a CLI each merge into one file).
 *
 * Why a SEPARATE file rather than a `recent` field in `agy-stats.json`: the
 * ledger's document is versioned and migrated (`parseStatsDocument`); folding
 * an evicting list into it turns every prune into a document-shape question.
 * A flat list in its own file needs no version and no migration — a record we
 * cannot parse is simply dropped.
 *
 * Bounded by construction: at most `RECENT_MAX` (200) entries, oldest evicted,
 * so the file caps at roughly 40–60KB forever.
 *
 * Flush triggers, whichever comes first: 25 pending records, or 30s with
 * anything pending, plus `flushSync()` on process exit. No size trigger —
 * entries are fixed-shape, so size is a function of count and the count IS the
 * cap. Worst loss window on a hard crash: ≤30s of records.
 *
 * The merge under the lock re-reads the fresh on-disk list, appends this
 * process's batch, dedupes on the CAPTURE key (`at|account|model|kind|output`
 * — two writers can flush the same capture window, and a duplicated rotation
 * row is exactly the confusion this panel exists to end), sorts by `at`, and
 * truncates to `RECENT_MAX`. Atomic tmp+rename, 0600.
 *
 * Privacy surface is the ledger's: account emails and model ids only — never a
 * token, a proxy URL, or a project id.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { RECENT_MAX } from './stats.ts'
import type { RecentActivity } from './stats.ts'
import { migrateToAgyDir } from './store/paths.ts'

/** Default filename inside the agy data dir. */
export const RECENT_FILE_NAME = 'agy-recent.json'

/** Flush after this many pending records. */
export const RECENT_FLUSH_EVERY = 25

/** Flush after this many ms with pending records. */
export const RECENT_FLUSH_INTERVAL_MS = 30_000

/** Capture-key dedupe: the fields two processes writing the same capture share. */
function captureKey(entry: RecentActivity): string {
  return `${entry.at}|${entry.account ?? ''}|${entry.model ?? ''}|${entry.kind}|${entry.output ?? ''}`
}

/**
 * Coerce one parsed JSON value into a `RecentActivity`, or null when it is not
 * one. No version field: a record this build cannot parse is dropped, which
 * for a bounded diagnostics list is the whole migration story.
 */
export function parseRecentActivity(raw: unknown): RecentActivity | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const kinds = ['chat', 'cli', 'verify', 'test', 'rotation'] as const
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  if (!kinds.includes(r.kind as (typeof kinds)[number])) return null
  if (typeof r.ok !== 'boolean') return null
  const nullableString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
  const nullableNumber = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
  return {
    at: r.at,
    account: nullableString(r.account),
    model: nullableString(r.model),
    kind: r.kind as RecentActivity['kind'],
    ok: r.ok,
    rateLimited: r.rateLimited === true,
    latencyMs: nullableNumber(r.latencyMs),
    ttftMs: nullableNumber(r.ttftMs),
    output: nullableNumber(r.output),
    reason: nullableString(r.reason),
  }
}

/** Merge one batch into an on-disk list (pure; the caller owns the lock and the write). */
export function mergeRecentEntries(
  onDisk: RecentActivity[],
  batch: RecentActivity[],
  cap: number = RECENT_MAX,
): RecentActivity[] {
  const byKey = new Map<string, RecentActivity>()
  for (const entry of [...onDisk, ...batch]) byKey.set(captureKey(entry), entry)
  return [...byKey.values()]
    .sort((a, b) => a.at - b.at)
    .slice(-cap)
}

/** Same file-lock seam shape as `StatsLock`: sync, no retries (see stats.ts). */
export interface RecentLock {
  withLock<T>(file: string, fn: () => T): T
}

export const properRecentLock: RecentLock = {
  withLock<T>(file: string, fn: () => T): T {
    // Same parameter set as `properStatsLock`, for the same reasons: no
    // `realpath` (the file may be absent on first write), a short `stale` so a
    // SIGKILLed process's lock directory cannot black out the next half minute.
    const release = lockfile.lockSync(file, { stale: 8_000, update: 4_000, realpath: false })
    try {
      return fn()
    } finally {
      release()
    }
  },
}

export const noopRecentLock: RecentLock = { withLock: (_file, fn) => fn() }

export interface RecentActivityStoreOptions {
  /** Defaults to `$DSH_HOME/agy/agy-recent.json` (migrating any legacy file). */
  file?: string
  lock?: RecentLock
  /** Injectable clock, for tests. */
  now?: () => number
  flushEvery?: number
  flushIntervalMs?: number
  /**
   * Called once per run of consecutive flush failures, with the first error —
   * the same soft-fail contract as the ledger's `onFlushError`. Absent means
   * failures are silent (acceptable for a diagnostics ring; the plugin entry
   * always supplies one).
   */
  onFlushError?: (error: unknown) => void
}

/**
 * Persists the recent-activity ring across processes and restarts.
 *
 * The plugin constructs it BEFORE any record can arrive, seeds the in-memory
 * ring from the file, and hands it to `UsageStats` as the persistence half;
 * `record()` in `UsageStats` stays I/O-free — it appends to this store's
 * pending list, and flushing happens on the triggers above.
 */
export class RecentActivityStore {
  private readonly file: string
  private readonly lock: RecentLock
  private readonly now: () => number
  private readonly flushEvery: number
  private readonly flushIntervalMs: number
  private readonly onFlushError: ((error: unknown) => void) | undefined

  /** The seeded ring plus this process's un-flushed captures. */
  private entries: RecentActivity[] = []
  private pending: RecentActivity[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private flushFailedSince: number | undefined
  private lastFlushError: unknown

  constructor(options: RecentActivityStoreOptions = {}) {
    this.file = options.file ?? migrateToAgyDir(RECENT_FILE_NAME).file
    this.lock = options.lock ?? properRecentLock
    this.now = options.now ?? (() => Date.now())
    this.flushEvery = options.flushEvery ?? RECENT_FLUSH_EVERY
    this.flushIntervalMs = options.flushIntervalMs ?? RECENT_FLUSH_INTERVAL_MS
    this.onFlushError = options.onFlushError
    // Seed from disk BEFORE the first capture: `pool.recent` then shows the
    // other processes' history immediately. A corrupt file degrades to empty.
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          const entry = parseRecentActivity(raw)
          if (entry) this.entries.push(entry)
        }
        if (this.entries.length > RECENT_MAX) {
          this.entries.splice(0, this.entries.length - RECENT_MAX)
        }
      }
    } catch {
      // Missing or unreadable file: an empty ring is the correct start state.
    }
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /** Whether the ring is currently failing to persist (a run of failures). */
  get flushFailing(): boolean {
    return this.flushFailedSince !== undefined
  }

  /** Number of records awaiting flush. */
  get pendingCount(): number {
    return this.pending.length
  }

  /**
   * Capture one flattened record and the I/O-free hot-path append.
   *
   * `UsageStats.record()` calls this after folding into its own ring; keeping
   * the write-behind state HERE (not in UsageStats) is what lets the file have
   * its own triggers, its own lock, and its own failure story without widening
   * the ledger's.
   */
  capture(entry: RecentActivity): void {
    this.entries.push(entry)
    if (this.entries.length > RECENT_MAX) {
      this.entries.splice(0, this.entries.length - RECENT_MAX)
    }
    this.pending.push(entry)
    if (this.flushEvery > 0 && this.pending.length >= this.flushEvery) {
      this.flush()
      return
    }
    this.armTimer()
  }

  /**
   * Newest-first copy of the ring, for the `pool.recent` RPC: the seeded
   * history plus everything this process captured since boot.
   */
  recentRequests(): RecentActivity[] {
    return [...this.entries].reverse()
  }

  private armTimer(): void {
    if (this.timer !== undefined || this.flushIntervalMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushIntervalMs)
    // Never hold the process open for a diagnostics flush.
    this.timer.unref?.()
  }

  /**
   * Merge pending captures into the persisted file.
   *
   * Same merge discipline as the ledger: re-read under the lock, merge by
   * capture key (two processes replaying the same window must not duplicate
   * rows), sort by time, cap. A failed flush puts the batch back — a
   * diagnostics ring never breaks a generation — and reports once per run.
   */
  flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const batch = this.pending
    if (batch.length === 0) return
    this.pending = []
    const now = this.now()
    try {
      if (!existsSync(this.file)) {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(this.file, '[]\n', { mode: 0o600 })
      }
      this.lock.withLock(this.file, () => {
        const onDisk: RecentActivity[] = []
        try {
          const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
          if (Array.isArray(parsed)) {
            for (const raw of parsed) {
              const entry = parseRecentActivity(raw)
              if (entry) onDisk.push(entry)
            }
          }
        } catch {
          // A corrupt file loses its history rather than this process's batch.
        }
        const merged = mergeRecentEntries(onDisk, batch)
        const tmp = `${this.file}.tmp`
        writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
        renameSync(tmp, this.file)
      })
      this.lastFlushError = undefined
      this.flushFailedSince = undefined
    } catch (error) {
      this.pending = [...batch, ...this.pending]
      this.lastFlushError = error
      if (this.flushFailedSince === undefined) {
        this.flushFailedSince = now
        try {
          this.onFlushError?.(error)
        } catch {
          // The reporter must never break a flush path.
        }
      }
      this.armTimer()
    }
  }

  /** Flush if anything is pending; called on process exit. */
  flushSync(): void {
    this.flush()
  }

  /** The most recent flush failure, if any (diagnostics). */
  get flushError(): unknown {
    return this.lastFlushError
  }
}
