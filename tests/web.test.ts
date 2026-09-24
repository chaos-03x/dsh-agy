import { describe, it, expect, vi } from 'vitest'
import { createAgyWebRoutes } from '../src/web/routes.ts'
import { renderDashboardHtml, renderCallbackHtml } from '../src/web/page.ts'
import { I18N_DICT } from '../src/web/i18n.ts'

describe('dsh-agy web routes & page rendering', () => {
  it('renders dashboard html containing DSH design tokens and i18n dictionary', () => {
    const html = renderDashboardHtml()
    expect(html).toContain('Antigravity Account Pool')
    expect(html).toContain('var(--dsw-font-family)')
    expect(html).toContain('var(--brand-primary)')
    expect(html).toContain('toast-container')
    expect(html).toContain('main-grid')
    expect(html).toContain('account-list')
  })

  it('serves a syntactically valid inline dashboard script (template-literal escapes)', () => {
    // Regression: '\n' inside the page.ts template literal renders as a real
    // newline, breaking the inline <script> and killing every button handler
    // (login button appeared dead). The served script must parse.
    const html = renderDashboardHtml()
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    expect(() => new Function(script!)).not.toThrow()
    // The line-splitting helpers must emit backslash-n, not a literal newline.
    expect(script).toContain("split('\\n')")
    expect(script).toContain(".join('\\n')")
  })

  it('renders callback html for success and failure states', () => {
    const successHtml = renderCallbackHtml({ ok: true, email: 'test@example.com', baseUrl: 'http://127.0.0.1:3080' })
    expect(successHtml).toContain('Sign-in Successful')
    expect(successHtml).toContain('test@example.com')
    expect(successHtml).toContain('window.close()')

    const failedHtml = renderCallbackHtml({ ok: false, error: 'Access denied', baseUrl: 'http://127.0.0.1:3080' })
    expect(failedHtml).toContain('Sign-in Failed')
    expect(failedHtml).toContain('Access denied')
    expect(failedHtml).toContain('http://127.0.0.1:3080/agy')
  })

  it('provides complete bilingual keys in i18n dictionary', () => {
    const enKeys = Object.keys(I18N_DICT.en)
    const zhKeys = Object.keys(I18N_DICT.zh)
    expect(enKeys.sort()).toEqual(zhKeys.sort())
  })

  it('registers all required routes on createAgyWebRoutes', () => {
    const storeStub = { load: vi.fn(), mutate: vi.fn() } as any
    const sessionsStub = {
      getSession: vi.fn(),
      getSessionForIndex: vi.fn(),
      activateAccount: vi.fn(),
      clearSessionPin: vi.fn(),
      verifyAccount: vi.fn(),
      testCall: vi.fn(),
      exportBlob: vi.fn(),
    } as any
    const routes = createAgyWebRoutes({ store: storeStub, sessions: sessionsStub, baseUrl: 'http://127.0.0.1:3080' })
    
    const paths = routes.map((r) => r.path)
    expect(paths).toContain('/agy')
    expect(paths).toContain('/agy/oauth-callback')
    expect(paths).toContain('/agy/api/accounts')
    expect(paths).toContain('/agy/api/auth-url')
    expect(paths).toContain('/agy/api/import')
    expect(paths).toContain('/agy/api/export-all')
    expect(paths).toContain('/agy/api/verify')
    expect(paths).toContain('/agy/api/health')
    expect(paths).toContain('/agy/api/delete')
    expect(paths).toContain('/agy/api/activate')
    expect(paths).toContain('/agy/api/models')
    expect(paths).toContain('/agy/api/test')
    expect(paths).toContain('/agy/api/export')
    expect(paths).toContain('/agy/api/fingerprint')
  })

  it('/agy/api/accounts returns quota for all accounts in pool, not just active index', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('fetchAvailableModels')) {
        return new Response(JSON.stringify({
          models: {
            'gemini-2.5-flash': { quotaInfo: { remainingFraction: 0.9, resetTime: '2099-01-01T00:00:00Z' } },
          },
        }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))

    const storeStub = {
      load: vi.fn().mockResolvedValue({
        version: 4,
        accounts: [
          { email: 'first@test.com', refresh: 'r1', enabled: true },
          { email: 'second@test.com', refresh: 'r2', enabled: true },
        ],
        activeIndex: 0,
      }),
      mutate: vi.fn(),
    } as any

    const sessionsStub = {
      getSessionForIndex: vi.fn().mockImplementation((idx: number) => Promise.resolve({
        auth: { access: `token-${idx}` },
        account: { projectId: `proj-${idx}`, proxy: undefined },
        index: idx,
        impersonation: {},
      })),
      getSession: vi.fn(),
    } as any

    const routes = createAgyWebRoutes({ store: storeStub, sessions: sessionsStub, baseUrl: 'http://127.0.0.1:3080' })
    const accountsRoute = routes.find((r) => r.path === '/agy/api/accounts')!

    let responseData: any
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((data: string) => {
        responseData = JSON.parse(data)
      }),
    } as any

    await accountsRoute.handler({} as any, res)

    expect(responseData.accounts).toHaveLength(2)
    expect(responseData.accounts[0].quota).not.toBeNull()
    expect(responseData.accounts[0].quota.models[0].id).toBe('gemini-2.5-flash')
    expect(responseData.accounts[1].quota).not.toBeNull()
    expect(responseData.accounts[1].quota.models[0].id).toBe('gemini-2.5-flash')
    expect(sessionsStub.getSessionForIndex).toHaveBeenCalledWith(0)
    expect(sessionsStub.getSessionForIndex).toHaveBeenCalledWith(1)
    vi.unstubAllGlobals()
  })

  it('/agy/api/activate activates account and delegates to sessions.activateAccount', async () => {
    const storeStub = { load: vi.fn(), mutate: vi.fn() } as any
    const sessionsStub = {
      activateAccount: vi.fn().mockResolvedValue(undefined),
      clearSessionPin: vi.fn(),
    } as any
    const routes = createAgyWebRoutes({ store: storeStub, sessions: sessionsStub, baseUrl: 'http://127.0.0.1:3080' })
    const activateRoute = routes.find((r) => r.path === '/agy/api/activate')!

    const { Readable } = await import('node:stream')
    const req = Readable.from([Buffer.from(JSON.stringify({ index: 1 }))]) as any
    let responseData: any
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((data: string) => {
        responseData = JSON.parse(data)
      }),
    } as any

    await activateRoute.handler(req, res)
    expect(sessionsStub.activateAccount).toHaveBeenCalledWith(1)
    expect(responseData).toEqual({ ok: true, index: 1 })
  })
})
