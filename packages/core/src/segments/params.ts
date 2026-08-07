/** The ClickHouse parameter types this compiler emits. */
export type ChType = 'String' | 'UInt32' | 'Float64' | 'DateTime64(3)' | 'UInt8'

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
