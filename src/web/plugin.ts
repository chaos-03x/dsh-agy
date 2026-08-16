/**
 * dsh-agy web entry: registers the /agy routes on ctx.webServer. Declared as a
 * separate plugin (inject: ['webServer']) because the web server activates
 * after the llm service (it waits on webStartup); a strict ctx.get in the main
 * plugin's apply would return undefined. In profiles without a web server this
 * entry simply stays pending.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createAgyRuntime } from '../plugin-common.ts'
import { isAgyDisabled } from '../runtime/risk.ts'
import { createAgyWebRoutes, type WebRoute } from './routes.ts'

export const name = 'dsh-agy-web'

export const inject = ['llm', 'webServer']

export function apply(ctx: Context): void {
  if (isAgyDisabled()) {
    ctx.logger.warn('[dsh-agy] disabled by DSH_AGY_DISABLE=1 — skipping /agy registration')
    return
  }
  ctx.effect(async () => {
    const webServer = ctx.get('webServer') as
      | { register(route: WebRoute): () => void; host?: string }
      | undefined
    if (!webServer) return () => {}

    // Host/port come from the webStartup provider (CLI args); the fallbacks are
    // DSH's own web-app defaults (loopback + 3080), never a user override.
    const webStartup = ctx.get('webStartup') as { host?: string; port?: number } | undefined
    const host = webStartup?.host ?? '127.0.0.1'
    const port = webStartup?.port ?? 3080

    // The /agy routes manage account credentials with no authentication of
    // their own; they must never be reachable from the network. When the web
    // server binds a non-loopback interface, refuse to register them at all
    // (the loopback-only OAuth redirect would be unusable there anyway).
    const bindHost = webServer.host ?? host
    if (!['127.0.0.1', 'localhost', '::1'].includes(bindHost)) {
      ctx.logger.warn(
        '[dsh-agy] web server bound to "' + bindHost + '" (non-loopback): not registering the /agy routes ' +
        '(they manage account credentials and must stay loopback-only). Bind the web server to 127.0.0.1 to enable them.',
      )
      return () => {}
    }

    const { store, sessions } = await createAgyRuntime(ctx)
    const baseUrl = `http://${host}:${port}`

    const disposers = createAgyWebRoutes({ store, sessions, baseUrl }).map((route) =>
      webServer.register(route),
    )
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}
