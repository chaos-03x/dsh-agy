import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The per-account request throttle defaults to 1.5s in production; a suite
    // that fires dozens of consecutive stub requests would spend minutes in
    // setTimeout. Individual tests opt back in with their own value.
    env: { DSH_AGY_MIN_REQUEST_INTERVAL_MS: '0' },
  },
  resolve: {
    alias: {
      // The host UI primitives ship CSS modules, which Node's ESM loader cannot
      // import. The client tests exercise plugin registration and i18n — not
      // rendering — so they resolve to an inert stub of the same shape.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/helpers/ui-primitives-stub.ts', import.meta.url),
      ),
    },
  },
})
