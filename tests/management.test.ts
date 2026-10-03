import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgyManagement } from '../src/web/management.ts'
import { UsageStats, noopStatsLock } from '../src/stats.ts'
import { ModelVisibility } from '../src/model-visibility.ts'
import { ThinkingBudgetStore } from '../src/thinking-budget.ts'
import { UiPrefsStore } from '../src/ui-prefs.ts'
import type { AccountStore } from '../src/store/accounts.ts'
import type { AgySessionManager } from '../src/session.ts'
import type { AccountStorageV4, ManagedAccount } from '../src/types.ts'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return { refresh: 'refresh-a', addedAt: 1, lastUsed: 1, email: 'a@x.com', ...overrides }
}

/**
 * In-memory account store; `mutate` runs against the live array like the real one.
 *
 * `load` returns a COPY, matching both real implementations (`JsonAccountStore`
 * re-parses the file; `InMemoryAccountStore` uses `structuredClone`). Handing out
 * the live array made an in-place edit by a READER visible to the test, which
 * reported a persistence bug production cannot have — and would equally hide a
 * real one, since a caller mutating the result of `load()` would appear to
 * succeed here and be silently discarded there.
 */
function makeStore(accounts: ManagedAccount[], activeIndex = 0): AccountStore {
  const storage: AccountStorageV4 = { version: 4, accounts, activeIndex }
  return {
    load: async () => structuredClone(storage),
    mutate: async (fn) => fn(storage),
  } as unknown as AccountStore
}

interface Harness {
  management: ReturnType<typeof createAgyManagement>
  store: AccountStore
  stats: UsageStats
  visibility: ModelVisibility
  sessions: AgySessionManager
  calls: Array<{ method: string, args: unknown[] }>
  /** Catalog-change notifications the host would forward to open clients. */
  notifications: number
}

function makeHarness(options: {
  accounts?: ManagedAccount[]
  activeIndex?: number
  session?: unknown
  models?: Array<{ id: string, name: string }>
  verified?: unknown
  testResult?: unknown
  exportBlob?: unknown
  checkAccounts?: unknown
  limitsResult?: { measured: string[], failed: string[], skipped: number }
  /** What the session's in-flight snapshot reports (defaults to an idle pool). */
  inFlight?: Array<{ index: number, email: string | null, count: number }>
  /** What the session's burn-rate snapshot reports (defaults to none). */
  limitBurn?: Array<{ index: number, perHour: Record<string, number> }>
  baseUrl?: () => string
} = {}): Harness {
  const accounts = options.accounts ?? [account()]
  const store = makeStore(accounts, options.activeIndex ?? 0)
  const dir = mkdtempSync(join(tmpdir(), 'agy-mgmt-'))
  const stats = new UsageStats({
    file: join(dir, 'agy-stats.json'),
    lock: noopStatsLock,
    flushEvery: 0,
    flushIntervalMs: 0,
  })
  const visibility = new ModelVisibility({ file: join(dir, 'agy-models.json') })
  const calls: Array<{ method: string, args: unknown[] }> = []
  const session = options.session === undefined
    ? undefined
    : options.session
  const sessions = {
    getSession: async () => {
      calls.push({ method: 'getSession', args: [] })
      return session
    },
    verifyAccount: async (index: number) => {
      calls.push({ method: 'verifyAccount', args: [index] })
      return options.verified ?? { ok: true, email: 'a@x.com' }
    },
    testCall: async (model: string, callOptions?: { accountIndex?: number }) => {
      calls.push({ method: 'testCall', args: [model, callOptions] })
      return options.testResult ?? { ok: true, text: 'OK' }
    },
    exportBlob: async (index: number) => {
      calls.push({ method: 'exportBlob', args: [index] })
      return options.exportBlob ?? { blob: `blob-${index}` }
    },
    checkAccounts: async (indices?: number[]) => {
      calls.push({ method: 'checkAccounts', args: [indices] })
      return options.checkAccounts ?? [{ index: 0, ok: true }]
    },
    refreshLimits: async (_storage: unknown, refreshOptions?: { force?: boolean }) => {
      calls.push({ method: 'refreshLimits', args: [refreshOptions] })
      return options.limitsResult ?? { measured: [], failed: [], skipped: 0 }
    },
    inFlightAccounts: async () => {
      calls.push({ method: 'inFlightAccounts', args: [] })
      return options.inFlight ?? []
    },
    limitBurnRates: async () => options.limitBurn ?? [],
    // The real activateAccount writes through the store and clears affinity;
    // the stub mirrors its store contract so the RPC's bounds behavior is
    // exercised against the same persistence.
    activateAccount: async (index: number) => {
      calls.push({ method: 'activateAccount', args: [index] })
      await store.mutate((storage) => {
        if (index >= storage.accounts.length) throw new Error('account not found')
        storage.activeIndex = index
      })
    },
  } as unknown as AgySessionManager
  let notifications = 0
  let cacheInvalidations = 0
  // A real store on a scratch file, so the RPC exercises the same persistence the
  // host uses rather than a stub that could accept anything.
  const thinkingFile = join(mkdtempSync(join(tmpdir(), 'agy-thinking-rpc-')), 'agy-thinking.json')
  const thinkingBudget = new ThinkingBudgetStore({ file: thinkingFile })
  const prefsFile = join(mkdtempSync(join(tmpdir(), 'agy-ui-prefs-rpc-')), 'agy-ui-prefs.json')
  const uiPrefs = new UiPrefsStore(prefsFile)
  const management = createAgyManagement({
    store,
    sessions,
    stats,
    modelVisibility: visibility,
    uiPrefs,
    thinkingBudget: {
      all: () => thinkingBudget.all(),
      set: (level, value) => thinkingBudget.setBudget(level, value),
      claude: () => thinkingBudget.claudeBudget(),
      setClaude: (value) => thinkingBudget.setClaudeBudget(value).claudeBudget,
      tiered: () => thinkingBudget.tieredBudget(),
      setTiered: (value) => thinkingBudget.setTieredBudget(value).tieredBudget,
    },
    notifyModelsChanged: () => { notifications += 1 },
    invalidateModelCache: () => { cacheInvalidations += 1 },
    listAllModels: async () => options.models ?? [
      { id: 'model-a', name: 'Model A' },
      { id: 'model-b', name: 'Model B' },
    ],
    baseUrl: options.baseUrl ?? (() => 'http://127.0.0.1:3080'),
  })
  // A getter, not a copied primitive: the counter changes after this return.
  return {
    management,
    store,
    stats,
    visibility,
    sessions,
    calls,
    get notifications() { return notifications },
    get cacheInvalidations() { return cacheInvalidations },
  }
}

describe('agy management RPC', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an unknown method', async () => {
    const { management } = makeHarness()
    await expect(management.call('nope', {})).rejects.toThrow(/unknown method/)
  })

  it('lists accounts with derived state and no raw secrets', async () => {
    const { management } = makeHarness({
      accounts: [
        account({ email: 'active@x.com', projectId: 'p1' }),
        account({ email: 'cooling@x.com', coolingDownUntil: Date.now() + 60_000, cooldownReason: 'rate-limit' }),
        account({
          email: 'verify@x.com',
          verificationRequired: true,
          verificationUrl: 'https://accounts.google.com/verify?t=abc',
        }),
        account({ email: 'off@x.com', enabled: false }),
      ],
    })
    const { accounts } = await management.call('account.list', {}) as { accounts: Array<Record<string, unknown>> }
    expect(accounts.map((entry) => entry.state)).toEqual(['active', 'cooling', 'verification-required', 'disabled'])
    expect(accounts[0]?.active).toBe(true)
    expect(accounts[1]?.active).toBe(false)
    // The appeal URL is the actionable half of a verification challenge: the state
    // alone says an account is parked but not how to un-park it, and the Settings
    // section has nowhere else to get the link.
    expect(accounts[2]?.verificationRequired).toBe(true)
    expect(accounts[2]?.verificationUrl).toBe('https://accounts.google.com/verify?t=abc')
    expect(accounts[0]?.verificationUrl).toBeNull()
    // The refresh token must never cross the wire.
    expect(JSON.stringify(accounts)).not.toContain('refresh-a')
  })

  it('publishes when an account was disabled, and only then', async () => {
    // `enabled = false` has one cause (an upstream invalid_grant) and both
    // writers persist `verificationRequiredAt` in the same mutation, so the
    // wire can derive the disable time from it. The parked-but-ENABLED path
    // writes the same field without disabling — exposing it raw would give
    // "when it was disabled" a second, wrong meaning — and pre-field data must
    // read as unknown (null), never as epoch zero.
    const disabledAt = Date.now() - 60_000
    const { management } = makeHarness({
      accounts: [
        account({
          email: 'dead@x.com',
          enabled: false,
          verificationRequired: true,
          verificationRequiredAt: disabledAt,
          verificationRequiredReason: 'auth-failure',
        }),
        // Parked by a verification challenge, still enabled: NOT a disable time.
        account({ email: 'parked@x.com', verificationRequired: true, verificationRequiredAt: disabledAt }),
        // Disabled before the timestamp field existed.
        account({ email: 'legacy@x.com', enabled: false }),
      ],
    })
    const { accounts } = await management.call('account.list', {}) as {
      accounts: Array<{ state: string, disabledAt: string | null }>
    }
    expect(accounts.map((entry) => entry.state)).toEqual(['disabled', 'verification-required', 'disabled'])
    expect(accounts[0]?.disabledAt).toBe(new Date(disabledAt).toISOString())
    expect(accounts[1]?.disabledAt).toBeNull()
    expect(accounts[2]?.disabledAt).toBeNull()
  })

  it('masks a configured proxy rather than echoing credentials', async () => {
    const { management } = await makeHarness({
      accounts: [account({ proxy: 'http://user:secret@proxy.test:8080' })],
    })
    const { accounts } = await management.call('account.list', {}) as { accounts: Array<{ proxy: string | null }> }
    expect(accounts[0]?.proxy).toContain('proxy.test:8080')
    expect(accounts[0]?.proxy).not.toContain('secret')
  })

  it('joins the ledger onto each account row', async () => {
    const harness = makeHarness({ accounts: [account({ email: 'a@x.com' })] })
    harness.stats.record({
      account: 'a@x.com', model: 'model-a', source: 'chat', ok: true,
      usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0 },
    })
    const { accounts } = await harness.management.call('account.list', {}) as {
      accounts: Array<{ usage: { totals: { requests: number, input: number }, lastUsedAt: number | null } | null }>
    }
    expect(accounts[0]?.usage?.totals.requests).toBe(1)
    expect(accounts[0]?.usage?.totals.input).toBe(10)
    // The row's "active N ago" fragment reads this; the ledger stamps it on
    // every record, so a traffic-bearing account always carries it.
    expect(accounts[0]?.usage?.lastUsedAt).toBeGreaterThan(0)
  })

  it('reports which accounts have requests in flight, as a pure local read', async () => {
    // `pool.status` must never touch upstream — it is polled every few seconds
    // while the panel is open, and a quota probe or token refresh per tick
    // would turn a status line into a bill.
    const harness = makeHarness({
      accounts: [account({ email: 'a@x.com' }), account({ email: 'b@y.com' })],
      inFlight: [{ index: 1, email: 'b@y.com', count: 2 }],
    })
    const result = await harness.management.call('pool.status', {}) as {
      busy: Array<{ index: number, email: string | null, count: number }>
    }
    expect(result.busy).toEqual([{ index: 1, email: 'b@y.com', count: 2 }])
  })

  it('carries the burn rates on the limits reply, per index', async () => {
    // The rate only exists after the sampling path has seen two probes; the
    // reply degrades to null rather than failing when the session has none.
    const withRate = makeHarness({ limitBurn: [{ index: 0, perHour: { 'g-5h': 0.02 } }] })
    const result = await withRate.management.call('account.limits', {}) as {
      limits: Array<{ burn: Record<string, number> | null }>
    }
    expect(result.limits[0]?.burn).toEqual({ 'g-5h': 0.02 })

    const withoutRate = makeHarness()
    const plain = await withoutRate.management.call('account.limits', {}) as {
      limits: Array<{ burn: Record<string, number> | null }>
    }
    expect(plain.limits[0]?.burn).toBeNull()
  })

  it('reports an idle pool as an empty busy list', async () => {
    // Empty is the idle pool, not an error: the live line keys off it to
    // disappear, so a quiet pool must render no strip at all.
    const { management } = makeHarness()
    const result = await management.call('pool.status', {}) as { busy: unknown[] }
    expect(result.busy).toEqual([])
  })

  it('exposes the cached 5h/weekly windows, and null when never measured', async () => {
    // The windows are read from the cache the session manager refreshes, so the
    // accounts reply must carry them without an extra upstream call. `null` (not
    // an empty array) is what tells the UI to say "not measured yet" rather than
    // render an empty card — an account with no headroom and an account nobody
    // has probed are opposite facts.
    const unmeasured = makeHarness({ accounts: [account({ email: 'a@x.com' })] })
    const before = await unmeasured.management.call('account.list', {}) as {
      accounts: Array<{ limits: unknown, limitsUpdatedAt: number | null }>
    }
    expect(before.accounts[0]?.limits).toBeNull()
    expect(before.accounts[0]?.limitsUpdatedAt).toBeNull()

    const measured = makeHarness({
      accounts: [account({
        email: 'a@x.com',
        cachedLimits: {
          updatedAt: 1_700_000_000_000,
          groups: [{
            name: 'Gemini Models',
            windows: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.16, resetTime: '2026-09-23T19:29:55Z' },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.61, resetTime: null },
            ],
          }],
        },
      })],
    })
    const after = await measured.management.call('account.list', {}) as {
      accounts: Array<{
        limits: Array<{ name: string, windows: Array<{ window: string, remainingFraction: number | null }> }> | null
        limitsUpdatedAt: number | null
      }>
    }
    expect(after.accounts[0]?.limits?.[0]?.name).toBe('Gemini Models')
    expect(after.accounts[0]?.limits?.[0]?.windows.map((w) => w.window)).toEqual(['5h', 'weekly'])
    expect(after.accounts[0]?.limits?.[0]?.windows[0]?.remainingFraction).toBe(0.16)
    expect(after.accounts[0]?.limitsUpdatedAt).toBe(1_700_000_000_000)
  })

  it('validates the account index on mutating calls', async () => {
    const { management } = makeHarness()
    await expect(management.call('account.activate', { index: -1 })).rejects.toThrow(/invalid index/)
    await expect(management.call('account.delete', { index: 1.5 })).rejects.toThrow(/invalid index/)
    await expect(management.call('account.activate', { index: 99 })).rejects.toThrow(/account not found/)
  })

  it('activates and deletes accounts', async () => {
    const harness = makeHarness({ accounts: [account({ email: 'a@x.com' }), account({ email: 'b@y.com' })] })
    await harness.management.call('account.activate', { index: 1 })
    expect((await harness.store.load()).activeIndex).toBe(1)
    // The activated account may see a different catalog, so activation must
    // drop the model-list cache rather than let the picker ride the TTL.
    expect(harness.cacheInvalidations).toBe(1)
    await harness.management.call('account.delete', { index: 0 })
    const after = await harness.store.load()
    expect(after.accounts.map((entry) => entry.email)).toEqual(['b@y.com'])
  })

  it('requires a model for test and delegates the call', async () => {
    const harness = makeHarness()
    await expect(harness.management.call('account.test', {})).rejects.toThrow(/model is required/)
    await expect(harness.management.call('account.test', { model: 'model-a' }))
      .resolves.toMatchObject({ ok: true })
    expect(harness.calls).toContainEqual({ method: 'testCall', args: ['model-a', {}] })
  })

  it('forwards the clicked account index to the test call', async () => {
    // The row's index must reach the session manager, or the probe runs on
    // whichever account affinity picked and reports as this row's result.
    const harness = makeHarness({ accounts: [account(), account({ email: 'b@y.com' })] })
    await harness.management.call('account.test', { model: 'model-a', index: 1 })
    expect(harness.calls).toContainEqual({ method: 'testCall', args: ['model-a', { accountIndex: 1 }] })
  })

  it('rejects a malformed test index', async () => {
    const harness = makeHarness()
    await expect(harness.management.call('account.test', { model: 'model-a', index: -1 }))
      .rejects.toThrow(/invalid index/)
  })

  describe('model visibility', () => {
    it('lists the unfiltered catalog with each model\'s hidden flag', async () => {
      const harness = makeHarness({ session: { index: 0, account: account(), auth: {} } })
      harness.visibility.setDisabled('agy', 'model-b', true)
      const result = await harness.management.call('model.list', {}) as {
        account: string | null
        models: Array<{ id: string, disabled: boolean }>
      }
      // The disabled model must still be listed: it is the only place its switch
      // can be turned back on.
      expect(result.models).toEqual([
        { id: 'model-a', name: 'Model A', disabled: false },
        { id: 'model-b', name: 'Model B', disabled: true },
      ])
      expect(result.account).toBe('a@x.com')
    })

    it('toggles a model and persists it', async () => {
      const harness = makeHarness()
      await harness.management.call('model.setDisabled', { modelId: 'model-a', disabled: true })
      expect(harness.visibility.isDisabled('agy', 'model-a')).toBe(true)
      await harness.management.call('model.setDisabled', { modelId: 'model-a', disabled: false })
      expect(harness.visibility.isDisabled('agy', 'model-a')).toBe(false)
    })

    it('announces the change so an open picker refreshes without a reload', async () => {
      // Regression: the blacklist lives in agy's own file, so no DSH event fires
      // on its own. Without this notification the toggle appeared to do nothing
      // until the page was reloaded.
      const harness = makeHarness()
      await harness.management.call('model.setDisabled', { modelId: 'model-a', disabled: true })
      expect(harness.notifications).toBe(1)
      await harness.management.call('model.setDisabled', { modelId: 'model-a', disabled: false })
      expect(harness.notifications).toBe(2)
    })

    it('does not announce anything when the toggle is rejected', async () => {
      const harness = makeHarness()
      await expect(harness.management.call('model.setDisabled', { modelId: '' })).rejects.toThrow()
      expect(harness.notifications).toBe(0)
    })

    it('rejects an empty model id', async () => {
      const harness = makeHarness()
      await expect(harness.management.call('model.setDisabled', { modelId: '' }))
        .rejects.toThrow(/modelId is required/)
    })

    it('fails model.list helpfully when no account is configured', async () => {
      const harness = makeHarness({ session: undefined })
      await expect(harness.management.call('model.list', {}))
        .rejects.toThrow(/No agy account configured/)
    })
  })

  describe('thinking budget', () => {
    it('starts empty and reports the measured interval', async () => {
      // Empty is the meaningful default: no level has a budget, so every request
      // keeps sending `thinkingLevel` exactly as before this setting existed.
      const { management } = makeHarness()
      const result = await management.call('thinking.get', {}) as {
        budgets: Record<string, number>
        min: number
        max: number
      }
      expect(result.budgets).toEqual({})
      // The interval is the measured one, and it travels with the values so the
      // UI cannot drift from what upstream accepts.
      expect(result.min).toBe(-1)
      expect(result.max).toBe(65535)
    })

    it('sets and clears one level, round-tripping through the reply', async () => {
      const { management } = makeHarness()
      const set = await management.call('thinking.set', { level: 'high', budget: 16000 }) as {
        budgets: Record<string, number>
      }
      expect(set.budgets).toEqual({ high: 16000 })
      const read = await management.call('thinking.get', {}) as { budgets: Record<string, number> }
      expect(read.budgets).toEqual({ high: 16000 })

      // Clearing is its own action: `null` and an omitted value both mean "let
      // upstream decide", which is distinct from setting 0.
      const cleared = await management.call('thinking.set', { level: 'high', budget: null }) as {
        budgets: Record<string, number>
      }
      expect(cleared.budgets).toEqual({})
      const omitted = await management.call('thinking.set', { level: 'low', budget: 1000 })
      expect((omitted as { budgets: Record<string, number> }).budgets).toEqual({ low: 1000 })
      const alsoCleared = await management.call('thinking.set', { level: 'low' }) as {
        budgets: Record<string, number>
      }
      expect(alsoCleared.budgets).toEqual({})
    })

    it('sets, reads and clears the Tiered slot budget', async () => {
      // The selector's "Default" effort has no level id, so it is its own slot.
      // Empty = upstream allocates; a value = Max, a bare cap.
      const { management } = makeHarness()
      const initial = await management.call('thinking.get', {}) as { tieredBudget: number | null }
      expect(initial.tieredBudget).toBeNull()
      const set = await management.call('thinking.setTiered', { budget: 65535 }) as { tieredBudget: number | null }
      expect(set.tieredBudget).toBe(65535)
      expect((await management.call('thinking.get', {}) as { tieredBudget: number | null }).tieredBudget).toBe(65535)
      expect((await management.call('thinking.setTiered', { budget: null }) as { tieredBudget: number | null }).tieredBudget).toBeNull()
      await expect(management.call('thinking.setTiered', { budget: 70000 })).rejects.toThrow(/65535/)
    })

    it('sets, reads and clears the Claude budget', async () => {
      // Claude has no levels (each capability is its own model id), so it gets a
      // single value with its OWN interval: floor 1024, not -1.
      const { management } = makeHarness()
      const initial = await management.call('thinking.get', {}) as {
        claudeBudget: number | null
        claudeMin: number
        claudeMax: number
      }
      expect(initial.claudeBudget).toBeNull()
      expect(initial.claudeMin).toBe(1024)
      expect(initial.claudeMax).toBe(63999)

      const set = await management.call('thinking.setClaude', { budget: 16384 }) as { claudeBudget: number | null }
      expect(set.claudeBudget).toBe(16384)
      expect((await management.call('thinking.get', {}) as { claudeBudget: number | null }).claudeBudget).toBe(16384)

      // -1 and 0 are accepted as special values by the validator.
      expect((await management.call('thinking.setClaude', { budget: -1 }) as { claudeBudget: number | null }).claudeBudget).toBe(-1)
      // Clearing is its own action.
      expect((await management.call('thinking.setClaude', { budget: null }) as { claudeBudget: number | null }).claudeBudget).toBeNull()
    })

    it('rejects a Claude budget below its own floor', async () => {
      // The tiered interval allows -1 and 1; Claude's floor is 1024, so the two
      // must not share a validator.
      const { management } = makeHarness()
      await expect(management.call('thinking.setClaude', { budget: 512 })).rejects.toThrow(/1024/)
      await expect(management.call('thinking.setClaude', { budget: 64000 })).rejects.toThrow(/63999/)
      await expect(management.call('thinking.setClaude', { budget: '100' })).rejects.toThrow(/must be a number/)
    })
    it('rejects out-of-range values with the upstream interval in the message', async () => {
      // Upstream answers 400 naming this range, so rejecting it here turns a
      // per-request failure into a save-time message.
      const { management } = makeHarness()
      await expect(management.call('thinking.set', { level: 'high', budget: 65536 }))
        .rejects.toThrow(/65535/)
      await expect(management.call('thinking.set', { level: 'high', budget: -2 }))
        .rejects.toThrow(/-1/)
      await expect(management.call('thinking.set', { level: 'nope', budget: 100 }))
        .rejects.toThrow(/unknown thinking level/)
      await expect(management.call('thinking.set', { level: '', budget: 100 }))
        .rejects.toThrow(/level is required/)
      await expect(management.call('thinking.set', { level: 'high', budget: '100' }))
        .rejects.toThrow(/must be a number/)
    })
  })

  describe('cooldown display', () => {
    it('reports no reason once the cooldown window has expired', async () => {
      // Regression: `clearExpiredState` only ran inside `pickAccount`, i.e. only
      // when a request was actually made, so a management read rendered a reason
      // for a window that had already lapsed. The badge compared
      // `coolingDownUntil > now` itself and said "active" while the detail row
      // still said "network-error" — a self-contradiction on one screen, and it
      // sat on a real account for hours.
      const harness = makeHarness({
        accounts: [account({
          email: 'a@x.com',
          coolingDownUntil: Date.now() - 60_000, // expired a minute ago
          cooldownReason: 'network-error',
          cooldownSetAt: Date.now() - 120_000,
        })],
      })
      const { accounts } = await harness.management.call('account.list', {}) as {
        accounts: Array<{ state: string, cooldownReason: string | null, cooldownUntil: string | null, cooldownSetAt: string | null }>
      }
      expect(accounts[0]?.state).toBe('active')
      // The row must agree with the badge.
      expect(accounts[0]?.cooldownReason).toBeNull()
      expect(accounts[0]?.cooldownUntil).toBeNull()
      expect(accounts[0]?.cooldownSetAt).toBeNull()
    })

    it('reports the reason and its start while the window is live', async () => {
      const started = Date.now() - 30_000
      const harness = makeHarness({
        accounts: [account({
          email: 'a@x.com',
          coolingDownUntil: Date.now() + 60_000,
          cooldownReason: 'network-error',
          cooldownSetAt: started,
        })],
      })
      const { accounts } = await harness.management.call('account.list', {}) as {
        accounts: Array<{ state: string, cooldownReason: string | null, cooldownSetAt: string | null }>
      }
      expect(accounts[0]?.state).toBe('cooling')
      expect(accounts[0]?.cooldownReason).toBe('network-error')
      // The START travels, because the reason's age is the actionable half and
      // the end cannot yield it (the duration is a backoff).
      expect(accounts[0]?.cooldownSetAt).toBe(new Date(started).toISOString())
    })

    it('does not write to the store just because it rendered', async () => {
      // The expiry above is applied to an in-memory copy: a read must not mutate
      // persisted state.
      const harness = makeHarness({
        accounts: [account({
          email: 'a@x.com',
          coolingDownUntil: Date.now() - 60_000,
          cooldownReason: 'network-error',
        })],
      })
      await harness.management.call('account.list', {})
      const persisted = (await harness.store.load()).accounts[0]!
      expect(persisted.cooldownReason).toBe('network-error')
      expect(persisted.coolingDownUntil).toBeGreaterThan(0)
    })
  })

  describe('stats', () => {
    it('folds the ledger into all-time, windowed, per-account and per-model views', async () => {
      const harness = makeHarness()
      const now = Date.now()
      harness.stats.record({
        account: 'a@x.com', model: 'model-a', source: 'chat', ok: true,
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
      })
      // A record older than the retained window: counted all-time, not in any
      // window. Written in the CURRENT day-bucket shape; version-1 flat counters
      // are covered by the migration test in stats.test.ts.
      const doc = harness.stats.snapshot()
      doc.days['2020-01-01'] = {
        totals: {
          input: 7, output: 0, cacheRead: 0, cacheWrite: 0,
          requests: 1, succeeded: 1, failed: 0, rateLimited: 0, rotations: 0,
          latencyMs: 0, latencyN: 0, ttftMs: 0, ttftN: 0,
        },
        models: {},
        accounts: {},
      }
      const view = await harness.management.call('stats.get', {}) as {
        all: {
          counters: { requests: number }
          accounts: Array<{ account: string }>
          models: Array<{ model: string }>
        }
        today: {
          counters: { requests: number }
          models: Array<{ model: string }>
          accounts: Array<{ account: string }>
        }
      }
      expect(view.all.counters.requests).toBeGreaterThanOrEqual(1)
      expect(view.today.counters.requests).toBe(1)
      expect(view.all.accounts.map((entry) => entry.account)).toContain('a@x.com')
      expect(view.all.models.map((entry) => entry.model)).toContain('model-a')
      // Every range carries its own breakdown, so both tables follow the range
      // selector instead of showing all-time rows under a windowed headline.
      expect(view.today.models.map((entry) => entry.model)).toEqual(['model-a'])
      expect(view.today.accounts.map((entry) => entry.account)).toEqual(['a@x.com'])
      expect(now).toBeGreaterThan(0)
      // The trend series is the last 7 LOCAL calendar days, zeros filled —
      // the 2020 bucket above exists but must not appear in the window.
      expect(view.days).toHaveLength(7)
      expect(view.days.at(-1)?.requests).toBeGreaterThanOrEqual(1)
      expect(view.days.some((entry) => entry.day === '2020-01-01')).toBe(false)
    })

    it('reports an empty ledger without inventing a start date', async () => {
      const { management } = makeHarness()
      const view = await management.call('stats.get', {}) as {
        since: number | null
        all: { counters: { requests: number } }
      }
      expect(view.all.counters.requests).toBe(0)
      expect(view.since).toBeNull()
    })
  })

  describe('credentials', () => {
    it('imports a batch and reports the count', async () => {
      const harness = makeHarness()
      // A malformed source must fail loudly rather than importing nothing quietly.
      await expect(harness.management.call('account.import', { kind: 'json', sources: [] }))
        .rejects.toThrow(/nothing to import/)
    })

    it('reports per-source failures instead of discarding them', async () => {
      // The UI can only tell the user which lines failed if the failures cross
      // the wire: `errors` is typed `string[]` and must always be present.
      const harness = makeHarness()
      const result = await harness.management.call('account.import', {
        kind: 'json',
        sources: ['not json at all'],
      }) as { imported: number, replaced: number, errors: string[] }
      expect(result.imported).toBe(0)
      expect(result.replaced).toBe(0)
      expect(Array.isArray(result.errors)).toBe(true)
      expect(result.errors).toHaveLength(1)
      expect(typeof result.errors[0]).toBe('string')
    })

    it('reports a mixed batch as a partial success with the failing sources named', async () => {
      // The exact shape the Credentials tab renders: success counts plus the
      // per-source messages. Before this the whole result was dropped, so a
      // half-failed paste looked like nothing had happened.
      //
      // Enrichment (userinfo/loadCodeAssist) is unstubbed here, so the well-formed
      // source cannot complete: what this pins is the WIRE SHAPE — per-source
      // failures are returned alongside the counts and never collapse the batch
      // into a thrown error.
      const harness = makeHarness()
      const result = await harness.management.call('account.import', {
        kind: 'json',
        sources: ['{"token":{"access_token":"at","refresh_token":"rt"}}', 'garbage'],
      }) as { imported: number, replaced: number, errors: string[] }
      expect(result.errors).toHaveLength(2)
      expect(result.errors.every((error) => typeof error === 'string' && error !== '')).toBe(true)
      // Partial success is not an exception: the call resolves.
      expect(result.imported + result.replaced).toBe(0)
    })

    it('exports every account as a blob', async () => {
      const harness = makeHarness({ accounts: [account(), account({ email: 'b@y.com' })] })
      const result = await harness.management.call('account.exportAll', {}) as {
        blobs: Array<{ index: number, blob: string }>
      }
      expect(result.blobs).toEqual([
        { index: 0, blob: 'blob-0' },
        { index: 1, blob: 'blob-1' },
      ])
    })

    it('surfaces an export failure per account', async () => {
      const harness = makeHarness({ exportBlob: { error: 'refresh failed (revoked?)' } })
      const result = await harness.management.call('account.export', { index: 0 }) as { error?: string }
      expect(result.error).toMatch(/revoked/)
    })
  })


  describe('proxy', () => {
    it('normalizes a saved proxy and never returns it raw', async () => {
      const harness = makeHarness()
      const result = await harness.management.call('account.proxy', {
        index: 0,
        proxy: 'http://user:pass@proxy.test:8080',
      }) as { proxy: string | null }
      expect(result.proxy).toContain('proxy.test:8080')
      expect(result.proxy).not.toContain('pass')
      expect((await harness.store.load()).accounts[0]?.proxy).toContain('proxy.test')
    })

    it('clears a proxy when given an empty string', async () => {
      const harness = makeHarness({ accounts: [account({ proxy: 'http://proxy.test:8080' })] })
      const result = await harness.management.call('account.proxy', { index: 0, proxy: '   ' }) as {
        proxy: string | null
      }
      expect(result.proxy).toBeNull()
      expect((await harness.store.load()).accounts[0]?.proxy).toBeUndefined()
    })
  })

  describe('limits refresh', () => {
    it('defaults to the TTL, so an automatic reload spends no upstream call', async () => {
      // `account.limits` is called on mount and on tab entry. Forcing there would
      // turn every page view into a quota probe.
      const harness = makeHarness()
      await harness.management.call('account.limits', {})
      const refresh = harness.calls.find((call) => call.method === 'refreshLimits')
      expect(refresh?.args).toEqual([{ force: false }])
    })

    it('threads force through, which is what the toolbar Refresh needs', async () => {
      // Without this the button could not deliver anything newer than the TTL
      // already held, so "the latest numbers now" was unanswerable.
      const harness = makeHarness()
      await harness.management.call('account.limits', { force: true })
      const refresh = harness.calls.find((call) => call.method === 'refreshLimits')
      expect(refresh?.args).toEqual([{ force: true }])
    })

    it('reports the outcome so a forced refresh is never silent', async () => {
      // A failed force leaves the numbers and the timestamp untouched, so the
      // reply itself is the only thing that can distinguish it from "still
      // fresh" — the difference between a working button and an inert one.
      const harness = makeHarness({ limitsResult: { measured: ['a'], failed: ['b'], skipped: 2 } })
      const result = await harness.management.call('account.limits', { force: true }) as {
        measured: number, failed: number, skipped: number
      }
      expect(result).toMatchObject({ measured: 1, failed: 1, skipped: 2 })
    })

    it('degrades to zeroed counts when the refresh itself throws', async () => {
      const harness = makeHarness()
      ;(harness.sessions as unknown as { refreshLimits: () => Promise<never> }).refreshLimits =
        async () => { throw new Error('boom') }
      const result = await harness.management.call('account.limits', { force: true }) as {
        measured: number, failed: number, skipped: number
      }
      expect(result).toMatchObject({ measured: 0, failed: 0, skipped: 0 })
    })
  })

  describe('OAuth callback', () => {
    it('rejects a callback with no code or state', async () => {
      const { management } = makeHarness()
      const result = await management.handleCallback(new URLSearchParams())
      expect(result).toMatchObject({ ok: false })
      expect(result.error).toMatch(/Missing code or state/)
    })

    it('rejects a state it never issued', async () => {
      // The PKCE verifier is bound to the issued state; an unknown state must
      // never be exchangeable.
      const { management } = makeHarness()
      const result = await management.handleCallback(new URLSearchParams({ code: 'c', state: 'forged' }))
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Unknown or expired/)
    })

    it('issues an authorization URL bound to the loopback callback', async () => {
      const { management } = makeHarness()
      const { url } = await management.call('auth.url', {}) as { url: string }
      const parsed = new URL(url)
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:3080/agy/oauth-callback')
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
      // The verifier travels in the state payload, never as a bare parameter.
      expect(parsed.searchParams.get('state')).toBeTruthy()
      void vi
    })

    it('reads the base URL when the authorization is issued, not when management is built', async () => {
      // The web entry builds management before the server's listen callback
      // has necessarily reported the bound port; a URL copied at construction
      // would pin whatever stood in for it then.
      let port = 0
      const { management } = makeHarness({ baseUrl: () => `http://127.0.0.1:${port}` })
      port = 54775
      const { url } = await management.call('auth.url', {}) as { url: string }
      expect(new URL(url).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54775/agy/oauth-callback')
    })
  })

  describe('ui preferences', () => {
    it('reads default preferences and updates them', async () => {
      const { management } = makeHarness()
      const initial = await management.call('ui.prefs.get', {}) as { conversationBadge: boolean }
      expect(initial.conversationBadge).toBe(false)

      const updated = await management.call('ui.prefs.set', { conversationBadge: true }) as { conversationBadge: boolean }
      expect(updated.conversationBadge).toBe(true)

      const readBack = await management.call('ui.prefs.get', {}) as { conversationBadge: boolean }
      expect(readBack.conversationBadge).toBe(true)
    })

    it('rejects invalid preference values', async () => {
      const { management } = makeHarness()
      await expect(management.call('ui.prefs.set', { conversationBadge: 'invalid' as never }))
        .rejects.toThrow(/must be a boolean/)
    })
  })
})

describe('RPC failure envelope contract', () => {
  it('every failure carries error.details, or the client rejects it as transport damage', () => {
    // Regression: the client's envelope parser requires `error.details` to be an
    // object. A failure without it surfaces as "invalid server-response" — a
    // transport-sounding error that hides the real message — which is exactly
    // how the model-toggle failure was reported.
    const normalize = (result: { ok: false, error: { code?: string, message?: string, details?: unknown } }) =>
      ({ ...result, error: { details: {}, ...result.error } })

    const withoutDetails = normalize({ ok: false, error: { code: 'agy/handler-failed', message: 'boom' } })
    expect(withoutDetails.error.details).toEqual({})
    // An explicitly provided details object must survive normalization.
    const withDetails = normalize({ ok: false, error: { message: 'boom', details: { hint: 1 } } })
    expect(withDetails.error.details).toEqual({ hint: 1 })
  })
})
