/**
 * dsh-agy web entry.
 *
 * Two things are registered, and they deliberately use different transports:
 *
 * 1. **Management RPC at `/api/agy`** (`connection.fetch.register`). The inline
 *    Settings UI calls methods over DSH's own RPC channel. This replaces the
 *    previous bare `ctx.webServer.register` route table, which had no
 *    authentication of its own: `/api/*` sits behind the host's browser-trust
 *    fence and BrowserAuth, so the management surface is no longer reachable by
 *    anything that can merely open a socket to a loopback port.
 *
 * 2. **The OAuth callback at `/agy/oauth-callback`** stays a real HTTP route.
 *    Google redirects a browser to it with a GET, which the management RPC
 *    channel (POST-only) cannot carry.
 *
 * BOTH `webServer` and `connection` are deliberately reached lazily rather than
 * statically injected. Each exists only in a Web composition, and a statically
 * injected service that never appears leaves this entry permanently pending —
 * and the loader treats a pending entry as a FAILED PROFILE, not a skipped one:
 *
 *   dsh: plugin tree failed to load: dsh: 1 entry did not activate
 *   dsh-agy/web: pending (waiting for service: webServer)
 *
 * Measured on a real TUI profile, where no provider of `webServer` is mounted.
 * `ctx.inject([...])` keeps this entry active and inert instead, so a TUI or
 * headless profile boots with no management surface rather than not booting.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
// Type-only: merges the `llm/adapters-updated` event into the Cordis Events map.
import type {} from '@deepseek-ai/dsh-llm/types'
import { createAgyRuntime } from '../plugin-common.ts'
import { isAgyDisabled } from '../runtime/risk.ts'
import { createAgyManagement } from './management.ts'
import { renderCallbackHtml } from './page.ts'

export const name = 'dsh-agy-web'

/** The one service every composition provides; the rest are resolved lazily. */
export const inject = ['llm']

/** The slice of the host's web-server service this entry uses. */
interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void
  }): () => void
  host?: string
  /** The port actually listened on: the OS-assigned one when `--port 0`. */
  readonly port?: number
}

/**
 * The loopback base URL the OAuth redirect and the callback page point at.
 *
 * The port is the one the server BOUND, not the one it was asked for.
 * `webStartup.port` is the `--port` flag verbatim, and `--port 0` — which asks
 * the OS for any free port — would send Google's redirect to
 * `http://127.0.0.1:0/agy/oauth-callback`, which nothing answers.
 * The requested port and DSH's own 3080 default only stand in while the
 * server has not reported one.
 * @param host - loopback host the URL names.
 * @param webServer - the host web server (source of the bound port).
 * @param requestedPort - `webStartup.port`, the `--port` flag if one was given.
 * @returns `http://<host>:<port>`, no trailing slash.
 */
export function webBaseUrl(host: string, webServer: Pick<WebServerLike, 'port'>, requestedPort?: number): string {
  return `http://${host}:${webServer.port || requestedPort || 3080}`
}

export function apply(ctx: Context): void {
  if (isAgyDisabled()) {
    ctx.logger.warn('[dsh-agy] disabled by DSH_AGY_DISABLE=1 — skipping web registration')
    return
  }
  // Lazily, like `connection` below: see the module docblock for why a static
  // `webServer` is a profile-breaking bug rather than a nicety.
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer') as WebServerLike | undefined
    if (!webServer) return
    webCtx.effect(() => registerAgyWeb(webCtx, webServer))
  })
}

/**
 * Register the OAuth callback route, and the management RPC once `connection`
 * appears.
 * @param ctx - the web-server-bearing context (owns both registrations).
 * @param webServer - the host web server.
 * @returns disposer for every registration this function made.
 */
async function registerAgyWeb(ctx: Context, webServer: WebServerLike): Promise<() => void> {
  // Host comes from the webStartup provider (CLI args), falling back to DSH's
  // own web-app default (loopback), never a user override. The port does not:
  // see `webBaseUrl`.
  const webStartup = ctx.get('webStartup') as { host?: string; port?: number } | undefined
  const host = webStartup?.host ?? '127.0.0.1'

  // The OAuth callback manages credentials with no authentication of its own,
  // so it must never be reachable from the network. When the web server binds
  // a non-loopback interface, refuse to register it (the loopback-only OAuth
  // redirect would be unusable there anyway).
  const bindHost = webServer.host ?? host
  if (!['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
    ctx.logger.warn(
      '[dsh-agy] web server bound to "' + bindHost + '" (non-loopback): not registering the agy routes ' +
      '(they manage account credentials and must stay loopback-only). Bind the web server to 127.0.0.1 to enable them.',
    )
    return () => {}
  }

  const { store, sessions, adapter, stats, recentStore, modelVisibility, thinkingBudget, multimodalConfig } = await createAgyRuntime(ctx)
  // Read per use rather than once here: the bound port is only known after the
  // server's listen callback has run.
  const baseUrl = (): string => webBaseUrl(host, webServer, webStartup?.port)
  const management = createAgyManagement({
    store,
    sessions,
    stats,
    // The persisted ring, not just this boot's in-memory one.
    recentRequests: () => recentStore.recentRequests(),
    modelVisibility,
    // Expose only the two operations the RPC needs, not the whole store.
    thinkingBudget: {
      all: () => thinkingBudget.all(),
      set: (level, value) => thinkingBudget.setBudget(level, value),
      claude: () => thinkingBudget.claudeBudget(),
      setClaude: (value) => thinkingBudget.setClaudeBudget(value).claudeBudget,
      tiered: () => thinkingBudget.tieredBudget(),
      setTiered: (value) => thinkingBudget.setTieredBudget(value).tieredBudget,
    },
    // Same shape as `thinkingBudget`: the two operations the RPC needs, not the
    // store. The setter returns the fresh snapshot so the card re-renders from
    // what was stored rather than from its own optimistic guess.
    multimodal: {
      get: () => multimodalConfig.snapshot(),
      set: (value) => multimodalConfig.setMaxInlineMb(value),
    },
    // The adapter's *unfiltered* catalog, so a hidden model still appears in
    // the settings list alongside the switch that un-hides it.
    listAllModels: () => adapter.listAllModels(),
    // Activating an account can switch the account model discovery rides; the
    // cache carries no account key, so the RPC drops it (see
    // `AgyAdapter.invalidateModelCache`).
    invalidateModelCache: () => adapter.invalidateModelCache(),
    baseUrl,
    // DSH refreshes the model picker on `llm/adapters-updated`; the hidden
    // list lives in agy's own file, so nothing else would announce the change
    // and the toggle would appear to do nothing until a page reload.
    // (`llm/adapters-updated` is declared `@mode emit` for exactly this kind
    // of registry notification.)
    notifyModelsChanged: () => { ctx.emit('llm/adapters-updated') },
  })
  const disposers: Array<() => void> = []

  // The one endpoint that cannot ride the RPC channel: Google sends the
  // browser here with a GET redirect.
  disposers.push(webServer.register({
    kind: 'exact',
    path: '/agy/oauth-callback',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const base = baseUrl()
      const url = new URL(req.url ?? '/', base)
      const result = await management.handleCallback(url.searchParams).catch((error: unknown) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(result.ok
        ? renderCallbackHtml({ ok: true, email: result.email ?? null, baseUrl: base })
        : renderCallbackHtml({ ok: false, error: result.error ?? 'Unknown error', baseUrl: base }))
    },
  }))

  // Lazy injection: see the module docblock for why this is not static.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as
      | {
        fetch: {
          register(route: {
            path: string
            methods: string[]
            requestBody: 'buffered' | 'streaming'
            fetch: (request: Request) => Promise<Response>
          }): () => void
        }
      }
      | undefined
    if (!connection || typeof connection.fetch?.register !== 'function') {
      connectionCtx.logger.warn('[dsh-agy] connection.fetch unavailable — management RPC not registered')
      return
    }
    connectionCtx.effect(() => connection.fetch.register({
      path: '/api/agy',
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let message: Record<string, unknown>
        try {
          message = await request.json() as Record<string, unknown>
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = message.payload as { method?: unknown; payload?: unknown } | undefined
        if (
          message.type !== 'client-request'
          || typeof message.rpcId !== 'string'
          || typeof call?.method !== 'string'
        ) {
          return reply(rpcId, {
            ok: false,
            error: { code: 'agy/bad-request', message: 'Invalid agy management request.' },
          })
        }
        try {
          const value = await management.call(call.method, call.payload)
          return reply(rpcId, { ok: true, value })
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          connectionCtx.logger.warn(`[dsh-agy] ${call.method} failed: ${text}`)
          // A structured failure, not a bare 500: the client's unwrap needs a
          // parseable envelope or a failed call looks like "nothing happened".
          return reply(rpcId, { ok: false, error: { code: 'agy/handler-failed', message: text } })
        }
      },
    }), 'dsh-agy: /api/agy management RPC')
  })

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Wrap one result in the Connection RPC response envelope.
 *
 * A failure MUST carry `error.details` as an object: the client's envelope
 * parser rejects a failure without it as "invalid server-response", which hides
 * the real message behind a transport-sounding error.
 */
function reply(rpcId: string, result: unknown): Response {
  const normalized = isFailure(result)
    ? { ...result, error: { details: {}, ...result.error } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: normalized })
}

/** Whether one result is an RPC failure envelope. */
function isFailure(value: unknown): value is {
  ok: false
  error: { code?: string, message?: string, details?: unknown }
} {
  return typeof value === 'object' && value !== null
    && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: unknown }).error === 'object'
    && (value as { error?: unknown }).error !== null
}
