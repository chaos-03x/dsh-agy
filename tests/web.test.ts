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
    const sessionsStub = { getSession: vi.fn(), verifyAccount: vi.fn(), testCall: vi.fn(), exportBlob: vi.fn() } as any
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
})
