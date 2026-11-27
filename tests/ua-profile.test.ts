import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UA_PLATFORM,
  UaProfileStore,
  _setUaProfileStoreForTest,
  activeUserAgent,
  isBuiltinUaProfile,
  parseUaProfileDocument,
  renderUaTemplate,
  sanitizeCustomProfiles,
} from '../src/ua-profile.ts'
import {
  HUB_VERSION_FALLBACK,
  HUB_VERSION_FLOOR,
  UA_PROFILE_CLI,
  UA_PROFILE_HUB,
  isValidUaTemplate,
} from '../src/ua-profile-types.ts'
import {
  AGY_VERSION_FALLBACK,
  agyHubUserAgent,
  currentCliVersion,
  currentHubVersion,
  setResolvedCliVersion,
  setResolvedHubVersion,
} from '../src/oauth/constants.ts'

/** A store on a throwaway file, so each test owns its own persisted document. */
function store(): UaProfileStore {
  const dir = mkdtempSync(join(tmpdir(), 'agy-uap-'))
  return new UaProfileStore({ file: join(dir, 'agy-ua-profile.json'), revalidateIntervalMs: 0 })
}

describe('ua profile store', () => {
  it('defaults to the Electron desktop app, which is the product this client presents as', () => {
    expect(store().activeId()).toBe(UA_PROFILE_HUB)
    expect(store().activeKind()).toBe('hub')
  })

  it('renders the Electron string with the Electron LINE version, never a CLI one', () => {
    // The pair is the whole point: an Electron SHAPE carrying a `1.x` version is
    // served the retirement notice on generation AND loses the Gemini quota
    // group (measured 2026-11-09), so the two must not drift apart.
    const s = store()
    setResolvedHubVersion('2.30.0')
    try {
      const ua = s.userAgent()
      // The hub SHAPE (upstream's own, read from the installed app) carrying the
      // hub LINE's version — never a Chromium product string with a borrowed one.
      expect(ua).toBe('antigravity/hub/2.30.0 (aidev_client; os_type=macos; arch=arm64; cl=1003475615)')
      expect(s.activeVersionLine()).toBe('2.x')
      expect(s.activeVersion()).toBe('2.30.0')
    } finally {
      setResolvedHubVersion(undefined)
    }
  })

  it('renders the CLI shape when the CLI profile is active, from the CLI line', () => {
    const s = store()
    s.setActive(UA_PROFILE_CLI)
    expect(s.userAgent()).toMatch(/^antigravity\/cli\/\d+\.\d+\.\d+ \(aidev_client; os_type=macos; arch=arm64; auth_method=consumer\)$/)
    expect(s.activeVersionLine()).toBe('1.x')
  })

  it('persists the choice, so a restart does not silently revert the identity', () => {
    const s = store()
    s.setActive(UA_PROFILE_CLI)
    // A second instance on the SAME file is what a restart looks like.
    const reopened = new UaProfileStore({ file: s.path, revalidateIntervalMs: 0 })
    expect(reopened.activeId()).toBe(UA_PROFILE_CLI)
  })

  it('adds, edits and deletes a custom profile, and falls back when the active one is deleted', () => {
    const s = store()
    const created = s.setCustom({ id: 'future', label: 'Future', template: 'Next/{version} ({platform})' })
    expect(created.profiles.map((p) => p.id)).toContain('future')

    // Editing in place replaces rather than appends.
    s.setCustom({ id: 'future', label: 'Future 2', template: 'Other/{version}' })
    expect(s.snapshot().custom['future']?.template).toBe('Other/{version}')
    expect(s.profiles().filter((p) => p.id === 'future')).toHaveLength(1)

    s.setActive('future')
    expect(s.userAgent()).toBe(`Other/${currentHubVersion()}`)
    // Deleting the ACTIVE custom profile must not leave the client identity-less.
    expect(s.deleteCustom('future').active).toBe(UA_PROFILE_HUB)
  })

  it('refuses to redefine or delete a built-in, which would break the switch-back path', () => {
    const s = store()
    expect(() => s.setCustom({ id: UA_PROFILE_HUB, template: 'x/{version}' })).toThrow(/built-in/)
    expect(() => s.deleteCustom(UA_PROFILE_CLI)).toThrow(/built-in/)
  })

  it('rejects a template without the version placeholder', () => {
    // A frozen literal would stop tracking releases AND drift from
    // `clientMetadata.ideVersion` in the same request.
    const s = store()
    expect(() => s.setCustom({ id: 'frozen', template: 'NoVersionHere' })).toThrow(/version/)
    expect(() => s.setCustom({ id: 'frozen', template: 'a/{version}\nb' })).toThrow(/control characters/)
  })

  it('rejects an unknown active id', () => {
    expect(() => store().setActive('does-not-exist')).toThrow(/unknown UA profile/)
  })

  it('drops an unusable stored document rather than failing to load', () => {
    // A hand-edited file is a real scenario; a corrupt one must degrade to the
    // default identity, which is always valid, instead of bricking the client.
    expect(parseUaProfileDocument('not json').active).toBe(UA_PROFILE_HUB)
    expect(parseUaProfileDocument('{"active":"ghost"}').active).toBe(UA_PROFILE_HUB)
    const withBad = parseUaProfileDocument(JSON.stringify({
      active: 'bad id!',
      custom: { 'bad id!': { template: 'x/{version}' }, ok: { template: 'y/{version}' } },
    }))
    expect(withBad.active).toBe(UA_PROFILE_HUB)
    expect(Object.keys(withBad.custom)).toEqual(['ok'])
  })

  it('keeps a built-in id out of the custom map even when the file names one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-uap-'))
    const file = join(dir, 'agy-ua-profile.json')
    writeFileSync(file, JSON.stringify({
      version: 1,
      active: 'hub',
      custom: { hub: { label: 'hijack', template: 'evil/{version}' }, haiku: { template: 'h/{version}' } },
    }))
    const s = new UaProfileStore({ file, revalidateIntervalMs: 0 })
    expect(s.snapshot().custom).not.toHaveProperty('hub')
    expect(s.snapshot().custom).toHaveProperty('haiku')
    // The built-in still renders its own string.
    expect(s.userAgent()).toMatch(/^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; /)
  })

  it('reports the effective string and its version source, which can disagree', () => {
    const s = store()
    const live = s.view({ versionSource: 'live' })
    expect(live.effective).toBe(s.userAgent())
    expect(live.versionSource).toBe('live')
    // Every selectable profile is described with an EXAMPLE, so the shape is
    // visible before it is chosen.
    for (const profile of live.profiles) {
      expect(profile.example).not.toBe('')
      expect(profile.versionLine).not.toBe('')
    }
  })
})

describe('ua template vocabulary', () => {
  it('renders both placeholders', () => {
    expect(renderUaTemplate('a/{version} b/{platform}', '1.2.3')).toBe(`a/1.2.3 b/${DEFAULT_UA_PLATFORM}`)
  })

  it('validates a template by the version placeholder and control characters', () => {
    expect(isValidUaTemplate('x/{version}')).toBe(true)
    expect(isValidUaTemplate('x')).toBe(false)
    expect(isValidUaTemplate('')).toBe(false)
    expect(isValidUaTemplate('x/{version}\u0000')).toBe(false)
    expect(isValidUaTemplate(42)).toBe(false)
  })

  it('sanitizes a custom map: built-ins, bad ids and bad templates all dropped', () => {
    const out = sanitizeCustomProfiles({
      hub: { template: 'a/{version}' },
      'Bad Id': { template: 'a/{version}' },
      ok: { template: 'a/{version}', label: '  Ok  ' },
      noVersion: { template: 'a' },
      notAnObject: 5,
    })
    expect(Object.keys(out)).toEqual(['ok'])
    expect(out.ok?.label).toBe('Ok')
    expect(out.ok?.versionLine).toBe('custom')
  })

  it('names only the two built-ins as built-in', () => {
    expect(isBuiltinUaProfile(UA_PROFILE_HUB)).toBe(true)
    expect(isBuiltinUaProfile(UA_PROFILE_CLI)).toBe(true)
    expect(isBuiltinUaProfile('custom-one')).toBe(false)
  })

  it('keeps the CLI line in its OWN version slot', () => {
    // Regression: the CLI profile used to read the HUB slot, so selecting it
    // emitted `antigravity/cli/2.28.2` — a hub number inside a CLI shape, which
    // the data plane retires and which drops the Gemini quota group. The two
    // feeds publish into separate slots, and the CLI builder must read its own.
    setResolvedHubVersion('2.29.0')
    setResolvedCliVersion('1.5.3')
    try {
      expect(currentHubVersion()).toBe('2.29.0')
      expect(currentCliVersion()).toBe('1.5.3')
      const s = store()
      s.setActive(UA_PROFILE_HUB)
      expect(s.userAgent()).toContain('antigravity/hub/2.29.0')
      s.setActive(UA_PROFILE_CLI)
      expect(s.userAgent()).toContain('antigravity/cli/1.5.3')
      expect(s.userAgent()).not.toContain('2.29.0')
    } finally {
      setResolvedHubVersion(undefined)
      setResolvedCliVersion(undefined)
    }
  })

  it('never lets the CLI profile borrow the HUB floor', () => {
    // Regression, found end-to-end: with no CLI feed read yet, `currentCliVersion`
    // fell back to `AGY_VERSION_FALLBACK` (the HUB floor, 2.28.2), so selecting
    // the CLI profile emitted `antigravity/cli/2.28.2`. That is a hub number in a
    // CLI shape — retired on the data plane, and it drops the Gemini group.
    setResolvedHubVersion(undefined)
    setResolvedCliVersion(undefined)
    const s = store()
    s.setActive(UA_PROFILE_CLI)
    const ua = s.userAgent()
    expect(ua).toContain('antigravity/cli/1.')
    expect(ua).not.toContain('antigravity/cli/2.')
    expect(ua).not.toContain(HUB_VERSION_FALLBACK)
  })

  it('names the SAME release as AGY_VERSION_FALLBACK, which is the same product line', () => {
    // One product line, one floor. Two constants naming different releases of the
    // hub would let the profile advertise a version the freshness gate never
    // checks — and the gate is the only thing comparing either against the feed.
    expect(HUB_VERSION_FALLBACK).toBe(AGY_VERSION_FALLBACK)
  })

  it('brackets the Electron floor below the shipped fallback', () => {
    // The floor is the lowest measured-SERVED version; the fallback is the one
    // advertised before a feed read. A fallback under the floor would ship a
    // client that is retired on its first turn.
    const [fy, fm] = HUB_VERSION_FALLBACK.split('.').map(Number)
    const [ry, rm] = HUB_VERSION_FLOOR.split('.').map(Number)
    expect((ry ?? 0) * 1000 + (rm ?? 0)).toBeLessThan((fy ?? 0) * 1000 + (fm ?? 0))
  })
})

describe('process-wide profile', () => {
  it('drives activeUserAgent, which is what every probe reads', () => {
    const s = store()
    _setUaProfileStoreForTest(s)
    try {
      expect(activeUserAgent()).toBe(s.userAgent())
      s.setActive(UA_PROFILE_CLI)
      expect(activeUserAgent()).toBe(s.userAgent())
      expect(activeUserAgent()).toMatch(/^antigravity\/cli\//)
    } finally {
      _setUaProfileStoreForTest(undefined)
    }
  })

  it('maps the Go-style platform token onto the `os_type=` vocabulary', () => {
    // Two vocabularies for one fact, exactly as the CLI shape has them: the UA's
    // own token is Go-style (`darwin/arm64`), while `os_type=` carries the
    // operating system's name (`macos`). `darwin` is not the spelling measured
    // on this field, so it is mapped rather than passed through.
    expect(agyHubUserAgent('2.29.1', 'darwin/arm64'))
      .toBe('antigravity/hub/2.29.1 (aidev_client; os_type=macos; arch=arm64; cl=1003475615)')
    expect(agyHubUserAgent('2.29.1', 'windows/amd64'))
      .toBe('antigravity/hub/2.29.1 (aidev_client; os_type=windows; arch=amd64; cl=1003475615)')
  })
})
