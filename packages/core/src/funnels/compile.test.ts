import { describe, expect, it } from 'vitest'
import { Params } from '../segments/params.js'
import { compileFunnel } from './compile.js'
import { FunnelValidationError } from './validate.js'

const range = { since: new Date('2026-08-07T00:00:00Z'), until: new Date('2026-08-14T00:00:00Z') }
// Well after `until`, so the default case is a fully-elapsed window.
const now = new Date('2026-09-01T00:00:00Z')
const base = { projectId: 7, database: 'lyraflow', range, now }
const twoSteps = { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 }

describe('compileFunnel', () => {
  it('binds every value rather than interpolating it', () => {
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [
          { event: '$page', where: [{ property: 'path', operator: '=', value: "'; DROP TABLE" }] },
          { event: 'signed_up' },
        ],
        window_seconds: 3600,
      },
    })
    expect(c.sql).not.toContain('DROP TABLE')
    expect(Object.values(c.params)).toContain("'; DROP TABLE")
  })

  it('restricts the scan to the funnel’s own events', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('event_name IN')
    expect(Object.values(c.params)).toContain('a')
    expect(Object.values(c.params)).toContain('b')
  })

  it('names each distinct step event once in the scan filter', () => {
    // Four steps, two distinct events: the IN list must not repeat them.
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [
          { event: '$page', where: [{ property: 'path', operator: '=', value: '/' }] },
          { event: '$page', where: [{ property: 'path', operator: '=', value: '/pricing' }] },
          { event: '$page', where: [{ property: 'path', operator: '=', value: '/signup' }] },
          { event: 'signed_up' },
        ],
        window_seconds: 3600,
      },
    })
    const inList = /event_name IN \(([^)]*)\)/.exec(c.sql)?.[1] ?? ''
    expect(inList.split(',')).toHaveLength(2)
  })

  it('deduplicates by event_id the same way the behavioural scan does', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('LIMIT 1 BY project_id, event_id')
  })

  it('excludes suppressed people', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('dictHas')
    expect(c.sql).toContain('suppressed_persons')
  })

  it('resolves identity rather than grouping by anonymous_id', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('identity_bindings')
    expect(c.sql).toContain('GROUP BY person_id')
    expect(c.sql).not.toContain('GROUP BY anonymous_id')
  })

  it('emits one windowFunnel condition per step, in the declared order', () => {
    const c = compileFunnel({
      ...base,
      definition: { steps: [{ event: 'a' }, { event: 'b' }, { event: 'c' }], window_seconds: 3600 },
    })
    const call = /windowFunnel\(.*?\)\((.*?)\) AS level/s.exec(c.sql)?.[1] ?? ''
    const names = ['a', 'b', 'c'].map((e) => {
      const param = Object.entries(c.params).find(([, v]) => v === e)?.[0] ?? '??'
      return call.indexOf(`{${param}:String}`)
    })
    expect(names.every((i) => i >= 0)).toBe(true)
    expect(names).toEqual([...names].sort((x, y) => x - y))
  })

  it('carries the window as a bound parameter, in the timestamp’s own unit', () => {
    // windowFunnel compares the window against the timestamp expression, and
    // that expression is milliseconds since the epoch — see the note in
    // compile.ts about why it cannot be the DateTime64 column itself.
    const c = compileFunnel({
      ...base,
      definition: { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 604800 },
    })
    expect(Object.values(c.params)).toContain(604_800_000)
    expect(c.sql).not.toContain('windowFunnel(604800)')
  })

  it('feeds windowFunnel an unsigned millisecond timestamp', () => {
    // A DateTime64(3) is rejected outright, and toUnixTimestamp64Milli alone
    // returns a signed Int64 which is rejected too. Both are Code 43.
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('toUInt64(toUnixTimestamp64Milli(timestamp))')
  })

  it('measures the partial-window boundary against now, not against until', () => {
    // The range's own end is irrelevant: what decides whether someone still
    // has time to convert is how long ago they entered in REAL time.
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('entered_at')
    expect(c.sql).toContain('AS partial')
    // now (2026-09-01T00:00:00Z) minus a 3600s window.
    expect(Object.values(c.params)).toContain('2026-08-31 23:00:00.000')
  })

  it('observes conversions past the end of the range, up to one window later', () => {
    // Someone entering an hour before `until` still gets their full window;
    // the scan therefore runs to until + window.
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(Object.values(c.params)).toContain('2026-08-07 00:00:00.000')
    expect(Object.values(c.params)).toContain('2026-08-14 01:00:00.000')
  })

  it('never scans past now, because there are no events from the future', () => {
    const c = compileFunnel({
      ...base,
      definition: twoSteps,
      now: new Date('2026-08-14T00:30:00Z'),
    })
    expect(Object.values(c.params)).toContain('2026-08-14 00:30:00.000')
    expect(Object.values(c.params)).not.toContain('2026-08-14 01:00:00.000')
  })

  it('bounds ENTRY to the range even though the scan runs past it', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    const call = /windowFunnel\(.*?\)\((.*?)\) AS level/s.exec(c.sql)?.[1] ?? ''
    const untilParam = Object.entries(c.params).find(
      ([, v]) => v === '2026-08-14 00:00:00.000',
    )?.[0]
    // The `until` bound rides on step 1's condition, not on the scan.
    expect(call).toContain(`timestamp < {${untilParam}:DateTime64(3)}`)
  })

  it('drops people who matched no step at all', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    expect(c.sql).toContain('level > 0')
  })

  it('restricts to a segment population when one is supplied', () => {
    const c = compileFunnel({
      ...base,
      definition: twoSteps,
      segmentPersonSql: 'SELECT person_id FROM whatever',
    })
    expect(c.sql).toContain('person_id IN (SELECT person_id FROM whatever)')
  })

  it('does not mention a segment when none is supplied', () => {
    expect(compileFunnel({ ...base, definition: twoSteps }).sql).not.toContain('person_id IN (')
  })

  it('carries the cost warnings the validator produced', () => {
    const c = compileFunnel({
      ...base,
      definition: { steps: [{ event: '$page' }, { event: 'b' }], window_seconds: 3600 },
    })
    expect(c.warnings.some((w) => w.path === 'steps.0')).toBe(true)
  })

  it('rejects an over-cap definition here rather than at ClickHouse', () => {
    expect(() =>
      compileFunnel({
        ...base,
        definition: {
          steps: Array.from({ length: 9 }, (_, i) => ({ event: `e${i}` })),
          window_seconds: 3600,
        },
      }),
    ).toThrow(FunnelValidationError)
  })

  it('rejects an over-long range here rather than at ClickHouse', () => {
    expect(() =>
      compileFunnel({
        ...base,
        range: { since: new Date('2026-01-01T00:00:00Z'), until: range.until },
        definition: twoSteps,
      }),
    ).toThrow(FunnelValidationError)
  })

  it('continues a caller-supplied Params rather than starting a second one', () => {
    // The segment is compiled with the SAME Params instance, so its values
    // and the funnel's cannot collide. Two independently-numbered maps merged
    // after the fact would silently overwrite p0.
    const params = new Params()
    const segmentValue = params.add('from-the-segment', 'String')
    const c = compileFunnel({
      ...base,
      definition: twoSteps,
      params,
      segmentPersonSql: `SELECT person_id FROM seg WHERE x = ${segmentValue}`,
    })
    expect(Object.values(c.params)).toContain('from-the-segment')
    expect(Object.values(c.params)).toContain('a')
    // Every placeholder the SQL references must exist in the params map.
    for (const [, name] of c.sql.matchAll(/\{(p\d+):/g)) {
      expect(c.params).toHaveProperty(name as string)
    }
  })
})
