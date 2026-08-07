/** The ClickHouse parameter types this compiler emits. */
export type ChType = 'String' | 'UInt32' | 'Float64' | 'DateTime64(3)' | 'UInt8'

/**
 * ClickHouse DateTime64(3) literal text.
 *
 * The trailing `Z` of an ISO-8601 string is not accepted by a DateTime64(3)
 * query parameter — ClickHouse rejects it with "cannot be parsed ... only 23
 * of 24 bytes was parsed", so every datetime crossing into SQL is formatted
 * here rather than passed through as the caller wrote it. Values are always
 * UTC: `toISOString` is the only formatter used, so a machine's local zone
 * cannot change what a saved segment means.
 */
export function chDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * The single place a value may enter compiled SQL.
 *
 * Every compiled fragment gets its values from `add()`, which returns a
 * `{name:Type}` placeholder and keeps the value in a map handed to the
 * driver separately. Nothing in the compiler concatenates a value into SQL
 * text, so injection is impossible by construction rather than by every
 * author remembering — which is the property the spec asks for.
 *
 * Names are positional (`p0`, `p1`, …) and never reused. They match
 * /^p\d+$/, so they cannot collide with a column, a function, or anything
 * else in the generated text.
 */
export class Params {
  #next = 0
  readonly values: Record<string, unknown> = {}

  add(value: string | number | boolean, type: ChType): string {
    const name = `p${this.#next++}`
    this.values[name] = value
    return `{${name}:${type}}`
  }
}
