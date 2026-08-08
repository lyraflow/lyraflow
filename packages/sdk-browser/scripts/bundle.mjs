import { build } from 'esbuild'

// dist/lyraflow.js was already removed by scripts/clean.mjs, which runs
// before this script in the `build` chain — see that file for why the
// removal has to happen there and not just here. esbuild only writes
// `outfile` on success, so this script leaves no bundle at all if it fails.
// No `globalName`. The bundle publishes itself on `window.lyraflow` at load
// (see `installGlobal` in src/index.ts) because that is the name the snippet's
// stub uses and the only one any documentation names. A `globalName` on top of
// that bought a second, undocumented handle and cost ~600 bytes of ESM-to-CJS
// interop preamble against a 5KB gzipped budget — and it was never a reliable
// handle anyway: a strict-mode top-level `var` is not guaranteed to be a
// property of the global object outside a real browser.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/lyraflow.js',
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  legalComments: 'none',
})
