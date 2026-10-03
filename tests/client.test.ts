import { readdirSync, readFileSync } from 'node:fs'
import { expect, it, describe } from 'vitest'
import { apply, canActivateAccount, orderModels, resolveSelectedAccountIndex, throughputTokenPerSecond, tokenText, truncateIdentity } from '../src/client/index.ts'
import { AgyQuotaBadge } from '../src/client/quota-badge.ts'
import { installAgyStyles } from '../src/client/styles.ts'
import { en, zh } from '../src/client/locales.ts'
import { zeroCounters } from '../src/usage-types.ts'
import type { AccountView, ModelView } from '../src/rpc-contract.ts'
import type { UsageCounters } from '../src/usage-types.ts'

/**
 * The browser half's TypeScript sources.
 *
 * The i18n scans below are about the UI as a whole, not one file: the header
 * badge lives in its own modules, and a scan pinned to `index.ts` would call
 * every key it uses "unused" and every literal it holds "invisible".
 */
function clientFiles(): Array<{ name: string, source: string }> {
  const dir = new URL('../src/client/', import.meta.url)
  return readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, source: readFileSync(new URL(name, dir), 'utf8') }))
}

/** Minimal client context: locale, connection (RPC transport), and the slot registry. */
function makeContext(options: {
  withConnection?: boolean
  rpcHandler?: (method: string, payload: unknown) => Promise<unknown>
  onRegister?: (registration: { id: string, name: string }, factory?: () => unknown) => void
} = {}) {
  const entries: Array<{ id: string, name: string }> = []
  const dictionaries: string[] = []
  // One cleanup per effect, in registration order: the plugin installs two
  // (stylesheet, dictionaries) before it registers anything, and each slot
  // registration is an effect of its own — keeping only the last would leave
  // the earlier registration behind on dispose.
  const cleanups: Array<() => void> = []
  const warnings: string[] = []
  const ctx = {
    effect: (install: () => () => void) => { cleanups.push(install()); return () => {} },
    get: (name: string) => (name === 'connection' && options.withConnection !== false
      ? {
          rpc: {
            call: async (_channel: string, _endpoint: string, envelope: { method: string, payload: unknown }) => {
              if (options.rpcHandler) {
                return { ok: true, value: await options.rpcHandler(envelope.method, envelope.payload) }
              }
              return { ok: true, value: {} }
            },
          },
        }
      : undefined),
    locale: {
      register: (ns: string) => { dictionaries.push(ns); return () => {} },
      bind: () => (key: string) => key,
      getLocale: () => ({ active: 'zh' as const, locales: [], revision: 0 }),
    },
    logger: { warn: (message: string) => { warnings.push(message) } },
    slots: {
      inject: (_slot: string, install: () => () => void) => install(),
      register: (registration: { id: string, name: string }, factory?: () => unknown) => {
        entries.push({ id: registration.id, name: registration.name })
        options.onRegister?.(registration, factory)
        return () => {
          const at = entries.findIndex((entry) => entry.id === registration.id)
          if (at >= 0) entries.splice(at, 1)
        }
      },
    },
  }
  return {
    ctx,
    entries,
    dictionaries,
    warnings,
    dispose: () => { for (const undo of cleanups.reverse()) undo() },
  }
}

describe('dsh-agy client plugin', () => {
  it('registers only the Antigravity Settings section by default (opt-in disabled)', () => {
    // #62 invariant: by default conversation header badge is NOT registered.
    const { ctx, entries, dictionaries } = makeContext()
    apply(ctx as never)
    expect(entries).toEqual([
      { id: 'agy', name: 'settings.section' },
    ])
    // The section must own a dictionary, or its copy cannot follow the host's
    // language setting.
    expect(dictionaries).toEqual(['agy'])
  })

  it('removes registration when the client fiber disposes', () => {
    const { ctx, entries, dispose } = makeContext()
    apply(ctx as never)
    expect(entries).toHaveLength(1)
    dispose()
    expect(entries).toEqual([])
  })

  it('registers quota badge when opt-in preference is enabled on startup', async () => {
    let capturedFactory: (() => unknown) | undefined
    const { ctx, entries, dispose } = makeContext({
      rpcHandler: async (method) => {
        if (method === 'ui.prefs.get') return { conversationBadge: true }
        return {}
      },
      onRegister: (registration, factory) => {
        if (registration.id === 'agy-quota-badge') capturedFactory = factory
      },
    })
    apply(ctx as never)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(entries).toEqual([
      { id: 'agy', name: 'settings.section' },
      { id: 'agy-quota-badge', name: 'conversation.session.header.actions' },
    ])
    expect(capturedFactory).toBeDefined()
    const element = capturedFactory!() as { type: unknown }
    expect(element.type).toBe(AgyQuotaBadge)
    dispose()
    expect(entries).toEqual([])
  })

  it('dynamically registers and unregisters badge when toggled from settings', () => {
    let capturedSettingsProps: Record<string, unknown> | undefined
    const { ctx, entries } = makeContext({
      onRegister: (registration, factory) => {
        if (registration.id === 'agy' && factory) {
          capturedSettingsProps = (factory() as { props: Record<string, unknown> }).props
        }
      },
    })
    apply(ctx as never)
    expect(entries).toEqual([{ id: 'agy', name: 'settings.section' }])

    const onBadgePrefChange = capturedSettingsProps?.onBadgePrefChange as ((enabled: boolean) => void) | undefined
    expect(onBadgePrefChange).toBeDefined()

    // Turn ON
    onBadgePrefChange!(true)
    expect(entries).toEqual([
      { id: 'agy', name: 'settings.section' },
      { id: 'agy-quota-badge', name: 'conversation.session.header.actions' },
    ])

    // Turn OFF
    onBadgePrefChange!(false)
    expect(entries).toEqual([
      { id: 'agy', name: 'settings.section' },
    ])
  })

  it('skips registration and warns when the connection service is absent', () => {
    // Profiles without a Web composition have no `connection`; the plugin must
    // degrade to a warning rather than throwing during activation.
    const { ctx, entries, warnings } = makeContext({ withConnection: false })
    apply(ctx as never)
    expect(entries).toEqual([])
    expect(warnings.join('\n')).toContain('connection service unavailable')
  })
})

describe('agy section i18n', () => {
  it('keeps zh and en key-for-key identical', () => {
    // A key present in one dictionary but not the other renders as the raw key
    // in that locale, which is invisible until a user switches language.
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('has no empty translations', () => {
    for (const [key, value] of [...Object.entries(zh), ...Object.entries(en)]) {
      expect(value.trim(), `empty translation for "${key}"`).not.toBe('')
    }
  })

  it('uses the same placeholders in both languages', () => {
    // A placeholder renamed in one language silently drops the value.
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort()
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      expect(placeholders(zh[key]), `placeholder mismatch in "${key}"`).toEqual(placeholders(en[key]))
    }
  })

  it('has no unused keys and no copy that bypasses the dictionary', () => {
    // Two failures this catches that the parity test cannot:
    //  - a dead key (its copy can never render, and it drifts from the UI);
    //  - a hardcoded label (Chinese string literals shipped into the English UI),
    //    which is why the Credentials tab's import buttons are checked here.
    const source = clientFiles().map((file) => file.source).join('\n')
    const unused = (Object.keys(zh) as Array<keyof typeof zh>)
      .filter((key) => !source.includes(`'${key}'`))
    expect(unused, `locale keys never referenced by the client: ${unused.join(', ')}`).toEqual([])
  })

  it('passes every placeholder a key declares at every call site', () => {
    // The host's translator substitutes `{name}` only when `name in params`, and
    // otherwise returns the match UNCHANGED — so a forgotten argument renders the
    // literal braces to the user (`代理可达：{proxy}`) instead of failing. The
    // parity test above compares the two dictionaries and so cannot see this:
    // both sides agree on a placeholder that no caller ever supplies.
    const source = clientFiles().map((file) => file.source).join('\n')
    const missing: string[] = []
    for (const [key, template] of Object.entries(zh)) {
      const names = [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string)
      if (names.length === 0) continue
      // Every `t('key', ...)` call, up to the closing paren of its first argument
      // list — enough to see the params object literal that follows.
      const calls = [...source.matchAll(new RegExp(`t\\('${key}'\\s*(,\\s*\\{[^}]*\\})?`, 'g'))]
      expect(calls.length, `key "${key}" has placeholders but no call site`).toBeGreaterThan(0)
      for (const call of calls) {
        const params = call[1] ?? ''
        for (const name of names) {
          // Accept both an explicit property (`{ proxy: result.masked }`) and the
          // shorthand that just forwards a same-named binding (`{ value }`).
          const supplied = new RegExp(`\\b${name}\\s*:`).test(params)
            || new RegExp(`[{,]\\s*${name}\\s*[,}]`).test(params)
          if (!supplied) missing.push(`${key} -> {${name}}`)
        }
      }
    }
    expect(missing, `placeholder never supplied at its call site: ${missing.join(', ')}`).toEqual([])
  })

  it('has no CJK literals outside the dictionaries', () => {
    // The UI's copy belongs in locales.ts; a literal anywhere in the browser half
    // is untranslatable and invisible to every other i18n check. `styles.ts`
    // carries no user-visible text at all, so it is held to the same rule, and
    // every module added to the half is scanned without editing this list.
    // `locales.ts` is the dictionary itself: the one file where CJK belongs.
    for (const file of clientFiles().filter((entry) => entry.name !== 'locales.ts')) {
      const literals = file.source.match(/[\u4e00-\u9fff]+/g) ?? []
      expect(literals, `CJK copy in ${file.name} (belongs in locales.ts)`).toEqual([])
    }
  })
})

describe('usage table stylesheet', () => {
  const css = readFileSync(new URL('../src/client/styles.ts', import.meta.url), 'utf8')

  it('right-aligns numeric headers with a selector that beats the th rule', () => {
    // Regression: a numeric <th> carries `.agy-num`, but `.agy-table th
    // { text-align: left }` is specificity 0-1-1 and outranks the bare class
    // (0-1-0), so headers stayed left-aligned above right-aligned cells — the
    // figure looked shoved to the right of its own label. The fix must be a
    // compound selector (0-2-1), not an `!important` escalation.
    expect(css).toContain('.agy-table th.agy-num { text-align: right; }')
    // Pin the trap itself, so the selector above cannot be "simplified" back to
    // the bare class without this test going red.
    expect(css).toMatch(/\.agy-table th\s*\{[^}]*text-align:\s*left/)
  })

  it('draws no vertical rules between metric cells', () => {
    // The usage summary's four cells are separated by the grid; a border-right
    // turned the strip into a spreadsheet grid and was removed.
    const metricRule = /\.agy-metric\s*\{([^}]*)\}/.exec(css)
    expect(metricRule).not.toBeNull()
    expect(metricRule?.[1]).not.toMatch(/border-(right|left)/)
  })

  it('keeps the CSS template body free of backticks', () => {
    // The stylesheet is one template literal, so a backtick inside a comment
    // ENDS it and the rest of the CSS is parsed as TypeScript ("Expected ';' but
    // found ...", reported at a line far from the real cause). Easy to
    // reintroduce when quoting a property name in prose, and it has happened
    // repeatedly. Only the body matters — the delimiters and the surrounding
    // TypeScript (other template literals in this file) legitimately contain
    // backticks, so counting the whole file would be meaningless.
    const start = css.indexOf('const CSS = `') + 'const CSS = `'.length
    const end = css.indexOf('`', start)
    expect(start, 'the CSS template literal must exist').toBeGreaterThan('const CSS = `'.length)
    expect(css.slice(start, end), 'no backtick may appear inside the CSS body').not.toContain('`')
  })

  it('sizes the master/detail split from the panel, not the viewport', () => {
    // Pins the constraint recorded on .agy-split in src/client/styles.ts: a
    // CONTAINER query (the former viewport @media never fired inside the
    // ~564px panel) whose breakpoint stays ABOVE the panel width — at the
    // panel the split stacks by measurement; re-measure before moving it.
    expect(css).toMatch(/\.agy-split-wrap\s*\{[^}]*container-type:\s*inline-size/)
    expect(css).toMatch(/@container\s*\(min-width:\s*700px\)/)
    expect(css).not.toMatch(/@media[^{]*\{\s*\.agy-split/)
  })

  it('lets an account row wrap instead of squeezing the identity', () => {
    // Regression: the row was a two-column grid, whose `1fr` may collapse to
    // zero — the ~167px action cluster left ~45px for the email, truncating
    // every address to "a1…". A flex basis wraps the actions to a second line.
    // The flex-wrap declaration is what matters; the comment above the rule
    // quotes the old grid declaration, so only actual declarations are checked.
    const rowRule = /\.agy-rowitem\s*\{([^}]*)\}/.exec(css)
    expect(rowRule).not.toBeNull()
    const declarations = (rowRule?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(declarations).toMatch(/flex-wrap:\s*wrap/)
    expect(declarations).not.toMatch(/grid-template-columns/)
  })
})

describe('model list ordering', () => {
  const m = (id: string, disabled: boolean) => ({ id, name: id, disabled })

  it('puts disabled models last, keeping host order within each group', () => {
    // The requested behaviour: switching a model off moves it to the bottom
    // rather than leaving it wherever the reload happened to place it.
    const ordered = orderModels([m('a', false), m('b', true), m('c', false), m('d', true)])
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('moves only the toggled row, never reshuffling the others', () => {
    // Stability is the point: with a non-stable sort the untouched rows could
    // reorder, which is what made the list appear to jump on every toggle.
    const before = orderModels([m('a', false), m('b', false), m('c', false)])
    expect(before.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])

    // Switching the FIRST model off must send it past the two it preceded,
    // without disturbing their relative order.
    const firstOff = orderModels([m('a', true), m('b', false), m('c', false)])
    expect(firstOff.map((entry) => entry.id)).toEqual(['b', 'c', 'a'])

    // Switching it back on restores the host's original order.
    const restored = orderModels([m('a', false), m('b', false), m('c', false)])
    expect(restored.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the input list', () => {
    const input = [m('a', false), m('b', true)]
    orderModels(input)
    expect(input.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('token count formatting', () => {
  it('starts a unit suffix at 1K and keeps full precision below it', () => {
    expect(tokenText(0)).toBe('0')
    expect(tokenText(512)).toBe('512')
    expect(tokenText(999)).toBe('999')
    expect(tokenText(1_000)).toBe('1.0K')
    expect(tokenText(1_500)).toBe('1.5K')
    expect(tokenText(284_000)).toBe('284K')
    expect(tokenText(1_200_000)).toBe('1.2M')
  })

  it('promotes the unit when rounding would reach 1000 of it', () => {
    // Regression: the unit came from the raw magnitude while the decimals came
    // from a different threshold, so rounding produced a number outside its own
    // unit — `1000K` instead of `1.0M`.
    expect(tokenText(999_999)).toBe('1.0M')
    expect(tokenText(999_999_999)).toBe('1.0B')
    expect(tokenText(999_999_999_999)).toBe('1.0T')
  })

  it('keeps decimals consistent across a unit boundary', () => {
    // Regression: 99999 was `100.0K` while 100000 was `100K`, and 9999999 was
    // `10.0M` while 10000000 was `10M` — the same magnitude, formatted two ways.
    expect(tokenText(99_999)).toBe('100K')
    expect(tokenText(100_000)).toBe('100K')
    expect(tokenText(9_999_999)).toBe('10.0M')
    expect(tokenText(10_000_000)).toBe('10.0M')
  })
})

describe('canActivateAccount', () => {
  // A lean builder: the action's visibility depends on exactly two fields, so
  // the other required ones are inert here.
  function view(state: AccountView['state'], active = false): AccountView {
    return {
      index: 0,
      email: 'acc@example.com',
      projectId: 'proj',
      active,
      state,
      disabledAt: null,
      cooldownUntil: null,
      cooldownReason: null,
      cooldownSetAt: null,
      verificationUrl: null,
      verificationRequired: false,
      rateLimits: null,
      fingerprint: null,
      fingerprintHistory: 0,
      proxy: null,
      usage: null,
      limits: null,
      limitsUpdatedAt: null,
      limitBurn: null,
    }
  }

  it('offers the action to every non-current account except a disabled one', () => {
    expect(canActivateAccount(view('active'))).toBe(true)
    expect(canActivateAccount(view('cooling'))).toBe(true)
    expect(canActivateAccount(view('verification-required'))).toBe(true)
    expect(canActivateAccount(view('disabled'))).toBe(false)
  })

  it('never offers it on the account that is already the pool preference', () => {
    expect(canActivateAccount(view('active', true))).toBe(false)
    // A disabled account cannot be the preference (`active` requires enabled),
    // so the two guards do not overlap — but if the store ever disagreed, the
    // safe answer is still "no button".
    expect(canActivateAccount(view('disabled', true))).toBe(false)
  })
})

describe('truncateIdentity', () => {
  it('leaves short values alone', () => {
    expect(truncateIdentity('gemini-3.8-flash')).toBe('gemini-3.8-flash')
  })

  it('cuts from the middle so both ends survive', () => {
    // The email keeps its domain; the model id keeps its tier suffix — the
    // two halves a reader actually distinguishes accounts and models by.
    expect(truncateIdentity('mahmoud01142458311@gmail.com')).toBe('mahmoud0114…@gmail.com')
    expect(truncateIdentity('gemini-3.8-flash-tiered')).toBe('gemini-3.8-…ash-tiered')
  })
})

describe('throughput calculation', () => {
  // The counters the calculation reads; everything else is inert.
  const totals = (over: Partial<UsageCounters>): UsageCounters =>
    ({ ...zeroCounters(), ...over })

  it('is null when nothing was timed, produced, or first-tokened', () => {
    // The detail row is absent for null, so a never-used account must not
    // render "≈ 0 token/s" — that would read as "measured, and dead". A scope
    // with wall time but NO first-token report cannot separate decode from
    // wait, so it is null too rather than a whole-request average.
    expect(throughputTokenPerSecond(zeroCounters())).toBeNull()
    expect(throughputTokenPerSecond(totals({ output: 100, latencyMs: 5_000, latencyN: 1 }))).toBeNull()
    // A first token at/after the wall clock (skew, or a degenerate sample).
    expect(throughputTokenPerSecond(totals({ output: 500, latencyMs: 1_000, latencyN: 1, ttftMs: 1_200, ttftN: 1 }))).toBeNull()
  })

  it('divides output by the window AFTER the first token, not the wall clock', () => {
    // 100 tokens over 2s of wall time, 1.5s of it waiting for the first token:
    // the streamed half-second carried 100 tokens → 200 tok/s. Dividing by the
    // wall clock instead reported ~8× low on a channel whose first-token wait
    // is ~90% of the request (the "40 vs ~300" report).
    expect(throughputTokenPerSecond(totals({ output: 100, latencyMs: 2_000, latencyN: 1, ttftMs: 1_500, ttftN: 1 }))).toBe(200)
  })

  it('averages per request when the two clocks cover different request counts', () => {
    // Failed requests carry wall time but no first token, so latencyN can
    // exceed ttftN. Raw sums would hand the failures' wait to the decode
    // window; the per-request averages keep the rate on streamed requests.
    expect(throughputTokenPerSecond(totals({
      output: 150, latencyMs: 3_000, latencyN: 2, ttftMs: 1_000, ttftN: 1,
    }))).toBe(150)
  })

  it('rounds to whole tokens per second', () => {
    expect(throughputTokenPerSecond(totals({ output: 10, latencyMs: 400, latencyN: 1, ttftMs: 100, ttftN: 1 }))).toBe(33)
  })
})

describe('resolveSelectedAccountIndex', () => {
  function view(index: number, active = false): AccountView {
    return {
      index,
      email: `acc${index}@example.com`,
      projectId: 'proj',
      active,
      state: active ? 'active' : 'cooling',
      disabledAt: null,
      cooldownUntil: null,
      cooldownReason: null,
      cooldownSetAt: null,
      verificationUrl: null,
      verificationRequired: false,
      rateLimits: null,
      fingerprint: null,
      fingerprintHistory: 0,
      proxy: null,
      usage: null,
      limits: null,
      limitsUpdatedAt: null,
      limitBurn: null,
    }
  }

  it('selects the active account (badge "current") by default when selected is null', () => {
    const accounts = [view(0, false), view(1, true), view(2, false)]
    expect(resolveSelectedAccountIndex(accounts, null)).toBe(1)
  })

  it('falls back to index 0 when no account is active and selected is null', () => {
    const accounts = [view(0, false), view(1, false)]
    expect(resolveSelectedAccountIndex(accounts, null)).toBe(0)
  })

  it('returns 0 for an empty accounts array', () => {
    expect(resolveSelectedAccountIndex([], null)).toBe(0)
    expect(resolveSelectedAccountIndex([], 2)).toBe(0)
  })

  it('preserves valid user-selected index', () => {
    const accounts = [view(0, false), view(1, true), view(2, false)]
    expect(resolveSelectedAccountIndex(accounts, 0)).toBe(0)
    expect(resolveSelectedAccountIndex(accounts, 2)).toBe(2)
  })

  it('safely recovers to active account or clamps when selected index is out of bounds', () => {
    const accountsWithActive = [view(0, false), view(1, true)]
    expect(resolveSelectedAccountIndex(accountsWithActive, 5)).toBe(1)
    expect(resolveSelectedAccountIndex(accountsWithActive, -1)).toBe(1)

    const accountsNoActive = [view(0, false), view(1, false)]
    expect(resolveSelectedAccountIndex(accountsNoActive, 5)).toBe(1)
    expect(resolveSelectedAccountIndex(accountsNoActive, -1)).toBe(0)
  })
})

describe('installAgyStyles', () => {
  type FakeStyle = { id: string, textContent: string, remove: () => void }
  // The fake's remove() must REALLY detach from headChildren: the defect this
  // pins is a disposer that calls `.remove()`, and a no-op stub once let that
  // exact implementation pass this suite.
  function installFakeDocument() {
    const headChildren: FakeStyle[] = []
    const fakeDocument = {
      head: { appendChild: (el: FakeStyle) => { headChildren.push(el) } },
      getElementById: (id: string) => headChildren.find((el) => el.id === id) ?? null,
      createElement: (): FakeStyle => {
        const el: FakeStyle = {
          id: '', textContent: '',
          remove: () => {
            const i = headChildren.indexOf(el)
            if (i >= 0) headChildren.splice(i, 1)
          },
        }
        return el
      },
    }
    const origDoc = globalThis.document
    // @ts-expect-error test stub
    globalThis.document = fakeDocument
    return { headChildren, restore: () => { globalThis.document = origDoc } }
  }

  it('retains the stylesheet across effect disposal', () => {
    const { headChildren, restore } = installFakeDocument()
    try {
      const dispose = installAgyStyles()
      expect(headChildren).toHaveLength(1)
      // The disposer is a deliberate no-op: Cordis re-evaluates effects
      // mid-session, and removal there stripped every .agy-* style.
      dispose()
      expect(headChildren).toHaveLength(1)
    } finally {
      restore()
    }
  })

  it('installs once and refreshes stale content on reinstall', () => {
    const { headChildren, restore } = installFakeDocument()
    try {
      installAgyStyles()
      installAgyStyles()
      expect(headChildren).toHaveLength(1)
      const installed = headChildren[0]!.textContent
      // Simulate a previous bundle's CSS surviving in the host document.
      headChildren[0]!.textContent = 'stale'
      installAgyStyles()
      expect(headChildren).toHaveLength(1)
      expect(headChildren[0]!.textContent).toBe(installed)
    } finally {
      restore()
    }
  })


})
