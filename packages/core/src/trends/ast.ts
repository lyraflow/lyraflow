/**
 * The four bucket widths a trend chart can group its counts into.
 *
 * Shaped exactly like `GRANULARITIES` in `../retention/ast.ts` -- a `const
 * … as const` plus its derived type -- and living in the same kind of
 * per-domain `ast.ts` those two other domains (`segments`, `funnels`,
 * `retention`) already use for their own vocabulary constants, rather than a
 * new arrangement invented for this one.
 *
 * This is the SINGLE TypeScript source of truth: `trend-routes.ts` in
 * `@lyraflow/server` imports it instead of restating the four strings, and
 * `INTERVALS`/`Interval` in the UI's `screens/trends/params.ts` are slated to
 * do the same (tracked separately -- not this change).
 *
 * `020_saved_reports.sql`'s CHECK constraint
 * (`interval IN ('1m','1h','1d','1w')`) is still its own, separate,
 * hand-written copy, and that is a floor rather than an oversight: SQL
 * cannot import a TypeScript module, so the constraint can only ever be kept
 * in agreement by hand -- exactly the same situation `granularity`'s CHECK
 * constraint is already in against `GRANULARITIES`. Two copies (core,
 * migration) is the fewest this can ever be; one (core) is the fewest the
 * *application* layer needs.
 */
export const INTERVALS = ['1m', '1h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]
