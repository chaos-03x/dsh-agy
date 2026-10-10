/**
 * Cumulative agy usage statistics, persisted to `$DSH_HOME/agy/agy-stats.json`.
 *
 * Why agy keeps its own ledger instead of reading DSH's session projections:
 *
 * - DSH structurally has no account dimension (no `account` field anywhere in
 *   `dsh-llm` or the session types), so "which account burned this quota" is
 *   unanswerable from DSH's data.
 * - agy's own traffic bypasses DSH entirely — `dsh-agy login/verify/status`,
 *   `testCall()`, `checkAccounts()`, and quota discovery all consume upstream
 *   quota without producing a session event.
 * - DSH's cumulative `tokenUsage` projection has no model dimension and folds
 *   by `(turn, step)`, so a mid-session model switch cannot be attributed.
 *
 * Counter semantics deliberately differ from DSH's: DSH replaces a step's
 * usage (a retried attempt counts once, for conversation cost), while this
 * ledger accumulates per attempt (every retry really did consume quota, which
 * is what an account-level view must show).
 *
 * Storage shape is cumulative with a rolling per-day window:
 *   - `totals` never expires — it answers "all time".
 *   - `days` keeps `DAY_WINDOW` buckets — it answers today / 7d / 30d.
 * A day rolling out of `days` therefore loses only granularity; its counts
 * already live in `totals`.
 *
 * Writes are throttled and merged, never read-modify-write per request:
 * callers accumulate in memory (zero I/O on the hot path) and `flush()` takes
 * the file lock, re-reads the fresh on-disk state, adds this process's delta,
 * and atomically replaces the file. A plain overwrite would lose the counts
 * another process (the Desktop app, a web-profile server, a CLI invocation)
 * wrote in the meantime.
 *
 * A ledger that cannot be written must fail soft and stay bounded: the pending
 * backlog is capped, immediate (count-based) flushing is suspended while writes
 * fail, and the first error of each failure run is reported through
 * `onFlushError`. Statistics are diagnostics — they never break a generation,
 * and they never grow without limit.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { migrateToAgyDir } from './store/paths.ts'
import { zeroCounters } from './usage-types.ts'
import type { TokenBuckets, UsageCounters, UsageSource } from './usage-types.ts'

export type { TokenBuckets, UsageCounters, UsageSource } from './usage-types.ts'

export const STATS_VERSION = 2

/** Days of per-day buckets retained. Longer spans read `totals`. */
export const DAY_WINDOW = 30

/** Per-account ledger. */
export interface AccountUsage {
  totals: UsageCounters
  /** Per-model totals for this account, keyed by provider model id. */
  models: Record<string, UsageCounters>
  /** Request counts by call site. */
  sources: Record<UsageSource, number>
  /** Last time this account recorded anything (Unix ms). */
  lastUsedAt: number
}

/**
 * One day's slice, broken down the same three ways the Usage tab reads it.
 *
 * Version 1 stored only the flat counters here, which was enough for the KPI
 * strip but not for the breakdown tables: those had to read the ALL-TIME
 * `accounts`/`models` maps, so selecting "Today" changed the headline figures
 * while the tables below still showed every request ever recorded — 30 requests
 * above a 164-request row on the same screen. Keeping the per-day breakdown is
 * what lets the whole page follow one range.
 *
 * `totals` stays the sum of the day's records; `models`/`accounts` are the same
 * counters partitioned by dimension. Every record contributes to `totals` and to
 * whichever dimensions it names.
 */
export interface DayBucket {
  totals: UsageCounters
  /** Per-model counters within this day. */
  models: Record<string, UsageCounters>
  /** Per-account counters within this day. */
  accounts: Record<string, UsageCounters>
}

/** The persisted document. */
export interface StatsDocument {
  version: number
  /** When this ledger began collecting (Unix ms). */
  since: number
  /** Grand totals across every account. */
  totals: UsageCounters
  /** Per-account ledgers, keyed by account email (falling back to id). */
  accounts: Record<string, AccountUsage>
  /** Rolling per-day buckets, `YYYY-MM-DD` -> that day's slice. */
  days: Record<string, DayBucket>
}

/** One recorded request, as the call sites observe it. */
export interface UsageRecord {
  /** Account key (email preferred); omitted when no account was resolved. */
  account?: string
  /** Provider model id. */
  model?: string
  source: UsageSource
  /** Token usage; absent for calls that failed before producing usage. */
  usage?: TokenBuckets
  ok: boolean
  rateLimited?: boolean
  rotated?: boolean
  latencyMs?: number
  ttftMs?: number
  /**
   * A pool-level event (a rotation) rather than a request.
   *
   * Rotations are decided inside the session manager, after the adapter has
   * already recorded the failing request. Emitting them as ordinary records
   * would count that request twice, so a pool event adds only to the pool
   * counters and leaves the request counters alone.
   */
  poolEvent?: boolean
  /**
   * The failure classification this record carries ('rate-limit',
   * 'network-error', 'auth-failure', 'verification-required', 'project-error',
   * 'quota-exhausted'), when it failed — plus the one non-classification token
   * 'aborted', which marks a turn the CONSUMER cancelled rather than one the
   * upstream failed. The counters ignore it: it exists for the recent-activity
   * ring, where "why did it rotate" is the whole question.
   */
  reason?: string
}

/** Cap of the in-memory recent-activity ring (see `UsageStats.recentRequests`). */
export const RECENT_MAX = 200

/**
 * One recent record, as the UI's "what just happened" list shows it.
 *
 * Flattened from `UsageRecord` at capture time so the ring never aliases the
 * caller's object, and shaped for DISPLAY: pool events become `kind:
 * 'rotation'`, absent numbers become null. The ring answers "just now" — the
 * gap between the live in-flight line and the persisted ledger, whose records
 * collapse into counters the moment they are flushed.
 */
export interface RecentActivity {
  at: number
  account: string | null
  model: string | null
  kind: 'chat' | 'cli' | 'verify' | 'test' | 'rotation'
  ok: boolean
  rateLimited: boolean
  latencyMs: number | null
  ttftMs: number | null
  output: number | null
  /** Failure classification token, or null when the record succeeded. */
  reason: string | null
}

function zeroAccount(now: number): AccountUsage {
  return {
    totals: zeroCounters(),
    models: {},
    sources: { chat: 0, cli: 0, verify: 0, test: 0 },
    lastUsedAt: now,
  }
}

function emptyDocument(now: number): StatsDocument {
  return { version: STATS_VERSION, since: now, totals: zeroCounters(), accounts: {}, days: {} }
}

/** Local-time day key. Local (not UTC) so "today" matches the user's clock. */
export function dayKey(time: number): string {
  const d = new Date(time)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Add `add` into `into`, in place. */
function addInto(into: UsageCounters, add: UsageCounters): void {
  into.input += add.input
  into.output += add.output
  into.cacheRead += add.cacheRead
  into.cacheWrite += add.cacheWrite
  into.requests += add.requests
  into.succeeded += add.succeeded
  into.failed += add.failed
  into.rateLimited += add.rateLimited
  into.rotations += add.rotations
  into.latencyMs += add.latencyMs
  into.latencyN += add.latencyN
  into.ttftMs += add.ttftMs
  into.ttftN += add.ttftN
}

/** Coerce arbitrary parsed JSON into a valid counter block (tolerates hand edits). */
function sanitizeCounters(raw: unknown): UsageCounters {
  const out = zeroCounters()
  if (typeof raw !== 'object' || raw === null) return out
  for (const key of Object.keys(out) as Array<keyof UsageCounters>) {
    const value = (raw as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  return out
}

function sanitizeAccount(raw: unknown, now: number): AccountUsage {
  const out = zeroAccount(now)
  if (typeof raw !== 'object' || raw === null) return out
  const record = raw as Record<string, unknown>
  out.totals = sanitizeCounters(record.totals)
  if (typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt)) {
    out.lastUsedAt = record.lastUsedAt
  }
  if (typeof record.models === 'object' && record.models !== null) {
    for (const [id, value] of Object.entries(record.models as Record<string, unknown>)) {
      out.models[id] = sanitizeCounters(value)
    }
  }
  if (typeof record.sources === 'object' && record.sources !== null) {
    for (const key of ['chat', 'cli', 'verify', 'test'] as const) {
      const value = (record.sources as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out.sources[key] = value
    }
  }
  return out
}

/** Parse a persisted document defensively; a corrupt file degrades to empty. */
export function parseStatsDocument(text: string, now: number): StatsDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return emptyDocument(now)
  }
  if (typeof raw !== 'object' || raw === null) return emptyDocument(now)
  const record = raw as Record<string, unknown>
  const doc = emptyDocument(now)
  if (typeof record.since === 'number' && Number.isFinite(record.since)) doc.since = record.since
  doc.totals = sanitizeCounters(record.totals)
  if (typeof record.accounts === 'object' && record.accounts !== null) {
    for (const [key, value] of Object.entries(record.accounts as Record<string, unknown>)) {
      doc.accounts[key] = sanitizeAccount(value, now)
    }
  }
  if (typeof record.days === 'object' && record.days !== null) {
    for (const [key, value] of Object.entries(record.days as Record<string, unknown>)) {
      // Only well-formed day keys survive, so a stray key can never grow the file.
      if (/^\d{4}-\d{2}-\d{2}$/.test(key)) doc.days[key] = sanitizeDayBucket(value)
    }
  }
  return doc
}

/**
 * Coerce one day's stored value into a `DayBucket`.
 *
 * Accepts the version-1 shape too: that stored a bare counter block, so a
 * document written before the upgrade keeps its day counts as `totals` with no
 * breakdown. Losing the breakdown for those days is the correct trade — the
 * alternative (dropping the days) would erase real history, and recomputing a
 * dimension split that was never recorded is impossible. The all-time
 * `accounts`/`models` maps are unaffected, so only range-scoped breakdown tables
 * are thinner for pre-upgrade days.
 */
function sanitizeDayBucket(raw: unknown): DayBucket {
  const out: DayBucket = { totals: zeroCounters(), models: {}, accounts: {} }
  if (typeof raw !== 'object' || raw === null) return out
  const record = raw as Record<string, unknown>
  if (typeof record.totals === 'object' && record.totals !== null) {
    out.totals = sanitizeCounters(record.totals)
    if (typeof record.models === 'object' && record.models !== null) {
      for (const [id, value] of Object.entries(record.models as Record<string, unknown>)) {
        out.models[id] = sanitizeCounters(value)
      }
    }
    if (typeof record.accounts === 'object' && record.accounts !== null) {
      for (const [key, value] of Object.entries(record.accounts as Record<string, unknown>)) {
        out.accounts[key] = sanitizeCounters(value)
      }
    }
    return out
  }
  // Version-1 day: a bare counter block.
  out.totals = sanitizeCounters(raw)
  return out
}

/** Drop day buckets older than the window; their counts already live in `totals`. */
function pruneDays(doc: StatsDocument, now: number): void {
  const cutoff = dayKey(now - DAY_WINDOW * 86_400_000)
  for (const key of Object.keys(doc.days)) {
    if (key < cutoff) delete doc.days[key]
  }
}

/**
 * Sum the day buckets covering the last `days` days, inclusive of today.
 *
 * `days: 1` is "today" and `days: DAY_WINDOW` is the full retained window. The
 * window is deliberately read from the per-day buckets rather than `totals`:
 * `totals` is all-time and grows past every window.
 * @param doc - the ledger snapshot.
 * @param days - window length in days, at least 1.
 * @param now - current time (Unix ms).
 * @returns summed counters over the window.
 */
export function foldWindow(doc: StatsDocument, days: number, now: number): UsageCounters {
  const out = zeroCounters()
  const span = Math.max(1, Math.floor(days))
  const cutoff = dayKey(now - (span - 1) * 86_400_000)
  for (const [key, bucket] of Object.entries(doc.days)) {
    // String compare is a valid date order for `YYYY-MM-DD`.
    if (key >= cutoff) addInto(out, bucket.totals)
  }
  return out
}

/** One range's breakdown: totals plus the same counters split by model/account. */
export interface WindowBreakdown {
  totals: UsageCounters
  models: Array<{ model: string, counters: UsageCounters }>
  accounts: Array<{ account: string, counters: UsageCounters }>
}

/**
 * Fold the day buckets for a window into the three views the Usage tab renders.
 *
 * The breakdown tables read THIS rather than the all-time `accounts`/`models`
 * maps, so one range selection governs the whole page. Rows are sorted by
 * request count descending, matching the all-time view; the caller re-sorts if
 * it wants another order (the UI shows them as-is).
 *
 * @param doc - the ledger snapshot.
 * @param days - window length in days, at least 1.
 * @param now - current time (Unix ms).
 * @returns totals and their per-model / per-account partitions.
 */
export function foldWindowBreakdown(doc: StatsDocument, days: number, now: number): WindowBreakdown {
  const span = Math.max(1, Math.floor(days))
  const cutoff = dayKey(now - (span - 1) * 86_400_000)
  const totals = zeroCounters()
  const models = new Map<string, UsageCounters>()
  const accounts = new Map<string, UsageCounters>()
  for (const [key, bucket] of Object.entries(doc.days)) {
    if (key < cutoff) continue
    addInto(totals, bucket.totals)
    for (const [model, counters] of Object.entries(bucket.models)) {
      const current = models.get(model)
      if (current === undefined) models.set(model, { ...counters })
      else addInto(current, counters)
    }
    for (const [account, counters] of Object.entries(bucket.accounts)) {
      const current = accounts.get(account)
      if (current === undefined) accounts.set(account, { ...counters })
      else addInto(current, counters)
    }
  }
  const byRequests = (a: { counters: UsageCounters }, b: { counters: UsageCounters }): number =>
    b.counters.requests - a.counters.requests
  return {
    totals,
    models: [...models.entries()].map(([model, counters]) => ({ model, counters })).sort(byRequests),
    accounts: [...accounts.entries()].map(([account, counters]) => ({ account, counters })).sort(byRequests),
  }
}

/** Merge one record into a document, in place. Shared by the live store and tests. */
export function applyRecord(doc: StatsDocument, record: UsageRecord, now: number): void {
  const delta = zeroCounters()
  // A pool event carries no request of its own; it only moves pool counters.
  if (record.poolEvent !== true) {
    delta.requests = 1
    if (record.ok) delta.succeeded = 1
    else delta.failed = 1
    if (record.rateLimited === true) delta.rateLimited = 1
  }
  if (record.rotated === true) delta.rotations = 1
  if (record.usage !== undefined) {
    delta.input = record.usage.input
    delta.output = record.usage.output
    delta.cacheRead = record.usage.cacheRead
    delta.cacheWrite = record.usage.cacheWrite
  }
  if (typeof record.latencyMs === 'number' && Number.isFinite(record.latencyMs) && record.latencyMs >= 0) {
    delta.latencyMs = record.latencyMs
    delta.latencyN = 1
  }
  if (typeof record.ttftMs === 'number' && Number.isFinite(record.ttftMs) && record.ttftMs >= 0) {
    delta.ttftMs = record.ttftMs
    delta.ttftN = 1
  }

  addInto(doc.totals, delta)

  if (record.account !== undefined && record.account !== '') {
    const account = doc.accounts[record.account] ?? zeroAccount(now)
    addInto(account.totals, delta)
    // A pool event is not a call site occurrence, so it counts no source.
    if (record.poolEvent !== true) account.sources[record.source] += 1
    account.lastUsedAt = now
    if (record.model !== undefined && record.model !== '') {
      const model = account.models[record.model] ?? zeroCounters()
      addInto(model, delta)
      // A model with no traffic left is still a real model row; keep it.
      account.models[record.model] = model
    }
    doc.accounts[record.account] = account
  }

  const key = dayKey(now)
  const bucket = doc.days[key] ?? { totals: zeroCounters(), models: {}, accounts: {} }
  addInto(bucket.totals, delta)
  // The same delta is partitioned by the dimensions it names, so a range-scoped
  // breakdown table adds up to that range's headline figures exactly.
  if (record.model !== undefined && record.model !== '') {
    const model = bucket.models[record.model] ?? zeroCounters()
    addInto(model, delta)
    bucket.models[record.model] = model
  }
  if (record.account !== undefined && record.account !== '') {
    const account = bucket.accounts[record.account] ?? zeroCounters()
    addInto(account, delta)
    bucket.accounts[record.account] = account
  }
  doc.days[key] = bucket

  pruneDays(doc, now)
}

/**
 * Cross-process file lock seam (proper-lockfile behind a small interface for tests).
 *
 * The sync form is deliberate — `flush()` is called from `process.on('exit')`,
 * where async work cannot settle.
 *
 * The sync API accepts NO retry configuration: `proper-lockfile` throws
 * "Cannot use retries with the sync api" when `retries` is passed, which fails
 * every flush and silently drops every count. Contention therefore surfaces as
 * a thrown error instead of a retry, and `flush()` puts the batch back for the
 * next timer tick — a statistics flush that loses a race costs nothing, so
 * waiting is never worth blocking the event loop for.
 */
export interface StatsLock {
  withLock<T>(file: string, fn: () => T): T
}

export const properStatsLock: StatsLock = {
  withLock<T>(file: string, fn: () => T): T {
    // `realpath: false` because the target may be absent on first write; the
    // caller pre-creates it, and lockSync otherwise throws ENOENT resolving it.
    //
    // `stale` is deliberately short (8s, the same order as `flushIntervalMs`).
    // proper-lockfile only removes its lock directory through signal-exit, so a
    // `SIGKILL`ed process leaves one behind; with the former 30s window every
    // flush failed for 30 seconds afterwards — a long blackout for a diagnostic
    // ledger whose next flush can simply try again. `update` must stay below
    // `stale` or a lock holder self-expires while it is still working.
    const release = lockfile.lockSync(file, { stale: 8_000, update: 4_000, realpath: false })
    try {
      return fn()
    } finally {
      release()
    }
  },
}

export const noopStatsLock: StatsLock = { withLock: (_file, fn) => fn() }

export interface UsageStatsStoreOptions {
  /**
   * Defaults to `$DSH_HOME/agy/agy-stats.json`, migrating the legacy
   * `$DSH_HOME/agy-stats.json` by one-shot rename (see `migrateToAgyDir`).
   */
  file?: string
  lock?: StatsLock
  /** Injectable clock, for tests. */
  now?: () => number
  /**
   * Flush after this many pending records. `0` disables count-based flushing.
   * Defaults to 50 (DSH's own projection cache writes at 200 records / 5s).
   */
  flushEvery?: number
  /** Flush after this many ms with pending records. Defaults to 5000. */
  flushIntervalMs?: number
  /**
   * Hard ceiling on un-flushed records. Defaults to 500 (ten batches).
   *
   * A persistent write failure (read-only `$DSH_HOME`, ENOSPC) makes every
   * flush fail, so the pending list would otherwise grow without bound in a
   * long-lived process. Past the ceiling the OLDEST records are dropped: a
   * bounded diagnostic ledger beats an unbounded one, and the oldest counts are
   * the least useful ones.
   */
  maxPending?: number
  /**
   * Called once per run of consecutive flush failures, with the first error.
   *
   * Without this a ledger that cannot be written fails silently: counts simply
   * stop appearing, with nothing to correlate. Once per run (not per attempt)
   * because the timer retries every `flushIntervalMs` and a log per retry would
   * be noise.
   */
  onFlushError?: (error: unknown) => void
  /**
   * Persistence half of the recent-activity ring (see `recent-store.ts`).
   * Called with each flattened record as it is captured; absent means the ring
   * stays per-process, as before.
   */
  persistRecent?: (entry: RecentActivity) => void
}

/**
 * Accumulating usage ledger. `record()` is the hot path and performs no I/O:
 * it folds the record into an in-memory delta. `flush()` merges that delta into
 * the persisted document under the file lock.
 */
export class UsageStats {
  private readonly file: string
  private readonly lock: StatsLock
  private readonly now: () => number
  private readonly flushEvery: number
  private readonly flushIntervalMs: number
  private readonly maxPending: number
  private readonly onFlushError: ((error: unknown) => void) | undefined
  private readonly persistRecent: ((entry: RecentActivity) => void) | undefined

  /** This process's un-flushed records. */
  private pending: UsageRecord[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastFlushError: unknown
  /**
   * Whether the current run of consecutive failures has already been reported.
   * Count-based flushing is also suspended while set: see `record()`.
   */
  private flushFailedSince: number | undefined

  constructor(options: UsageStatsStoreOptions = {}) {
    // Explicit file (tests, callers with their own layout) is used as-is; the
    // default migrates the legacy home-directory file into `agy/` once.
    this.file = options.file ?? migrateToAgyDir('agy-stats.json').file
    this.lock = options.lock ?? properStatsLock
    this.now = options.now ?? (() => Date.now())
    this.flushEvery = options.flushEvery ?? 50
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000
    this.maxPending = options.maxPending ?? 500
    this.onFlushError = options.onFlushError
    this.persistRecent = options.persistRecent
    // Deliberately does NOT create the file: a read-only command (`status`)
    // builds a ledger and must not leave state behind. `flush()` pre-creates it
    // before locking, which is the first point a write actually needs it.
  }

  /** Path of the backing file. */
  get path(): string {
    return this.file
  }

  /**
   * Pre-create the ledger so `proper-lockfile` can lock it. The lock throws
   * ENOENT on a nonexistent target, so the empty document must exist (0600,
   * tmp+rename) before the first flush.
   */
  private ensureFile(now: number): void {
    if (existsSync(this.file)) return
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-init`
    writeFileSync(tmp, JSON.stringify(emptyDocument(now), null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  private readFile(): StatsDocument {
    const now = this.now()
    try {
      return parseStatsDocument(readFileSync(this.file, 'utf8'), now)
    } catch {
      return emptyDocument(now)
    }
  }

  /** Atomic replace (tmp + rename), owner-only, so a reader never sees a partial file. */
  private writeFile(doc: StatsDocument): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Record one request. Hot path: no I/O. */
  record(record: UsageRecord): void {
    this.noteRecent(record)
    this.pending.push(record)
    // Cap the backlog: unbounded growth is the one failure mode a diagnostic
    // ledger must not have (see `maxPending`).
    if (this.maxPending > 0 && this.pending.length > this.maxPending) {
      this.pending.splice(0, this.pending.length - this.maxPending)
    }
    // Count-based flushing is a throughput optimisation, so it is suspended
    // while writes are failing. Without this a persistent failure made EVERY
    // `record()` attempt a full synchronous flush (stat + lock + read + write),
    // turning the generation hot path into I/O — the exact opposite of this
    // class's contract. The timer below keeps retrying instead.
    if (
      this.flushFailedSince === undefined
      && this.flushEvery > 0
      && this.pending.length >= this.flushEvery
    ) {
      this.flush()
      return
    }
    this.armTimer()
  }

  /**
   * The in-memory recent-activity ring, persisted by an injected
   * `RecentActivityStore` when one is supplied.
   *
   * The ring itself stays in-memory and I/O-free — `noteRecent` only flattens —
   * while the OPTIONAL `persistRecent` seam hands each flattened record to
   * `recent-store.ts`, which owns the file, the triggers, the lock, and the
   * failure story. When no store is injected (tests, the CLI) the ring behaves
   * exactly as before: per-process, never persisted.
   *
   * An earlier revision recorded why persistence was rejected outright (file
   * growth, a versioned migration, a wider stored surface); `recent-store.ts`
   * answers each — a bounded list in its own file, no version field, emails
   * and model ids only — which is what turned this from a bad idea into a
   * spec.
   */
  private readonly recent: RecentActivity[] = []

  private noteRecent(record: UsageRecord): void {
    const entry: RecentActivity = {
      at: this.now(),
      account: record.account ?? null,
      model: record.model ?? null,
      kind: record.poolEvent === true ? 'rotation' : record.source,
      ok: record.ok === true,
      rateLimited: record.rateLimited === true,
      latencyMs: record.latencyMs ?? null,
      ttftMs: record.ttftMs ?? null,
      output: record.usage?.output ?? null,
      reason: record.ok === true ? null : record.reason ?? null,
    }
    this.recent.push(entry)
    if (this.recent.length > RECENT_MAX) {
      this.recent.splice(0, this.recent.length - RECENT_MAX)
    }
    // Fire-and-forget: the store never throws synchronously (its own flush
    // path is guarded), but a diagnostics hand-off must not break `record()`.
    try {
      this.persistRecent?.(entry)
    } catch {
      // Swallowed by design — same contract as `emitUsage` in session.ts.
    }
  }

  /**
   * Newest-first copy of the ring, for the `pool.recent` RPC.
   *
   * A copy, not the live array: the RPC layer may hold it across awaits while
   * `record()` keeps pushing.
   */
  recentRequests(): RecentActivity[] {
    return [...this.recent].reverse()
  }

  private armTimer(): void {
    if (this.timer !== undefined || this.flushIntervalMs <= 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.flushIntervalMs)
    // Never hold the process open for a statistics flush.
    this.timer.unref?.()
  }

  /**
   * Merge pending records into the persisted document.
   *
   * Under the lock, the fresh on-disk state is re-read and this process's
   * records are replayed onto it. That is what keeps concurrently-running
   * writers (Desktop, a web-profile server, a CLI invocation) from clobbering
   * each other: a plain overwrite of the in-memory document would drop every
   * count another process added since this one loaded the file.
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
      this.ensureFile(now)
      this.lock.withLock(this.file, () => {
        // Re-read under the lock and replay this batch onto the fresh state:
        // that is what makes concurrent writers additive instead of last-write-wins.
        const doc = this.readFile()
        for (const record of batch) applyRecord(doc, record, now)
        this.writeFile(doc)
      })
      this.lastFlushError = undefined
      this.flushFailedSince = undefined
    } catch (error) {
      // A failed flush must not lose the counts or break a generation: put the
      // batch back so the next flush retries it, and surface the reason once.
      this.pending = [...batch, ...this.pending]
      if (this.maxPending > 0 && this.pending.length > this.maxPending) {
        this.pending.splice(0, this.pending.length - this.maxPending)
      }
      this.lastFlushError = error
      if (this.flushFailedSince === undefined) {
        this.flushFailedSince = now
        try {
          this.onFlushError?.(error)
        } catch {
          // The reporter must never break a flush path.
        }
      }
      // Only the timer retries now; `record()` stops triggering immediate
      // flushes until one succeeds.
      this.armTimer()
    }
  }

  /** Flush if anything is pending; safe to call on turn end and process exit. */
  flushSync(): void {
    this.flush()
  }

  /**
   * A snapshot for reading (the Usage tab).
   *
   * Reads the file rather than an in-memory copy: the writer is not always this
   * process. A CLI `login`/`verify` runs in its own process, and the browser may
   * be served by a different plugin instance than the one that generated, so an
   * in-memory cache would show a stale or empty ledger. This process's own
   * un-flushed records are layered on top so the UI never lags behind its own
   * activity.
   *
   * Called once per UI open/refresh, never on the generation hot path, so the
   * read is cheap enough.
   */
  snapshot(): StatsDocument {
    const now = this.now()
    const doc = this.readFile()
    if (this.pending.length > 0) {
      for (const record of this.pending) applyRecord(doc, record, now)
    }
    return doc
  }

  /** The most recent flush failure, if any (diagnostics). */
  get flushError(): unknown {
    return this.lastFlushError
  }

  /** Number of records awaiting flush. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Whether the ledger is currently failing to persist (a run of failures). */
  get flushFailing(): boolean {
    return this.flushFailedSince !== undefined
  }
}
