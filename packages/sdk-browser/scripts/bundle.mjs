import { build } from 'esbuild'

// dist/lyraflow.js was already removed by scripts/clean.mjs, which runs
// before this script in the `build` chain — see that file for why the
// removal has to happen there and not just here. esbuild only writes
// `outfile` on success, so this script leaves no bundle at all if it fails.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/lyraflow.js',
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'lyraflowBundle',
  target: ['es2020'],
  legalComments: 'none',
})
