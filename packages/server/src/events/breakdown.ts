import { EVENT_COLUMN_FIELDS, type EventColumnField, type Params } from '@lyraflow/core'

/**
 * How many series a trend returns before the rest are folded together.
 *
 * Ten is what a legend can hold and what a line chart can distinguish with a
 * categorical palette. It is a RENDERING limit, not a query one -- the query
 * has already computed every series by the time this applies.
 */
export const MAX_SERIES = 10

/**
 * The hard ceiling on `(bucket, series)` rows the aggregate may produce.
 *
 * A breakdown by a high-cardinality property -- `utm_content` on a real site
 * -- is one series per distinct value, multiplied by up to 1000 buckets. This
 * is the tripwire that stops that becoming a response nobody asked for.
 *
 * Crossing it is a REFUSAL, never a truncation. A trend silently missing its
 * rarest series still draws a plausible chart and the caller has no way to
 * tell; being told "that property has too many values, pick another" is the
 * answer they can act on. Same rule the retention grid's cohort cap follows.
 */
export const MAX_BREAKDOWN_ROWS = 20_000

/** The label a series with no value carries. */
export const NOT_SET = '(not set)'
/** The label the folded tail carries. */
export const OTHER = '(other)'

/**
 * Whether an aggregate came back past the ceiling.
 *
 * A named function rather than an inline `rows.length > MAX_BREAKDOWN_ROWS`,
 * so the decision itself is testable: seeding twenty thousand bucket/series
 * rows to exercise the refusal would cost more than the refusal is worth, and
 * an untestable branch on a refusal path is how a cap turns into a silent
 * truncation later.
 *
 * The query asks for `cap + 1` rows precisely so that "more than the cap"
 * is observable at all -- at exactly `cap` rows there is no way to tell a
 * full result from a truncated one.
 */
export function breakdownOverflowed(rowCount: number, cap = MAX_BREAKDOWN_ROWS): boolean {
  return rowCount > cap
}

export type Breakdown =
  | { source: 'event_name' }
  | { source: 'attribute'; name: EventColumnField }
  | { source: 'property'; name: string }

export class BreakdownError extends Error {}

/**
 * Parses the `group_by` query parameter.
 *
 * A colon-delimited string rather than a JSON object, because this is a GET
 * and the parameter has to survive being typed into an address bar. The
 * `source:name` shape carries the same discrimination `WherePredicate` makes,
 * for the same reason: a property genuinely named `path` and the COLUMN named
 * `path` are different things, and which is meant must be stated rather than
 * guessed from the name.
 *
 * `event_name` keeps parsing bare. That is the only value this parameter
 * accepted before trends existed, and the CLI and any script using it must
 * not break -- so it is a member here rather than a migration.
 */
export function parseBreakdown(raw: string | undefined): Breakdown | undefined {
  if (raw === undefined || raw === '') return undefined
  if (raw === 'event_name') return { source: 'event_name' }

  const at = raw.indexOf(':')
  if (at === -1) {
    throw new BreakdownError(
      `group_by must be \`event_name\`, \`attribute:<field>\` or \`property:<key>\`, not \`${raw}\``,
    )
  }
  const source = raw.slice(0, at)
  const name = raw.slice(at + 1)
  if (name === '' || name.length > 128) {
    throw new BreakdownError('group_by needs a field name after the colon, up to 128 characters')
  }

  if (source === 'attribute') {
    // Checked against the SAME allowlist that makes the interpolation in
    // `breakdownExpr` safe. A name not in it is refused here rather than
    // reaching SQL, so there is no runtime check downstream that a later edit
    // could drop.
    if (!(EVENT_COLUMN_FIELDS as readonly string[]).includes(name)) {
      throw new BreakdownError(
        `\`${name}\` is not an event column; one of: ${EVENT_COLUMN_FIELDS.join(', ')}`,
      )
    }
    return { source: 'attribute', name: name as EventColumnField }
  }
  if (source === 'property') return { source: 'property', name }

  throw new BreakdownError(
    `group_by source must be \`attribute\` or \`property\`, not \`${source}\``,
  )
}

/**
 * A literal this module controls, for the two label constants only.
 *
 * NOT a general escape hatch: every caller-supplied value in this file goes
 * through `params.add`. These two are module constants with no caller input in
 * them, and binding them would add two parameters to every trend query to say
 * something the compiler already knows. The assertion is what keeps that true
 * if someone edits a label into something with a quote in it.
 */
function quoted(literal: string): string {
  if (!/^[\w() -]+$/.test(literal)) throw new Error('label is not a safe SQL literal')
  return `'${literal}'`
}

/**
 * The SQL expression a breakdown groups by, always a `String`.
 *
 * Three things this has to get right:
 *
 * - An attribute is interpolated BARE, and is safe for exactly the reason
 *   `wherePredicate` gives: the value is typed `EventColumnField`, a member of
 *   a list `parseBreakdown` has already checked, so nothing arbitrary reaches
 *   here.
 * - A property is read from BOTH bags. Routing is per value at ingest, so
 *   `plan: "pro"` lands in `properties` and `seats: 5` in `properties_num`.
 *   Reading only the string bag would report every numeric property as one
 *   empty series -- a chart that is not so much wrong as blank.
 * - An absent or empty value becomes `(not set)`, never `''`. Events lacking
 *   the property must stay VISIBLE: a breakdown whose series do not add up to
 *   the unbroken total is one nobody can reconcile against the Feed, and an
 *   empty-string series renders as a gap in the legend.
 */
export function breakdownExpr(b: Breakdown, params: Params): string {
  if (b.source === 'event_name') return 'event_name'
  if (b.source === 'attribute') {
    return `if(${b.name} = '', ${quoted(NOT_SET)}, ${b.name})`
  }

  const key = params.add(b.name, 'String')
  return `if(mapContains(properties, ${key}), properties[${key}], if(mapContains(properties_num, ${key}), toString(properties_num[${key}]), ${quoted(NOT_SET)}))`
}

/** Which columns a breakdown needs projected out of the inner scan. */
export function breakdownColumns(b: Breakdown | undefined): string[] {
  if (b === undefined || b.source === 'event_name') return []
  if (b.source === 'attribute') return [b.name]
  return ['properties', 'properties_num']
}

export interface SeriesPoint {
  bucket: string
  series: string
  events: number
}

/**
 * Folds everything past the top `max` into one `(other)` series.
 *
 * Ranked by TOTAL volume over the whole window, not by any single bucket, so a
 * series does not appear and disappear along the x-axis. Ties break on the
 * name, so the same data always produces the same chart.
 *
 * `(other)` is a real series, kept and labelled, never dropped. A chart whose
 * parts do not add up to the total is one nobody can reconcile, and "where did
 * the rest go" is a question the screen has to answer itself rather than leave
 * to the reader.
 */
export function foldSeries(
  points: SeriesPoint[],
  max = MAX_SERIES,
): { points: SeriesPoint[]; folded: number } {
  const totals = new Map<string, number>()
  for (const p of points) totals.set(p.series, (totals.get(p.series) ?? 0) + p.events)

  if (totals.size <= max) return { points, folded: 0 }

  const kept = new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, max)
      .map(([series]) => series),
  )

  // Summed per bucket rather than concatenated: several folded series in one
  // bucket are ONE `(other)` point, not several rows sharing a name that a
  // chart would draw on top of each other.
  const merged = new Map<string, SeriesPoint>()
  for (const p of points) {
    const series = kept.has(p.series) ? p.series : OTHER
    const at = `${p.bucket} ${series}`
    const existing = merged.get(at)
    if (existing) existing.events += p.events
    else merged.set(at, { bucket: p.bucket, series, events: p.events })
  }

  return { points: [...merged.values()], folded: totals.size - kept.size }
}
