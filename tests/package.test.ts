import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dsh?: { client?: { platform?: string, inject?: string[], external?: string[] } }
  exports?: Record<string, { default?: string }>
}

describe('dsh-agy client package contract', () => {
  it('declares the Settings client module', () => {
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
    // The section needs the runtime (ClientContext), the settings domain (the
    // `settings.section` slot type), and the slot registry it registers into.
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-ui-settings',
        '@deepseek-ai/dsh-client-ui-slots',
      ],
      // The host shares ui-primitives into the frozen module table, so the
      // bundle must request it rather than inline a second copy.
      external: ['@deepseek-ai/dsh-client-ui-primitives'],
    })
  })

  it('never inlines a second ReactDOM', () => {
    // The quota popover is portaled to `document.body`, which needs
    // `createPortal`. `react-dom` is in the shell's frozen module table
    // (`PLATFORM_MODULES`), so the bundle must REQUEST it: inlining a second
    // ReactDOM ships another reconciler with its own internal state, which was
    // exactly what happened (1.1MB bundle, 186KB after the fix).
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(source).toContain('require("react-dom")')
    // A vendored copy would show up as the package's own CJS filename.
    expect(source).not.toContain('react-dom.development.js')
    expect(source).not.toContain('react-dom.production.min.js')
  })

  it('emits the client artifact after build', () => {
    expect(existsSync(new URL('../lib/client.js', import.meta.url))).toBe(true)
    expect(existsSync(new URL('../lib/client.d.ts', import.meta.url))).toBe(true)
  })

  it('retired the /agy API route table in favour of the RPC channel', () => {
    // Regression guard: the inline UI reaches the host over the Connection RPC
    // channel (`/api/agy`), so the standalone route module must not come back.
    expect(existsSync(new URL('../src/web/routes.ts', import.meta.url))).toBe(false)
    expect(existsSync(new URL('../src/web/management.ts', import.meta.url))).toBe(true)
  })
})
