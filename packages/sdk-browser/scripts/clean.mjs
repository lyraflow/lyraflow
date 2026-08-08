import { rmSync } from 'node:fs'

// Runs before both `tsc -b` and the esbuild step, so a failure in either one
// leaves no `dist/lyraflow.js` behind. `bundle.mjs` cleans again immediately
// before esbuild runs, but `tsc -b` can fail first — if it did, `bundle.mjs`
// would never run at all, and this earlier removal is what still guarantees
// the size test sees a missing bundle rather than yesterday's.
rmSync('dist/lyraflow.js', { force: true })
