import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { _resetAgyRuntimeForTest, createAgyRuntime } from '../src/plugin-common.ts'
import { renderCallbackHtml } from '../src/web/page.ts'
import { I18N_DICT } from '../src/web/i18n.ts'

/**
 * The dashboard page is gone: the account/statistics UI is now the Settings
 * section in `src/client/`, rendered over the `/api/agy` RPC. Only the OAuth
 * callback is still served as a page, because Google redirects a browser to it.
 */
describe('agy runtime sharing', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.DSH_HOME
    _resetAgyRuntimeForTest()
  })

  it('hands both entry points the SAME instances in one process', async () => {
    // Two runtimes in one process were the defect behind an empty "recent"
    // list and a blind live line: the ledger FILE merges across instances so
    // counters looked fine, while the in-memory ring and in-flight map each
    // saw only their own entry's records. It also meant account.activate
    // cleared pins on the wrong session manager.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'agy-runtime-'))
    _resetAgyRuntimeForTest()
    const main = await createAgyRuntime({ get: () => undefined, logger: { warn() {} } } as never)
    const web = await createAgyRuntime({ get: () => undefined, logger: { warn() {} } } as never)
    expect(web.stats).toBe(main.stats)
    expect(web.sessions).toBe(main.sessions)
    expect(web.adapter).toBe(main.adapter)
    expect(web.store).toBe(main.store)
  })
})

describe('dsh-agy web page rendering', () => {
  it('renders the callback page for success and failure states', () => {
    const successHtml = renderCallbackHtml({ ok: true, email: 'test@example.com', baseUrl: 'http://127.0.0.1:3080' })
    expect(successHtml).toContain('Sign-in Successful')
    expect(successHtml).toContain('test@example.com')
    expect(successHtml).toContain('window.close()')
    // The callback announces success to its opener, which is how the Settings
    // section learns to refresh without polling. The target origin is this
    // page's own origin, never '*': a wildcard delivered the success message to
    // whatever window happened to open the callback.
    expect(successHtml).toContain("postMessage({ type: 'agy_login_success' }, window.location.origin)")
    expect(successHtml).not.toContain("'*')")

    const failedHtml = renderCallbackHtml({ ok: false, error: 'Access denied', baseUrl: 'http://127.0.0.1:3080' })
    expect(failedHtml).toContain('Sign-in Failed')
    expect(failedHtml).toContain('Access denied')
    // The `/agy` dashboard route is gone (asserted in the suite below), so a
    // link to it 404s. The failure branch points at the GUI root, where the agy
    // surface now lives as a Settings section.
    expect(failedHtml).toContain('href="http://127.0.0.1:3080/"')
    expect(failedHtml).not.toContain('/agy"')
  })

  it('escapes attacker- and upstream-influenced text out of the markup', () => {
    // `error` is the token endpoint's raw response body and `email` comes from
    // Google's userinfo. This page shares an origin with the DSH GUI, so markup
    // injected here would run with the GUI session and could reach `/api/agy`
    // (where `account.exportAll` returns live credential blobs).
    const failedHtml = renderCallbackHtml({
      ok: false,
      error: '<img src=x onerror="alert(1)">',
      baseUrl: 'http://127.0.0.1:3080',
    })
    expect(failedHtml).not.toContain('<img src=x')
    expect(failedHtml).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')

    // The base URL reaches an href attribute; a quote would break out of it.
    const attributeHtml = renderCallbackHtml({
      ok: false,
      error: 'nope',
      baseUrl: 'http://127.0.0.1:3080" onmouseover="alert(1)',
    })
    expect(attributeHtml).not.toContain('" onmouseover="alert(1)')
    expect(attributeHtml).toContain('&quot; onmouseover=&quot;alert(1)')

    // The success branch interpolates the email into the markup AND into the
    // inline `<script>`. The script payload goes through jsonForInlineScript:
    // bare JSON.stringify escapes for a JS string, not for the HTML script-data
    // state, so a `</script>` in the value terminated the element early and
    // everything after it was parsed as markup (measured, not hypothesised).
    const email = `a"b</script><img src=x onerror=alert(1)>@example.com`
    const successHtml = renderCallbackHtml({ ok: true, email, baseUrl: 'http://127.0.0.1:3080' })
    expect(successHtml).not.toContain('<img src=x')
    expect(successHtml).not.toContain('</script><img')
    expect(successHtml).toContain('\\u003c/script\\u003e')
    const script = successHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(() => new Function(script!)).not.toThrow()
  })

  it('serves a syntactically valid callback script (template-literal escapes)', () => {
    // Regression: a '\n' inside the page.ts template literal renders as a real
    // newline, breaking the inline <script> and killing its handlers.
    const html = renderCallbackHtml({ ok: true, email: 'a@b.c', baseUrl: 'http://127.0.0.1:3080' })
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
  })

  it('provides complete bilingual keys in the i18n dictionary', () => {
    const enKeys = Object.keys(I18N_DICT.en)
    const zhKeys = Object.keys(I18N_DICT.zh)
    expect(enKeys.sort()).toEqual(zhKeys.sort())
  })
})

describe('dsh-agy web entry injection contract', () => {
  it('never statically injects a Web-only service', async () => {
    // Regression, measured on a real TUI profile: `webServer` sat in the static
    // `inject`. No provider of that service is mounted outside a Web
    // composition, so the entry stayed permanently pending — and the loader
    // treats a pending entry as a FAILED PROFILE, not a skipped one:
    //
    //   dsh: plugin tree failed to load: dsh: 1 entry did not activate
    //   dsh-agy/web: pending (waiting for service: webServer)
    //
    // Installing dsh-agy into dsh-tui therefore broke TUI startup outright.
    // Both Web-only services must be reached through `ctx.inject([...])`.
    const { inject } = await import('../src/web/plugin.ts')
    expect(inject).toEqual(['llm'])
    for (const service of ['webServer', 'connection', 'webStartup', 'attachments']) {
      expect(inject as readonly string[]).not.toContain(service)
    }
  })

  it('drops the dashboard route, keeping only the OAuth callback', async () => {
    // The management surface moved to the `/api/agy` RPC channel; the callback
    // stays a real route because Google redirects a browser to it with a GET.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/web/plugin.ts', import.meta.url), 'utf8')
    expect(source).toContain("path: '/agy/oauth-callback'")
    expect(source).not.toContain('renderDashboardHtml')
  })
})

describe('OAuth redirect base URL', () => {
  it('names the port the server bound, not the `--port 0` it was asked for', async () => {
    // Regression: under `dsh web --port 0` the OS picks a free port, but the
    // redirect was built from `webStartup.port`, so Google sent the browser to
    // `http://127.0.0.1:0/agy/oauth-callback` and login could never complete,
    // while a bare `dsh web` (no flag, 3080 fallback) worked.
    const { webBaseUrl } = await import('../src/web/plugin.ts')
    expect(webBaseUrl('127.0.0.1', { port: 54775 }, 0)).toBe('http://127.0.0.1:54775')
    expect(webBaseUrl('127.0.0.1', { port: 54775 }, undefined)).toBe('http://127.0.0.1:54775')
  })

  it('falls back to the requested port, then 3080, until the server reports one', async () => {
    const { webBaseUrl } = await import('../src/web/plugin.ts')
    expect(webBaseUrl('127.0.0.1', {}, 4000)).toBe('http://127.0.0.1:4000')
    expect(webBaseUrl('127.0.0.1', {}, undefined)).toBe('http://127.0.0.1:3080')
  })

  it('answers the OAuth callback for loopback peers only', async () => {
    // The route carries no authentication of its own, so a LAN-bound server must
    // not answer it for the network. It is still REGISTERED on such a bind: the
    // browser redirect that completes a local login has to land somewhere, and
    // refusing every peer (as the old bind-address gate did) removed the whole
    // management surface instead, leaving the Settings section calling
    // `/api/agy` against a 404.
    const { isLoopbackPeer } = await import('../src/web/plugin.ts')
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('127.0.0.5')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('100.116.122.12')).toBe(false)
    expect(isLoopbackPeer('192.168.1.20')).toBe(false)
    expect(isLoopbackPeer('::ffff:100.116.122.12')).toBe(false)
    // An absent address is refused rather than assumed local.
    expect(isLoopbackPeer(undefined)).toBe(false)
  })

  it('builds the redirect from a followable host, not a wildcard bind', async () => {
    // `--host 0.0.0.0` is a listen address: Google would send the browser to
    // `http://0.0.0.0:3080/...`, which only some browsers map to loopback. Any
    // specific host is kept verbatim so a NetBird-bound profile can still
    // complete a login from a remote browser.
    const { redirectHostFor } = await import('../src/web/plugin.ts')
    expect(redirectHostFor('0.0.0.0')).toBe('127.0.0.1')
    expect(redirectHostFor('::')).toBe('127.0.0.1')
    expect(redirectHostFor('127.0.0.1')).toBe('127.0.0.1')
    expect(redirectHostFor('100.116.122.12')).toBe('100.116.122.12')
  })
})
