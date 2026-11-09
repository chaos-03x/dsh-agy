import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli/index.ts', 'src/web/plugin.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: true,
    clean: true,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    // `react`, `react-dom` and the DSH platform modules are shared into the
    // frozen module table by the shell (packages/client/web/src/platform.ts
    // PLATFORM_MODULES): the bundle must require them, never inline a second
    // copy. `react-dom` joined this list when the quota popover became a PORTAL
    // (`createPortal`) — without it the bundler inlined a whole second ReactDOM,
    // which is a second reconciler with its own internal state.
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    copy: [{ from: 'client.d.ts', rename: 'client.d.ts' }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-agy", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
