/**
 * Manager lifecycle. These tests never touch a real core or a real subscription:
 * the binary resolver, the child process, and every HTTP call are injected, so
 * the properties pinned here are the manager's own (what it starts, what it
 * persists, when it rotates, what it refuses to leak) rather than mihomo's.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClashController } from '../src/clash/controller.ts'
import { ClashManager, type CoreProcessLike } from '../src/clash/manager.ts'

const PROFILE = `
proxies:
  - { name: hk-01, type: ss, server: 1.1.1.1, port: 443, cipher: aes-128-gcm, password: p }
  - { name: jp-01, type: ss, server: 2.2.2.2, port: 443, cipher: aes-128-gcm, password: p }
proxy-groups:
  - { name: 节点选择, type: select, proxies: [hk-01, jp-01] }
rules:
  - MATCH,节点选择
`

function fakeCore(): CoreProcessLike & { killed: boolean } {
  const listeners: Array<() => void> = []
  return {
    pid: 4242,
    killed: false,
    kill() { this.killed = true; for (const l of listeners) l() },
    once(_event: 'exit', listener: () => void) { listeners.push(listener) },
  }
}

interface Harness {
  manager: ClashManager
  core: ReturnType<typeof fakeCore>
  selected: string[]
  stateFile: string
  configFile: string
}

function harness(overrides: { enabled?: boolean, subscriptionUrl?: string, now?: () => number } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agy-clash-'))
  const stateFile = join(dir, 'agy-clash.json')
  const configFile = join(dir, 'config.yaml')
  const core = fakeCore()
  const selected: string[] = []
  const controller = new ClashController({
    port: 1,
    secret: 's',
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'PUT') {
        selected.push((JSON.parse(String(init.body)) as { name: string }).name)
        return new Response('{}')
      }
      if (url.endsWith('/version')) return new Response(JSON.stringify({ version: '1.19.34' }))
      if (url.includes('/proxies/') && !url.includes('/delay')) {
        return new Response(JSON.stringify({ now: selected.at(-1) ?? 'hk-01', all: ['hk-01', 'jp-01'] }))
      }
      return new Response(JSON.stringify({}))
    }) as typeof fetch,
  })
  const manager = new ClashManager({
    stateFile,
    configFile,
    resolveCore: async () => '/fake/mihomo',
    spawnCore: () => core,
    controllerFor: () => controller,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        selected.push(JSON.parse(String(init.body)).name as string)
        return new Response('{}')
      }
      return new Response(PROFILE)
    }) as typeof fetch,
    now: overrides.now ?? (() => Date.now()),
  })
  if (overrides.enabled !== undefined || overrides.subscriptionUrl !== undefined) {
    manager.configure({
      enabled: overrides.enabled ?? false,
      subscriptionUrl: overrides.subscriptionUrl ?? '',
    })
  }
  return { manager, core, selected, stateFile, configFile }
}

describe('ClashManager lifecycle', () => {
  it('does nothing while disabled — no spawn, no proxy url', async () => {
    const h = harness({ enabled: false })
    expect(await h.manager.ensure()).toBeUndefined()
    expect(h.core.killed).toBe(false)
  })

  it('fails closed: enabled but not started still yields the loopback url', () => {
    // Returning undefined here would send agy traffic direct over the host IP —
    // the leak this whole feature exists to prevent. A refused connection is the
    // acceptable failure; a silent direct request is not.
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/tok' })
    expect(h.manager.proxyUrlFor()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('starts the core and returns the loopback proxy url', async () => {
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/tok' })
    const url = await h.manager.ensure()
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const config = readFileSync(h.configFile, 'utf8')
    expect(config).toContain('allow-lan: false')
    expect(config).toContain('mixed-port:')
    expect(config).toContain('hk-01')
  })

  it('persists the state file owner-only', async () => {
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/tok' })
    await h.manager.ensure()
    if (process.platform !== 'win32') {
      expect(statSync(h.stateFile).mode & 0o777).toBe(0o600)
    }
    const state = JSON.parse(readFileSync(h.stateFile, 'utf8'))
    expect(state.enabled).toBe(true)
  })

  it('reports status without leaking the subscription url or the controller secret', async () => {
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/token-abc123' })
    await h.manager.ensure()
    const status = await h.manager.status()
    expect(JSON.stringify(status)).not.toContain('token-abc123')
    expect(JSON.stringify(status)).not.toContain('sub.example/token')
    expect(status.subscriptionHost).toBe('https://sub.example')
  })

  it('rotates to the next node and throttles a second rotation', async () => {
    let clock = 1_000_000
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/tok', now: () => clock })
    await h.manager.ensure()
    await h.manager.rotate()
    expect(h.selected.at(-1)).toBe('jp-01')
    clock += 1_000
    await h.manager.rotate()
    expect(h.selected).toHaveLength(1)
    clock += 10_000
    await h.manager.rotate()
    expect(h.selected.at(-1)).toBe('hk-01')
  })

  it('stops the child process and clears the running state when disabled', async () => {
    const h = harness({ enabled: true, subscriptionUrl: 'https://sub.example/tok' })
    await h.manager.ensure()
    h.manager.configure({ enabled: false })
    await h.manager.stop()
    expect(h.core.killed).toBe(true)
  })

  it('records a fetch failure as lastError and does not spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-clash-bad-'))
    const core = fakeCore()
    const manager = new ClashManager({
      stateFile: join(dir, 'state.json'),
      configFile: join(dir, 'config.yaml'),
      resolveCore: async () => '/fake/mihomo',
      spawnCore: () => core,
      controllerFor: () => new ClashController({ port: 1, secret: 's', fetchImpl: (async () => new Response('{}')) as typeof fetch }),
      fetchImpl: (async () => new Response('nope', { status: 500 })) as typeof fetch,
    })
    manager.configure({ enabled: true, subscriptionUrl: 'https://sub.example/x' })
    await expect(manager.ensure()).rejects.toThrow()
    expect((await manager.status()).lastError).toMatch(/subscription/i)
  })
})
