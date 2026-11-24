/**
 * Region parsing for node labels. Google scores an account's location rather
 * than a single request's, so a rotation that crosses borders on every failure
 * looks like travel nobody booked.
 */

import { describe, it, expect } from 'vitest'
import { regionOfNode } from '../src/clash/region.ts'

describe('regionOfNode', () => {
  it('reads flag emoji labels', () => {
    expect(regionOfNode('🇭🇰香港-A(通用)')).toBe('HK')
    expect(regionOfNode('🇯🇵日本-B')).toBe('JP')
    expect(regionOfNode('🇺🇸西美-E(通用)')).toBe('US')
  })

  it('reads Chinese and English names without a flag', () => {
    expect(regionOfNode('新加坡-A(流量)')).toBe('SG')
    expect(regionOfNode('狮城-E(通用)')).toBe('SG')
    expect(regionOfNode('Hong Kong 01')).toBe('HK')
    expect(regionOfNode('Tokyo-Relay')).toBe('JP')
  })

  it('returns undefined when the label says nothing useful', () => {
    expect(regionOfNode('♻️ 自动选择')).toBeUndefined()
    expect(regionOfNode('node-01')).toBeUndefined()
    expect(regionOfNode('')).toBeUndefined()
  })

  it('does not confuse a relay token with a country code', () => {
    // "hk" must not match inside "thick" / "shark"; the boundaries are words.
    expect(regionOfNode('shark-relay')).toBeUndefined()
    expect(regionOfNode('thick-01')).toBeUndefined()
  })
})
