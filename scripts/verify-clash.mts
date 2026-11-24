/**
 * Live end-to-end check for the embedded Clash egress.
 *
 * Two modes:
 *
 * - **Self-contained** (default): a fake upstream proxy is started on loopback
 *   and the generated profile points its node at it. The check then drives a
 *   REAL request through the core's mixed port and asserts the request actually
 *   came out of the fake upstream. That is the property that matters — "agy
 *   traffic rides the core" — and it is proven locally, with no provider.
 * - **Real subscription**: `DSH_AGY_CLASH_SUBSCRIPTION=https://…` (or
 *   `file:/path/to/profile.yaml`) uses that profile instead; the egress assertion
 *   is skipped because the node is the provider's, not ours.
 *
 * Network is only touched to download the core (once). Everything else is
 * loopback.
 */

import { createServer, request as httpRequest } from 'node:http'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClashController } from '../src/clash/controller.ts'
import { ClashManager } from '../src/clash/manager.ts'
import { resolveCoreBinary } from '../src/clash/core.ts'

const source = process.env.DSH_AGY_CLASH_SUBSCRIPTION ?? ''

const dir = join(tmpdir(), `agy-clash-verify-${Date.now()}`)
const stateFile = join(dir, 'agy-clash.json')
const configFile = join(dir, 'config.yaml')

const core = await resolveCoreBinary()
console.log(`core: ${core}`)

// ── Self-contained mode: a fake upstream that ANSWERS, so the assertion is about
// routing rather than about the internet being reachable.
let fakeUpstreamPort = 0
let fakeUpstreamSeen: string[] = []
let fakeUpstream: ReturnType<typeof createServer> | undefined
let subscriptionServer: ReturnType<typeof createServer> | undefined
let subscriptionUrl = source

if (source === '') {
  fakeUpstream = createServer((req, res) => {
    fakeUpstreamSeen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
  })
  // mihomo's HTTP outbound tunnels with CONNECT, so a plain request handler is
  // never reached: the upstream must complete the tunnel and answer inside it.
  fakeUpstream.on('connect', (req, socket) => {
    fakeUpstreamSeen.push(req.url ?? '')
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')
    })
  })
  await new Promise<void>((resolve) => { fakeUpstream!.listen(0, '127.0.0.1', resolve) })
  const upstreamAddress = fakeUpstream.address()
  if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('fake upstream has no port')
  fakeUpstreamPort = upstreamAddress.port

  const profile = [
    'proxies:',
    `  - { name: fake-a, type: http, server: 127.0.0.1, port: ${fakeUpstreamPort} }`,
    `  - { name: fake-b, type: http, server: 127.0.0.1, port: ${fakeUpstreamPort} }`,
    'proxy-groups:',
    '  - { name: 节点选择, type: select, proxies: [fake-a, fake-b] }',
    'rules:',
    '  - MATCH,节点选择',
    '',
  ].join('\n')
  subscriptionServer = createServer((_req, res) => { res.writeHead(200); res.end(profile) })
  await new Promise<void>((resolve) => { subscriptionServer!.listen(0, '127.0.0.1', resolve) })
  const subAddress = subscriptionServer.address()
  if (subAddress === null || typeof subAddress === 'string') throw new Error('subscription server has no port')
  subscriptionUrl = `http://127.0.0.1:${subAddress.port}/sub`
} else if (source.startsWith('file:')) {
  const body = readFileSync(source.slice('file:'.length))
  subscriptionServer = createServer((_req, res) => { res.writeHead(200); res.end(body) })
  await new Promise<void>((resolve) => { subscriptionServer!.listen(0, '127.0.0.1', resolve) })
  const subAddress = subscriptionServer.address()
  if (subAddress === null || typeof subAddress === 'string') throw new Error('subscription server has no port')
  subscriptionUrl = `http://127.0.0.1:${subAddress.port}/sub`
}

const manager = new ClashManager({ stateFile, configFile })
manager.configure({ enabled: true, subscriptionUrl, autoRotate: true })

/** One GET through the core's mixed port, body as text. */
function fetchThroughProxy(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target)
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: target,
      headers: { host: parsed.host },
      timeout: 25_000,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => { body += chunk })
      response.on('end', () => resolve(body.trim()))
    })
    request.on('timeout', () => { request.destroy(new Error(`proxy probe timed out: ${target}`)) })
    request.on('error', reject)
    request.end()
  })
}

try {
  await manager.ensure()
  const status = await manager.status()
  console.log(`port: ${status.mixedPort} group: ${status.group} node: ${status.node} nodes: ${status.nodes.length}`)
  if (!status.running) throw new Error('core is not running')
  if (status.nodes.length < 1) throw new Error('no nodes discovered')

  const controller = new ClashController({ port: manager.snapshot().controllerPort, secret: manager.snapshot().controllerSecret })
  console.log(`controller: ${(await controller.version()).version}`)

  // ── Egress: a real HTTP request through the core's mixed port must come out of
  // the node. This is the assertion the first version of this script lacked.
  if (source === '') {
    const egress = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: status.mixedPort,
        method: 'GET',
        path: 'http://agy-clash-egress.test/probe',
        headers: { host: 'agy-clash-egress.test' },
        timeout: 20_000,
      }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body }) })
      })
      request.on('timeout', () => { request.destroy(new Error('egress probe timed out')) })
      request.on('error', reject)
      request.end()
    })
    console.log(`egress: HTTP ${egress.status} body=${JSON.stringify(egress.body)} via-upstream=${JSON.stringify(fakeUpstreamSeen)}`)

    if (egress.status !== 200 || egress.body !== 'ok') {
      throw new Error(`egress did not leave through the node (HTTP ${egress.status})`)
    }
    if (!fakeUpstreamSeen.some((path) => path.includes('agy-clash-egress.test'))) {
      throw new Error('the fake upstream never saw the request — traffic did not ride the core')
    }
  }

  // ── Rotation: only meaningful with a real second node.
  if (status.nodes.length >= 2) {
    const before = (await controller.group(status.group)).now
    await new Promise((resolve) => setTimeout(resolve, 5_100))
    const rotated = await manager.rotate()
    const after = (await controller.group(status.group)).now
    console.log(`rotate: ${String(rotated)} ${before} -> ${after}`)
    if (!rotated || before === after) throw new Error('rotation did not move the node')
  }

  // ── Real subscription: prove agy can actually egress through it. Pick the
  // fastest node by the group's own delay test, then request a real target.
  if (source !== '') {
    const group = await controller.group(status.group)
    const delays = await controller.groupDelay(status.group, 'http://www.gstatic.com/generate_204', 5_000)
    const ranked = Object.entries(delays).filter(([, ms]) => ms > 0).sort((a, b) => a[1] - b[1])
    console.log(`delays: ${ranked.slice(0, 5).map(([name, ms]) => `${name}=${ms}ms`).join(', ') || '(none reachable)'}`)
    if (ranked.length === 0) throw new Error('no node in the subscription answered the delay test')
    await controller.select(status.group, ranked[0]![0])
    console.log(`selected: ${ranked[0]![0]}`)

    const probe = await new Promise<{ status: number }>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: status.mixedPort,
        method: 'GET',
        path: 'http://www.gstatic.com/generate_204',
        // The Host header must name the TARGET: Node would otherwise stamp the
        // proxy's own address here and gstatic answers 400.
        headers: { host: 'www.gstatic.com' },
        timeout: 25_000,
      }, (response) => {
        response.resume()
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
      })
      request.on('timeout', () => { request.destroy(new Error('egress probe timed out')) })
      request.on('error', reject)
      request.end()
    })
    console.log(`real egress: HTTP ${probe.status} via ${ranked[0]![0]}`)
    if (probe.status < 200 || probe.status >= 400) throw new Error(`subscription egress failed (HTTP ${probe.status})`)

    // Prove the traffic really left through the node rather than matching a
    // DIRECT rule: compare the exit IP seen through the core with the host's own.
    const ipViaCore = await fetchThroughProxy(status.mixedPort, 'http://api.ipify.org')
    const ipDirect = await (await fetch('http://api.ipify.org')).text()
    console.log(`exit ip: core=${ipViaCore} direct=${ipDirect}`)
    if (ipViaCore === '' || ipViaCore === ipDirect) {
      throw new Error(`exit ip did not change through the core (core=${ipViaCore} direct=${ipDirect})`)
    }
    void group
  }
  console.log('OK')
} finally {
  manager.stop()
  subscriptionServer?.close()
  fakeUpstream?.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows keeps the just-killed core's config file locked for a moment; the
    // directory is under the OS temp dir, so leaving it behind is harmless and a
    // cleanup failure must not fail the check.
  }
}

// Keep the unused-import check honest in the self-contained path.
void fakeUpstreamPort
