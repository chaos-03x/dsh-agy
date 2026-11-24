/**
 * Egress classification: WHOSE proxy failed.
 *
 * AGENTS.md's fail-closed rule (skip the account, do not cool it) exists because a
 * per-account proxy that cannot be reached says nothing about that account. The
 * embedded Clash core is the opposite case: it is shared infrastructure this
 * plugin owns, so a refused connection to it is an ordinary network error — the
 * account is fine and cooling it would wrongly bench healthy credentials while
 * the core restarts.
 */

import { describe, it, expect } from 'vitest'
import { classifyFetchError } from '../src/runtime/classify.ts'

function refused(): Error {
  return Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:47890'), { code: 'ECONNREFUSED' })
}

describe('classifyFetchError egress source', () => {
  it('treats an unreachable per-account proxy as a proxy verdict', () => {
    const result = classifyFetchError(refused(), { proxyUrl: 'http://127.0.0.1:7890' })
    expect(result.kind).toBe('proxy-unreachable')
  })

  it('treats an unreachable EMBEDDED CORE as an ordinary network error', () => {
    // Same connection failure, different owner: the account must stay healthy.
    const result = classifyFetchError(refused(), { proxyUrl: 'http://127.0.0.1:47890', egress: 'core' })
    expect(result.kind).toBe('network-error')
  })

  it('keeps the no-proxy case a network error unchanged', () => {
    expect(classifyFetchError(refused()).kind).toBe('network-error')
  })
})
