/**
 * REST client for the embedded core's external controller.
 *
 * Deliberately narrow: the panel needs the node list, the current selection, and
 * the ability to switch. Everything the core exposes beyond that (rules, config
 * reload, connections) is either a host-wide side effect or a second way to do
 * something this module already does, so it is not wrapped here.
 *
 * Every call is loopback-only by construction: the URL is built from a port, not
 * from a user-supplied host, so a mis-configured state file cannot make this
 * plugin drive a remote controller.
 */

import { redactCredentials } from '../redact.ts'

/** One selector group as the core reports it. */
export interface ControllerGroup {
  now: string
  all: string[]
}

export interface ClashControllerOptions {
  port: number
  secret: string
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Per-call ceiling, so a wedged core cannot hold a settings RPC forever. */
  timeoutMs?: number
}

export class ClashController {
  private readonly base: string
  private readonly secret: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: ClashControllerOptions) {
    this.base = `http://127.0.0.1:${options.port}`
    this.secret = options.secret
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 5_000
  }

  private async call(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.secret}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      // 401 is the interesting one: it means the state file's secret and the
      // running core disagree (a hand-edited file, or a stale process). Saying
      // so beats reporting an empty node list.
      throw new Error(`clash controller ${init.method ?? 'GET'} ${path} failed: HTTP ${response.status}`)
    }
    const text = await response.text()
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`clash controller ${path} returned non-JSON`)
    }
  }

  /** Liveness probe; also the readiness gate after spawn. */
  async version(): Promise<{ version: string }> {
    const raw = (await this.call('/version')) as { version?: unknown }
    return { version: typeof raw.version === 'string' ? raw.version : '' }
  }

  /** Current selection plus candidates for one selector group. */
  async group(name: string): Promise<ControllerGroup> {
    const raw = (await this.call(`/proxies/${encodeURIComponent(name)}`)) as { now?: unknown; all?: unknown }
    return {
      now: typeof raw.now === 'string' ? raw.now : '',
      all: Array.isArray(raw.all) ? raw.all.filter((n): n is string => typeof n === 'string') : [],
    }
  }

  /** Every node name the core knows (for the picker's "all nodes" view). */
  async proxies(): Promise<string[]> {
    const raw = (await this.call('/proxies')) as { proxies?: Record<string, unknown> }
    return Object.keys(raw.proxies ?? {})
  }

  /** Pin a group to one node. */
  async select(group: string, node: string): Promise<void> {
    await this.call(`/proxies/${encodeURIComponent(group)}`, {
      method: 'PUT',
      body: JSON.stringify({ name: node }),
    })
  }

  /**
   * Delay-test every node in a group at once (`GET /group/{name}/delay`).
   *
   * Used by `verify:clash` against a real subscription: picking the first node
   * blindly makes a dead node look like a broken egress, which is exactly the
   * confusion a "does my subscription work" question must not produce.
   */
  async groupDelay(group: string, url: string, timeoutMs: number): Promise<Record<string, number>> {
    const query = `?url=${encodeURIComponent(url)}&timeout=${timeoutMs}`
    const raw = (await this.call(`/group/${encodeURIComponent(group)}/delay${query}`, {
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    })) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [name, value] of Object.entries(raw ?? {})) {
      if (typeof value === 'number') out[name] = value
    }
    return out
  }
}

/** Redacted form of a subscription URL for the status surface. */
export function subscriptionHostForDisplay(url: string): string {
  if (url === '') return ''
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    // An unparseable value is exactly the case that may still carry a token, so
    // it is redacted rather than echoed.
    return redactCredentials(url)
  }
}
