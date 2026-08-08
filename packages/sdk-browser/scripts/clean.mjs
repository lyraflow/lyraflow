import { rmSync } from 'node:fs'

// Runs FIRST in the build chain, before `tsc -b` and before the esbuild step,
// so a failure in either one leaves no `dist/lyraflow.js` behind.
//
// The ordering is the whole point, and it is why this lives in its own script
// rather than at the top of `bundle.mjs`. The chain is `clean && tsc -b &&
// bundle`, so a `tsc -b` failure short-circuits and `bundle.mjs` never runs at
// all — a cleanup living there would be skipped exactly when it was needed, and
// yesterday's bundle would survive. `bundle-size.test.ts` would then measure a
// stale artefact and pass, which is a guard agreeing with a broken build.
rmSync('dist/lyraflow.js', { force: true })
