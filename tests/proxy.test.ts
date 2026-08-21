import { describe, it, expect, vi, afterEach } from 'vitest'
import { EnvHttpProxyAgent } from 'undici'
import { normalizeProxyUrl, proxiedFetch, proxyAgent } from '../src/proxy.ts'

describe('proxy env support', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds an EnvHttpProxyAgent that reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY', () => {
    expect(proxyAgent).toBeInstanceOf(EnvHttpProxyAgent)
  })

  it('normalizes schemeless proxy values that undici would reject', () => {
    expect(normalizeProxyUrl('127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('localhost:7890')).toBe('http://localhost:7890')
    expect(normalizeProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890')
    expect(normalizeProxyUrl('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080')
    expect(normalizeProxyUrl(undefined)).toBeUndefined()
    expect(normalizeProxyUrl('')).toBeUndefined()
  })

  it('forwards the proxy dispatcher to the underlying fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)

    await proxiedFetch('https://example.com', { method: 'POST' })

    expect(fetchMock).toHaveBeenCalledWith('https://example.com', {
      method: 'POST',
      dispatcher: proxyAgent,
    })
  })

  it('keeps the caller signal and other init options intact', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await proxiedFetch('https://example.com', { signal: controller.signal })

    expect(fetchMock).toHaveBeenCalledWith('https://example.com', {
      signal: controller.signal,
      dispatcher: proxyAgent,
    })
  })
})