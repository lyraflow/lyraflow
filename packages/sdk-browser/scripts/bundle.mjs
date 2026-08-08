import { build } from 'esbuild'

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
