import { describe, expect, it } from 'vitest'
import { assertDroppable, expiredPartitions, retentionBoundary, toYYYYMM } from './boundary.js'

describe('retentionBoundary', () => {
  it('is the first day of the month N months back, in UTC', () => {
    // Month-granular by construction: partitions are whole months, so the
    // boundary is a month, not an instant. A project on 13 months therefore
    // holds between 13 and 14 months of data depending on the day -- a floor,
    // not an exact promise. This is the line that makes that true.
    expect(retentionBoundary(new Date('2026-08-09T13:45:12.000Z'), 13).toISOString()).toBe(
      '2025-07-01T00:00:00.000Z',
    )
  })

  it('does not drift when now is the first instant of a month', () => {
    expect(retentionBoundary(new Date('2026-08-01T00:00:00.000Z'), 13).toISOString()).toBe(
      '2025-07-01T00:00:00.000Z',
    )
  })

  it('does not drift when now is the last instant of a month', () => {
    expect(retentionBoundary(new Date('2026-08-31T23:59:59.999Z'), 13).toISOString()).toBe(
      '2025-07-01T00:00:00.000Z',
    )
  })

  it('crosses a year boundary correctly', () => {
    expect(retentionBoundary(new Date('2026-01-15T00:00:00.000Z'), 13).toISOString()).toBe(
      '2024-12-01T00:00:00.000Z',
    )
  })

  it('handles the ends of the permitted range', () => {
    // The column is CHECK BETWEEN 1 AND 120.
    expect(retentionBoundary(new Date('2026-08-09T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    )
    expect(retentionBoundary(new Date('2026-08-09T00:00:00.000Z'), 120).toISOString()).toBe(
      '2016-08-01T00:00:00.000Z',
    )
  })

  it('never lands on a 31st, which a naive setMonth would', () => {
    // new Date('2026-03-31').setMonth(-1) rolls into March, not February.
    // Building from year/month components avoids it; this pins that choice.
    expect(retentionBoundary(new Date('2026-03-31T12:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    )
  })

  it('subtracts, not adds -- a flipped sign would compute a boundary in the future', () => {
    const boundary = retentionBoundary(new Date('2026-08-09T00:00:00.000Z'), 1)
    expect(boundary.getTime()).toBeLessThan(new Date('2026-08-09T00:00:00.000Z').getTime())
  })
})

describe('toYYYYMM', () => {
  it('encodes year and month as YYYYMM, month zero-padded via arithmetic not string concat', () => {
    expect(toYYYYMM(new Date('2026-01-15T00:00:00.000Z'))).toBe(202601)
    expect(toYYYYMM(new Date('2026-12-31T23:59:59.999Z'))).toBe(202612)
  })
})

describe('expiredPartitions', () => {
  const boundary = new Date('2025-07-01T00:00:00.000Z')

  it('returns only partitions strictly older than the boundary month', () => {
    expect(expiredPartitions([202505, 202506, 202507, 202508], boundary)).toEqual([202505, 202506])
  })

  it('never returns the boundary month itself', () => {
    // The boundary month is KEPT. Off by one here deletes a month of data
    // that the retention policy promised to hold.
    expect(expiredPartitions([202507], boundary)).toEqual([])
  })

  it('returns nothing when every partition is newer', () => {
    expect(expiredPartitions([202508, 202509], boundary)).toEqual([])
  })

  it('returns them sorted oldest first, whatever order it was given', () => {
    expect(expiredPartitions([202506, 202501, 202505], boundary)).toEqual([202501, 202505, 202506])
  })

  it('returns an empty array for an empty partition list', () => {
    expect(expiredPartitions([], boundary)).toEqual([])
  })

  it('handles a partition list spanning a year boundary correctly', () => {
    // 202412 < 202507 but numeric comparison alone (without YYYYMM encoding)
    // would get this wrong if year and month were compared separately.
    expect(expiredPartitions([202412, 202501, 202506, 202507], boundary)).toEqual([
      202412, 202501, 202506,
    ])
  })
})

describe('assertDroppable', () => {
  it('throws at the boundary month -- the boundary month must be kept', () => {
    expect(() => assertDroppable(202507, 202507, 42)).toThrow()
  })

  it('throws for a newer month', () => {
    expect(() => assertDroppable(202508, 202507, 42)).toThrow()
  })

  it('does not throw for an older month', () => {
    expect(() => assertDroppable(202506, 202507, 42)).not.toThrow()
  })

  it('names the partition, the boundary and the project in the message', () => {
    expect(() => assertDroppable(202507, 202507, 42)).toThrow(/202507/)
    expect(() => assertDroppable(202507, 202507, 42)).toThrow(/42/)
    // Distinguish partition from boundary in the message even when the
    // triggering case has them equal -- use a case where they differ so a
    // message that dropped one of the two numbers would still be caught.
    expect(() => assertDroppable(202510, 202507, 42)).toThrow(/202510/)
    expect(() => assertDroppable(202510, 202507, 42)).toThrow(/202507/)
    expect(() => assertDroppable(202510, 202507, 42)).toThrow(/42/)
  })

  it('rejects a non-finite or non-integer partition instead of silently passing', () => {
    // NaN >= boundaryMonth is false, so without an explicit check a garbage
    // partition value would sail straight through the `>=` guard below and
    // reach the caller as "droppable."
    expect(() => assertDroppable(Number.NaN, 202507, 42)).toThrow(/partition/)
    expect(() => assertDroppable(Number.POSITIVE_INFINITY, 202507, 42)).toThrow(/partition/)
    expect(() => assertDroppable(Number.NEGATIVE_INFINITY, 202507, 42)).toThrow(/partition/)
    expect(() => assertDroppable(202507.5, 202507, 42)).toThrow(/partition/)
  })

  it('rejects a non-finite or non-integer boundary month instead of silently passing', () => {
    expect(() => assertDroppable(202507, Number.NaN, 42)).toThrow(/boundary/)
    expect(() => assertDroppable(202507, Number.POSITIVE_INFINITY, 42)).toThrow(/boundary/)
    expect(() => assertDroppable(202507, Number.NEGATIVE_INFINITY, 42)).toThrow(/boundary/)
    expect(() => assertDroppable(202507, 202507.5, 42)).toThrow(/boundary/)
  })

  it('names the bad value itself, not just which argument it was', () => {
    expect(() => assertDroppable(Number.NaN, 202507, 42)).toThrow(/NaN/)
    expect(() => assertDroppable(202507, Number.NaN, 42)).toThrow(/NaN/)
  })

  it('rejects a negative, zero, or otherwise implausible partition even when it is a well-formed integer', () => {
    // Number.isInteger(-1) is true, so these pass the finiteness check above
    // and need their own guard -- the same "parse went wrong" failure class,
    // just landing on a plausible-looking number instead of NaN.
    expect(() => assertDroppable(-1, 202507, 42)).toThrow(/partition/)
    expect(() => assertDroppable(0, 202507, 42)).toThrow(/partition/)
    expect(() => assertDroppable(999_999, 202507, 42)).toThrow(/partition/)
  })

  it('rejects a negative, zero, or otherwise implausible boundary month even when it is a well-formed integer', () => {
    expect(() => assertDroppable(202507, -1, 42)).toThrow(/boundary/)
    expect(() => assertDroppable(202507, 0, 42)).toThrow(/boundary/)
    expect(() => assertDroppable(202507, 999_999, 42)).toThrow(/boundary/)
  })

  it('accepts the edges of the plausible range and rejects one step outside them', () => {
    // Both ends are droppable-shaped calls (partition older than boundary),
    // so a value that clears the range check but shouldn't reach this far
    // would show up as "did not throw" rather than a range-check throw.
    expect(() => assertDroppable(200_001, 200_002, 42)).not.toThrow()
    expect(() => assertDroppable(210_011, 210_012, 42)).not.toThrow()
    expect(() => assertDroppable(200_000, 200_002, 42)).toThrow(/partition/)
    expect(() => assertDroppable(210_011, 210_013, 42)).toThrow(/boundary/)
  })
})
