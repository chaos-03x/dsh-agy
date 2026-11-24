/**
 * Live check for the embedded Clash core (network + real subscription needed,
 * so this is a `scripts/` tool and NOT part of the test suite).
 *
 * What it proves end to end, on the machine it runs on:
 *   1. the core binary resolves (downloads on first run),
 *   2. a subscription is fetched and turned into a runnable config,
 *   3. the core starts, answers its controller, and exposes the node group,
 *   4. a node can be selected, and rotating moves to a different one.
 *
 * Usage:
 *   DSH_AGY_CLASH_SUBSCRIPTION='https://…' pnpm run verify:clash
 *   DSH_AGY_CLASH_CORE='/path/to/mihomo' … (skip the download)
 */

import { rmSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { ClashController } from '../src/clash/controller.ts'
import { ClashManager } from '../src/clash/manager.ts'
import { resolveCoreBinary } from '../src/clash/core.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const source = process.env.DSH_AGY_CLASH_SUBSCRIPTION ?? ''
if (source === '') {
  console.error('set DSH_AGY_CLASH_SUBSCRIPTION to a Clash YAML subscription URL (or file:/path/to/profile.yaml)')
  process.exit(2)
}

// `file:` lets this run without a live provider: the same bytes are served over
// loopback, so the code path under test is identical to a real subscription.
let subscriptionUrl = source
let server: ReturnType<typeof createServer> | undefined
if (source.startsWith('file:')) {
  const body = readFileSync(source.slice('file:'.length))
  server = createServer((_req, res) => { res.writeHead(200); res.end(body) })
  await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('local subscription server has no port')
  subscriptionUrl = `http://127.0.0.1:${address.port}/sub`
}

const dir = join(tmpdir(), `agy-clash-verify-${Date.now()}`)
const stateFile = join(dir, 'agy-clash.json')
const configFile = join(dir, 'config.yaml')

const core = await resolveCoreBinary()
console.log(`core: ${core}`)

const manager = new ClashManager({ stateFile, configFile })
manager.configure({ enabled: true, subscriptionUrl, autoRotate: true })

try {
  await manager.ensure()
  const status = await manager.status()
  console.log(`port: ${status.mixedPort} group: ${status.group} node: ${status.node} nodes: ${status.nodes.length}`)
  if (!status.running) throw new Error('core is not running')
  if (status.nodes.length < 1) throw new Error('no nodes discovered')

  const controller = new ClashController({ port: status.mixedPort === 0 ? 0 : (manager.snapshot().controllerPort), secret: manager.snapshot().controllerSecret })
  const version = await controller.version()
  console.log(`controller: ${version.version}`)

  if (status.nodes.length >= 2) {
    const before = (await controller.group(status.group)).now
    // Bypass the throttle on purpose: this is the manual rotation check.
    const rotated = await (async () => {
      await new Promise((resolve) => setTimeout(resolve, 5_100))
      return manager.rotate()
    })()
    const after = (await controller.group(status.group)).now
    console.log(`rotate: ${String(rotated)} ${before} -> ${after}`)
    if (!rotated || before === after) throw new Error('rotation did not move the node')
  }
  console.log('OK')
} finally {
  manager.stop()
  server?.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows keeps the just-killed core's config file locked for a moment; the
    // directory is under the OS temp dir, so leaving it behind is harmless and a
    // cleanup failure must not fail the check.
  }
}
