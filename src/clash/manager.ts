/**
 * Lifecycle of the embedded core: start it for agy, keep it out of everything
 * else, and rotate nodes when a transport failure says the current one is dead.
 *
 * Three constraints shape this class:
 *
 * 1. **agy-only egress.** The core listens on a loopback mixed port and nothing
 *    points at it except this plugin's own fetch path (`proxyUrlFor`). The host's
 *    dispatcher, the OS proxy settings and any installed Clash client are
 *    untouched, so enabling this cannot change what any other application does.
 * 2. **Failure rotates, the host retries.** AGENTS.md forbids silent retries in
 *    the adapter; DSH's own retry policy already re-sends `TRANSPORT`. So a
 *    transport failure only marks the node bad and switches the group — the next
 *    attempt (the host's) lands on a different node with no new retry loop here.
 * 3. **Nothing leaks.** The subscription URL and the controller secret never
 *    reach a log line, an error message, or `status()`.
 */

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { AUTO_GROUP, AUTO_PROBE_URL, buildRuntimeConfig, parseSubscription, pickGroup, serializeRuntimeConfig } from './config.ts'
import type { SubscriptionProfile } from './config.ts'
import { ClashController, subscriptionHostForDisplay } from './controller.ts'
import { resolveCoreBinary } from './core.ts'
import { ClashStore } from './store.ts'
import { proxiedFetch } from '../proxy.ts'
import { regionOfNode } from './region.ts'
import {
  CORE_READY_TIMEOUT_MS,
  DEFAULT_CONTROLLER_PORT,
  DEFAULT_MIXED_PORT,
  ROTATE_MIN_INTERVAL_MS,
  emptyClashState,
  type ClashProbe,
  type ClashProbeNode,
  type ClashState,
  type ClashStatus,
} from './types.ts'

/** The child-process surface this class needs (injected in tests). */
export interface CoreProcessLike {
  pid?: number
  kill(signal?: NodeJS.Signals): void
  once(event: 'exit', listener: () => void): void
}

export interface ClashManagerOptions {
  stateFile?: string
  configFile?: string
  fetchImpl?: typeof fetch
  controllerFor?: (port: number, secret: string) => ClashController
  spawnCore?: (bin: string, args: string[]) => CoreProcessLike
  resolveCore?: () => Promise<string>
  now?: () => number
  /** Override the persisted port (tests, or a caller that owns the numbering). */
  mixedPort?: number
  controllerPort?: number
}

/** Fields the settings panel may change. */
export interface ClashConfigPatch {
  enabled?: boolean
  subscriptionUrl?: string
  autoRotate?: boolean
  group?: string
  node?: string
}

export class ClashManager {
  private readonly store: ClashStore
  private readonly configFile: string
  private readonly fetchImpl: typeof fetch
  private readonly controllerFor: (port: number, secret: string) => ClashController
  private readonly spawnCore: (bin: string, args: string[]) => CoreProcessLike
  private readonly resolveCore: () => Promise<string>
  private readonly now: () => number

  private state: ClashState
  private child: CoreProcessLike | undefined
  private profile: SubscriptionProfile | undefined
  private lastRotateAt = 0
  private startPromise: Promise<void> | undefined

  constructor(options: ClashManagerOptions = {}) {
    this.store = new ClashStore(options.stateFile)
    this.configFile = options.configFile ?? `${this.store.path.replace(/\.json$/, '')}-config.yaml`
    this.fetchImpl = options.fetchImpl ?? proxiedFetch
    this.controllerFor = options.controllerFor
      ?? ((port, secret) => new ClashController({ port, secret }))
    this.spawnCore = options.spawnCore ?? ((bin, args) => spawn(bin, args, { stdio: 'ignore', windowsHide: true }))
    this.resolveCore = options.resolveCore ?? (() => resolveCoreBinary())
    this.now = options.now ?? (() => Date.now())
    this.state = this.store.load()
    if (options.mixedPort !== undefined) this.state.mixedPort = options.mixedPort
    if (options.controllerPort !== undefined) this.state.controllerPort = options.controllerPort
  }

  /** Merge settings and persist immediately (the panel saves per action). */
  configure(patch: ClashConfigPatch): ClashState {
    this.state = { ...this.state, ...patch }
    this.store.save(this.state)
    return this.state
  }

  /**
   * The loopback proxy URL agy must use, or undefined when the feature is off.
   *
   * Enabled-but-not-yet-running still returns the URL on purpose: this is a
   * FAIL-CLOSED seam. Returning undefined while the core is still booting (or
   * after it crashed) would send agy traffic over the host's real IP — the exact
   * leak the feature exists to prevent. A refused connection is loud, honest,
   * and gets retried by the host; a silent direct request is neither.
   */
  proxyUrlFor(): string | undefined {
    if (!this.state.enabled) return undefined
    return `http://127.0.0.1:${this.state.mixedPort}`
  }

  /**
   * Start the core if it is enabled and not already up. Returns the proxy URL,
   * or undefined while disabled. Concurrent callers share one start.
   */
  async ensure(refresh = false): Promise<string | undefined> {
    if (!this.state.enabled) return undefined
    if (this.child !== undefined) return this.proxyUrlFor()
    if (this.startPromise === undefined) {
      this.startPromise = this.start(refresh).finally(() => { this.startPromise = undefined })
    }
    await this.startPromise
    return this.proxyUrlFor()
  }

  /** Start the core: reuse the cached profile (or fetch), write the config, spawn, wait ready. */
  async start(refresh = false): Promise<void> {
    if (this.child !== undefined) return
    try {
      await this.ensurePorts()
      const profile = await this.loadProfile(refresh)
      const config = buildRuntimeConfig({
        profile,
        mixedPort: this.state.mixedPort || DEFAULT_MIXED_PORT,
        controllerPort: this.state.controllerPort || DEFAULT_CONTROLLER_PORT,
        controllerSecret: this.state.controllerSecret,
      })
      mkdirSync(dirname(this.configFile), { recursive: true })
      // 0600: the generated config embeds the subscription's node credentials.
      writeFileSync(this.configFile, serializeRuntimeConfig(config), { mode: 0o600 })

      const bin = await this.resolveCore()
      const child = this.spawnCore(bin, ['-d', dirname(this.configFile), '-f', this.configFile])
      this.child = child
      child.once('exit', () => { this.child = undefined })

      await this.waitReady()
      await this.applyInitialNode(profile)
      this.state.lastError = ''
      this.store.save(this.state)
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error)
      this.store.save(this.state)
      this.stop()
      throw error
    }
  }

  /**
   * Stop and start again. `refresh` re-fetches the subscription.
   *
   * Boots do NOT refresh: a plugin that re-pulls a subscription every start is
   * an auto-updater nobody asked for (a stated non-goal). Only the user's
   * explicit save/restart passes `true`.
   */
  async restart(refresh = false): Promise<void> {
    this.stop()
    await this.ensure(refresh)
  }

  /** Kill the child and mark the feature not running (state.enabled is untouched). */
  stop(): void {
    const child = this.child
    this.child = undefined
    this.profile = undefined
    if (child !== undefined) {
      try {
        child.kill()
      } catch {
        // Already gone; nothing to do.
      }
    }
  }

  /**
   * Move agy's group to the next node. Returns false when there is nothing to
   * rotate to, when auto-rotation is off, or when the last rotation is too
   * recent (a flapping turn must not walk the whole list).
   */
  async rotate(): Promise<boolean> {
    if (!this.state.enabled || !this.state.autoRotate || this.child === undefined) return false
    const now = this.now()
    if (now - this.lastRotateAt < ROTATE_MIN_INTERVAL_MS) return false
    const group = this.state.group
    if (group === '') return false
    try {
      const controller = this.controller()
      const current = await controller.group(group)
      if (current.all.length < 2) return false
      // Measured node first: the selector usually rides the auto group, where
      // "the next in the list" has no meaning — list order is the provider's
      // packaging order, not quality. The auto group's own ranking is the only
      // evidence of which node currently answers, so prefer it and fall back to
      // list order only when the probe says nothing.
      const measured = await this.probe().catch(() => undefined)
      const ranked = (measured?.nodes ?? []).filter((node) => node.ms > 0).map((node) => node.name)
      // Geography before speed: Google scores an account's LOCATION (current IP
      // plus its login history), so hopping countries on consecutive failures is
      // the migration pattern the community reports before a soft block. Stay in
      // the current node's region while it has a live alternative; only cross a
      // border when it does not.
      const region = regionOfNode(current.now)
      const sameRegion = region === undefined
        ? undefined
        : ranked.find((name) => name !== current.now && regionOfNode(name) === region)
      const next = sameRegion
        ?? ranked.find((name) => name !== current.now)
        ?? (() => {
          const index = current.all.indexOf(current.now)
          return current.all[(index + 1 + current.all.length) % current.all.length]
        })()
      if (next === undefined || next === current.now) return false
      await controller.select(group, next)
      this.state.node = next
      this.lastRotateAt = now
      this.store.save(this.state)
      return true
    } catch (error) {
      // A rotation is best-effort: the caller is already handling a failed
      // request, so a controller error must not replace that failure with this
      // one. Recorded for the panel instead.
      this.state.lastError = error instanceof Error ? error.message : String(error)
      this.store.save(this.state)
      return false
    }
  }

  /**
   * Probe every node in the auto group against the agy endpoint, on demand.
   *
   * On demand rather than on a timer: mihomo already re-tests the group on its
   * own interval, so a plugin-side poll would be a second source of truth. This
   * exists for the panel (and for `rotate`) to read the CURRENT ranking.
   */
  async probe(): Promise<ClashProbe> {
    const delays = await this.controller().groupDelay(AUTO_GROUP, AUTO_PROBE_URL, 5_000)
    const nodes: ClashProbeNode[] = Object.entries(delays)
      .map(([name, ms]) => ({ name, ms: typeof ms === 'number' ? ms : 0 }))
      .sort((a, b) => {
        // Unreachable nodes rank last rather than first.
        if (a.ms === 0 && b.ms !== 0) return 1
        if (b.ms === 0 && a.ms !== 0) return -1
        return a.ms - b.ms
      })
    const available = nodes.filter((node) => node.ms > 0).length
    return {
      total: nodes.length,
      available,
      best: available > 0 ? nodes[0]! : null,
      nodes,
    }
  }

  /** Pin agy's group to one node (the panel's manual switch). */
  async select(node: string): Promise<void> {
    if (this.state.group === '') throw new Error('no node group selected yet — start the proxy first')
    await this.controller().select(this.state.group, node)
    this.state.node = node
    this.store.save(this.state)
  }

  /** Status for the settings panel. Contains no credential material. */
  async status(): Promise<ClashStatus> {
    let nodes: string[] = []
    let node = this.state.node
    if (this.child !== undefined && this.state.group !== '') {
      try {
        const group = await this.controller().group(this.state.group)
        nodes = group.all
        node = group.now || node
      } catch {
        // A dead controller is reported through `running: false` below.
      }
    }
    return {
      enabled: this.state.enabled,
      running: this.child !== undefined,
      mixedPort: this.state.mixedPort,
      subscriptionHost: subscriptionHostForDisplay(this.state.subscriptionUrl),
      group: this.state.group,
      node,
      autoRotate: this.state.autoRotate,
      nodes,
      fetchedAt: this.state.fetchedAt,
      lastError: this.state.lastError,
    }
  }

  /** Full state for internal callers (the CLI is a non-goal, so this stays internal). */
  snapshot(): ClashState {
    return { ...this.state }
  }

  // ── internals ──

  private controller(): ClashController {
    return this.controllerFor(this.state.controllerPort, this.state.controllerSecret)
  }

  /**
   * Claim two free loopback ports, reusing the persisted pair when possible.
   *
   * A fixed port is a collision, not a constant: the desktop and the web server
   * each build a runtime, so the second core would fail to bind while the
   * readiness probe talked to the FIRST core's controller — a green start over
   * somebody else's node list.
   */
  private async ensurePorts(): Promise<void> {
    const mixed = await pickFreePort(this.state.mixedPort)
    const controller = await pickFreePort(this.state.controllerPort, mixed)
    if (mixed === this.state.mixedPort && controller === this.state.controllerPort) return
    this.state.mixedPort = mixed
    this.state.controllerPort = controller
    this.store.save(this.state)
  }

  private async loadProfile(refresh = false): Promise<SubscriptionProfile> {
    // Cache first: see `restart` for why a boot must not re-pull the subscription.
    if (!refresh) {
      const cached = this.readCachedProfile()
      if (cached !== undefined) {
        this.state.fetchedAt = this.state.fetchedAt || new Date(this.now()).toISOString()
        return cached
      }
    }
    const url = this.state.subscriptionUrl
    if (url === '') throw new Error('no subscription configured — paste a Clash subscription URL in Settings → 代理')
    const response = await this.fetchImpl(url, {
      headers: { 'user-agent': 'clash.meta' },
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) throw new Error(`subscription fetch failed: HTTP ${response.status}`)
    const body = await response.text()
    let profile: SubscriptionProfile
    try {
      profile = parseSubscription(body)
    } catch (error) {
      throw new Error(`subscription could not be used: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.profile = profile
    this.state.fetchedAt = new Date(this.now()).toISOString()
    try {
      // Cached next to the generated config, 0600 like it: the profile carries
      // the same node credentials, and this is what makes a restart (and every
      // later boot) work offline.
      writeFileSync(this.profileCacheFile(), body, { mode: 0o600 })
    } catch {
      // A cache that cannot be written only costs a re-fetch next start.
    }
    return profile
  }

  /** Where the last fetched profile body is kept. */
  private profileCacheFile(): string {
    return this.configFile.replace(/\.ya?ml$/i, '') + '-profile.yaml'
  }

  private readCachedProfile(): SubscriptionProfile | undefined {
    try {
      return parseSubscription(readFileSync(this.profileCacheFile(), 'utf8'))
    } catch {
      return undefined
    }
  }

  private async waitReady(): Promise<void> {
    const deadline = this.now() + CORE_READY_TIMEOUT_MS
    let lastError: unknown
    while (this.now() < deadline) {
      if (this.child === undefined) throw new Error('core exited before it became ready')
      try {
        await this.controller().version()
        return
      } catch (error) {
        lastError = error
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    throw new Error(`core did not become ready within ${CORE_READY_TIMEOUT_MS}ms${lastError instanceof Error ? ` (${lastError.message})` : ''}`)
  }

  private async applyInitialNode(profile: SubscriptionProfile): Promise<void> {
    const group = pickGroup(profile, this.state.group)
    if (group === undefined) return
    this.state.group = group.name
    const controller = this.controller()
    const live = await controller.group(group.name).catch(() => ({ now: '', all: group.nodes }))
    const wanted = this.state.node !== '' && live.all.includes(this.state.node) ? this.state.node : (live.all[0] ?? '')
    if (wanted !== '') {
      if (live.now !== wanted) await controller.select(group.name, wanted)
      this.state.node = wanted
    }
  }
}

/** Convenience for tests and for a cold `status()` before any core exists. */
export function initialClashState(): ClashState {
  return emptyClashState()
}

/**
 * A free loopback port: `desired` when it still binds, otherwise an OS-assigned
 * one. `avoid` keeps the two ports from colliding with each other.
 */
export async function pickFreePort(desired: number, avoid?: number): Promise<number> {
  const attempt = (port: number): Promise<number | undefined> => new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => { resolve(undefined) })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address()
      const chosen = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => { resolve(chosen) })
    })
  })
  if (desired !== avoid) {
    const ok = await attempt(desired)
    if (ok !== undefined) return ok
  }
  for (let tries = 0; tries < 5; tries += 1) {
    const free = await attempt(0)
    if (free !== undefined && free !== avoid) return free
  }
  throw new Error('no free loopback port available for the proxy core')
}
