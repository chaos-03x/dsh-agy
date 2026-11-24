/**
 * Controller client: the only place that talks to the embedded core's REST API.
 * Pinned here because a wrong verb or a missing Authorization header is silent
 * (the core answers 401 and the panel simply shows nothing), and because every
 * call is loopback-only by construction.
 */

import { describe, it, expect, vi } from 'vitest'
import { ClashController } from '../src/clash/controller.ts'

function stubFetch(payload: unknown, status = 200): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, calls }
}

describe('ClashController', () => {
  it('authenticates every call with the bearer secret and stays on loopback', async () => {
    const { impl, calls } = stubFetch({ meta: true, version: '1.19.34' })
    const controller = new ClashController({ port: 47891, secret: 'tok', fetchImpl: impl })
    await controller.version()
    expect(calls[0]?.url).toBe('http://127.0.0.1:47891/version')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('reads a selector group as current node plus candidates', async () => {
    const { impl } = stubFetch({
      now: 'jp-01',
      all: ['hk-01', 'jp-01'],
      type: 'Selector',
    })
    const controller = new ClashController({ port: 1, secret: 's', fetchImpl: impl })
    expect(await controller.group('节点选择')).toEqual({ now: 'jp-01', all: ['hk-01', 'jp-01'] })
  })

  it('selects a node with PUT and a JSON body', async () => {
    const { impl, calls } = stubFetch({})
    const controller = new ClashController({ port: 1, secret: 's', fetchImpl: impl })
    await controller.select('节点选择', 'hk-01')
    expect(calls[0]?.url).toBe('http://127.0.0.1:1/proxies/%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9')
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'hk-01' }))
  })

  it('surfaces an unauthorized controller instead of pretending it is empty', async () => {
    const { impl } = stubFetch({ message: 'Unauthorized' }, 401)
    const controller = new ClashController({ port: 1, secret: 'wrong', fetchImpl: impl })
    await expect(controller.version()).rejects.toThrow(/401/)
  })
})
