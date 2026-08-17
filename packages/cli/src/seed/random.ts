/**
 * The only source of randomness the demo seeder has.
 *
 * `Math.random()` is deliberately absent from every file under `seed/`: the
 * whole value of this tool is that two runs at the same seed produce the same
 * data, so "before" and "after" a change to a screen can be compared at all.
 * A single unseeded call anywhere in the generator would quietly destroy that
 * for the entire run, and nothing about the output would look wrong.
 *
 * mulberry32: a 32-bit generator with a 2^32 period, chosen because it is
 * short enough to read in one sitting and depends on nothing. It is NOT
 * cryptographic and must never be used for a key, an id that has to be
 * unguessable, or anything else where predictability is a weakness — here
 * predictability is the entire requirement.
 */

/** The widest seed `mulberry32` can hold without silently truncating. */
export const MAX_SEED = 0xffffffff

export type Rng = () => number

/** Returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An integer in [min, max], both inclusive. */
export function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1))
}

/** A float in [min, max). */
export function floatBetween(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min)
}

/**
 * A float in [min, max) rounded to `dp` decimal places.
 *
 * Rounded rather than raw because these values end up in `properties_num`,
 * are read back as Float64, and get rendered in a UI: `19.99` is a price and
 * `19.990000000000002` is a distraction in a screenshot.
 */
export function roundedBetween(rng: Rng, min: number, max: number, dp: number): number {
  const factor = 10 ** dp
  return Math.round(floatBetween(rng, min, max) * factor) / factor
}

/** Uniform choice from a non-empty list. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new Error('pick: cannot choose from an empty list')
  return item
}

/**
 * Weighted choice. Weights need not sum to anything in particular; they are
 * normalised here, so a caller can express "roughly three times as likely"
 * without doing arithmetic.
 */
export function weighted<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  let total = 0
  for (const [, w] of items) {
    if (!(w > 0)) throw new Error('weighted: every weight must be a positive number')
    total += w
  }
  if (total === 0) throw new Error('weighted: cannot choose from an empty list')

  let target = rng() * total
  for (const [value, w] of items) {
    target -= w
    if (target < 0) return value
  }
  // Only reachable through floating-point drift on the last step; the last
  // entry is the correct answer in that case, not an error.
  const last = items[items.length - 1]
  if (last === undefined) throw new Error('weighted: cannot choose from an empty list')
  return last[0]
}
