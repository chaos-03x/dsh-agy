/**
 * Subscription -> runtime config. Pins the two properties the embedded core
 * depends on: it must never bind a LAN address or a system proxy, and the
 * generated rules must always end with a MATCH that reaches the selected group
 * (a profile with no catch-all otherwise sends agy traffic into a REJECT-less
 * dead end).
 */

import { describe, it, expect } from 'vitest'
import { buildRuntimeConfig, parseSubscription, pickGroup, selectableGroups } from '../src/clash/config.ts'

const PROFILE = `
proxies:
  - { name: hk-01, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: p }
  - { name: jp-01, type: ss, server: 2.2.2.2, port: 443, cipher: aes-128-gcm, password: p }
proxy-groups:
  - { name: 节点选择, type: select, proxies: [hk-01, jp-01] }
  - { name: 自动选择, type: url-test, proxies: [hk-01, jp-01] }
rules:
  - GEOIP,CN,DIRECT
`

describe('parseSubscription', () => {
  it('keeps proxies, groups and rules', () => {
    const profile = parseSubscription(PROFILE)
    expect(profile.proxies.map((p) => p.name)).toEqual(['hk-01', 'jp-01'])
    expect(profile.groups.map((g) => g.name)).toEqual(['节点选择', '自动选择'])
    expect(profile.rules).toEqual(['GEOIP,CN,DIRECT'])
  })

  it('rejects a provider-only profile instead of producing an empty core', () => {
    expect(() => parseSubscription('proxy-providers:\n  foo: { url: https://x }\n')).toThrow(/proxy-providers/)
  })

  it('rejects YAML with no proxies', () => {
    expect(() => parseSubscription('rules:\n  - MATCH,DIRECT\n')).toThrow(/no proxies/)
  })

  it('rejects non-YAML bodies', () => {
    expect(() => parseSubscription('{{{{')).toThrow(/valid YAML/)
  })
})

describe('selectableGroups', () => {
  it('only returns select groups, since url-test cannot be pinned per turn', () => {
    const groups = selectableGroups(parseSubscription(PROFILE))
    expect(groups.map((g) => g.name)).toEqual(['节点选择'])
    expect(groups[0]?.nodes).toEqual(['hk-01', 'jp-01'])
  })
})

describe('pickGroup', () => {
  it('honours an explicit choice that still exists', () => {
    const profile = parseSubscription(PROFILE)
    expect(pickGroup(profile, '节点选择')?.name).toBe('节点选择')
  })

  it('falls back to the conventional node-select group when the choice is gone', () => {
    const profile = parseSubscription(PROFILE)
    expect(pickGroup(profile, 'deleted-group')?.name).toBe('节点选择')
  })

  it('returns undefined when the profile has no selector at all', () => {
    const profile = parseSubscription('proxies: [{ name: a, type: ss, server: 1.1.1.1, port: 1, cipher: aes-128-gcm, password: p }]\n')
    expect(pickGroup(profile, '')).toBeUndefined()
  })
})

describe('buildRuntimeConfig', () => {
  const config = buildRuntimeConfig({
    profile: parseSubscription(PROFILE),
    mixedPort: 47890,
    controllerPort: 47891,
    controllerSecret: 's3cret',
  })

  it('listens on loopback only — this core must never become a LAN proxy', () => {
    expect(config['mixed-port']).toBe(47890)
    expect(config['allow-lan']).toBe(false)
    expect(config['bind-address']).toBe('127.0.0.1')
    expect(config['external-controller']).toBe('127.0.0.1:47891')
    expect(config.secret).toBe('s3cret')
  })

  it('stays out of TUN and system-proxy territory', () => {
    expect(config.tun).toBeUndefined()
    expect(config['redir-port']).toBeUndefined()
    expect(config['tproxy-port']).toBeUndefined()
  })

  it('never enables fake-ip, which would hand agy unroutable 198.18.x addresses', () => {
    expect((config.dns as Record<string, unknown>)['enhanced-mode']).toBe('normal')
  })

  it('appends a catch-all MATCH when the profile has none', () => {
    const rules = config.rules as string[]
    expect(rules[rules.length - 1]).toBe('MATCH,节点选择')
  })

  it('keeps a provider catch-all instead of appending a second one', () => {
    const withMatch = parseSubscription(PROFILE.replace('  - GEOIP,CN,DIRECT', '  - GEOIP,CN,DIRECT\n  - MATCH,DIRECT'))
    const built = buildRuntimeConfig({ profile: withMatch, mixedPort: 1, controllerPort: 2, controllerSecret: 'x' })
    const rules = built.rules as string[]
    expect(rules.filter((r) => r.toUpperCase().startsWith('MATCH,'))).toHaveLength(1)
  })
})
