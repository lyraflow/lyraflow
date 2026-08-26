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

describe('attribute predicates on a step', () => {
  const attr = (attribute: string, value: string) =>
    ({ source: 'attribute', attribute, operator: '=', value }) as never

  // A funnel step's `where` is the SAME `WherePredicate` a segment
  // behaviour's is, compiled by the same function -- so a step reaches the
  // column, and this scan has to project it for the same reason the
  // behavioural one does.
  it('compiles to the column and projects it', () => {
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [{ event: '$page', where: [attr('utm_campaign', 'august-digest')] }, { event: 'b' }],
        window_seconds: 3600,
      },
    })
    expect(c.sql).toContain('utm_campaign')
    expect(c.sql).not.toContain("'august-digest'")
    expect(Object.values(c.params)).toContain('august-digest')
  })

  it('projects nothing extra when no step names an attribute', () => {
    const c = compileFunnel({ ...base, definition: twoSteps })
    for (const column of ['utm_campaign', 'device_type', 'country', 'referrer', 'city']) {
      expect(c.sql, column).not.toContain(column)
    }
  })

  it('collects across every step, not just the first', () => {
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [
          { event: 'a', where: [attr('path', '/pricing')] },
          { event: 'b', where: [attr('os', 'macos')] },
        ],
        window_seconds: 3600,
      },
    })
    const projection = c.sql.slice(c.sql.indexOf('SELECT project_id'), c.sql.indexOf('FROM events'))
    expect(projection).toContain('path')
    expect(projection).toContain('os')
  })
})

const audience = {
  kind: 'behavior' as const,
  event: 'docs_search',
  aggregate: 'count' as const,
  window: { kind: 'last' as const, n: 14, unit: 'days' as const },
  operator: '=' as const,
  value: 1,
}

describe('step audiences', () => {
  it('gates the step condition, not the outer result', () => {
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [{ event: 'a' }, { event: 'b', audience }],
        window_seconds: 3600,
      },
    })
    // The gate must sit INSIDE the windowFunnel argument list. If it were
    // applied where the funnel-wide segment filter is, a person failing it
    // would vanish from the report instead of stopping at step 1 -- which is
    // the entire reason this feature is not just a second segment_id.
    // `IN (WITH`, NOT ` IN (` -- every funnel already emits
    // `AND event_name IN (${eventList})` in its inner scan, so the bare
    // marker matches an unaudienced funnel too and the pin below would pass
    // against no implementation at all. A compiled person set never opens
    // with a bare `SELECT`: `compileSegment` always builds a `base` CTE (a
    // person can have zero behaviours but never zero identity), so its SQL
    // always starts `WITH`; an event placeholder list never does. Measured
    // against the actual `compileSegment` output, not assumed from its shape.
    //
    // The marker distinguishes a GATE from an UNGATED funnel -- it does not
    // distinguish an audience gate from a real `segmentPersonSql`, which is
    // ALSO `compileSegment` output and therefore ALSO opens `WITH`. This
    // fixture passes no `segmentPersonSql`, which is the only reason the
    // outer assertion below means "no audience gate leaked out here" rather
    // than being vacuous. A funnel that legitimately carries both a step
    // audience and a `segment_id` restriction WILL show `IN (WITH` in both
    // places -- see 'keeps a step audience inside windowFunnel even when a
    // segment restriction is also present' below, which pins that
    // combination with a distinguishable stub instead of this marker.
    const windowFunnelArgs = c.sql.slice(c.sql.indexOf('windowFunnel'), c.sql.indexOf('AS level'))
    expect(windowFunnelArgs).toContain('IN (WITH')
    // ...and NOT next to `level > 0`, where segment_id's filter lives. Costs
    // nothing to keep even though it is not what would catch a step-audience
    // guard breaking (mutation 1 in the task report) -- this fixture has no
    // segment filter of any kind, so the outer slice containing the marker
    // at all would mean the gate leaked out, whatever put it there.
    const outer = c.sql.slice(c.sql.indexOf('WHERE level > 0'))
    expect(outer).not.toContain('IN (WITH')
  })

  it('compiles a definition with no audience to exactly the SQL it did before', () => {
    const withNone = compileFunnel({ ...base, definition: twoSteps })
    expect(withNone.sql).not.toContain('IN (WITH')
  })

  it('keeps a step audience inside windowFunnel even when a segment restriction is also present', () => {
    // `segmentPersonSql` is real `compileSegment` output in production
    // (`packages/server/src/funnels/routes.ts`), so it ALSO opens `WITH` --
    // the `IN (WITH` marker alone cannot tell the two apart here. Stubbed
    // with the plain-SELECT convention `compile.test.ts` already uses for a
    // segment restriction (see 'restricts to a segment population when one
    // is supplied' above), which does NOT open `WITH` and is therefore
    // separable from a real audience gate by text alone.
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [{ event: 'a' }, { event: 'b', audience }],
        window_seconds: 3600,
      },
      segmentPersonSql: 'SELECT person_id FROM whatever',
    })
    const windowFunnelArgs = c.sql.slice(c.sql.indexOf('windowFunnel'), c.sql.indexOf('AS level'))
    const outer = c.sql.slice(c.sql.indexOf('WHERE level > 0'))
    // The audience gate is inside windowFunnel's arguments...
    expect(windowFunnelArgs).toContain('IN (WITH')
    // ...and the segment filter is beside `level > 0`...
    expect(outer).toContain('SELECT person_id FROM whatever')
    // ...and neither displaced the other: the segment filter did not also
    // land inside windowFunnel, and the audience gate did not also land
    // beside `level > 0`.
    expect(windowFunnelArgs).not.toContain('SELECT person_id FROM whatever')
    expect(outer).not.toContain('IN (WITH')
  })

  it('threads ONE parameter sequence through every audience', () => {
    const c = compileFunnel({
      ...base,
      definition: {
        steps: [
          { event: 'a', audience: { ...audience, event: 'first' } },
          { event: 'b', audience: { ...audience, event: 'second' } },
        ],
        window_seconds: 3600,
      },
    })
    // Both audiences' event names are bound, and neither overwrote the
    // other: two independently-numbered Params maps merged after the fact
    // would silently collide on p0, p1, ...
    const values = Object.values(c.params)
    expect(values).toContain('first')
    expect(values).toContain('second')
    // Every placeholder the SQL names must exist in the map.
    for (const m of c.sql.matchAll(/\{(p\d+):/g)) {
      expect(c.params).toHaveProperty(m[1] as string)
    }
  })

  it('gates step 1, so entered_at counts only gated entrants', () => {
    const c = compileFunnel({
      ...base,
      definition: { steps: [{ event: 'a', audience }, { event: 'b' }], window_seconds: 3600 },
    })
    // `minIf(timestamp, conditions[0])` reuses step 1's condition verbatim,
    // so the gate reaches entry for free. Both occurrences must carry it.
    const minIf = c.sql.slice(c.sql.indexOf('minIf('), c.sql.indexOf('AS entered_at'))
    expect(minIf).toContain('IN (WITH')
  })

  it('refuses a definition whose audiences exceed the funnel-wide cap', () => {
    const many = {
      kind: 'group' as const,
      op: 'and' as const,
      children: Array.from({ length: 26 }, (_, i) => ({ ...audience, event: `e${i}` })),
    }
    expect(() =>
      compileFunnel({
        ...base,
        definition: {
          steps: [{ event: 'a', audience: many }, { event: 'b' }],
          window_seconds: 3600,
        },
      }),
    ).toThrow(FunnelValidationError)
  })
})

describe('peopleAt', () => {
  const base2 = {
    ...base,
    definition: { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 },
  }

  it('asks for everyone who reached the step, not only those who stopped there', () => {
    const c = compileFunnel({ ...base2, peopleAt: { step: 1, mode: 'reached', select: 'ids' } })
    expect(c.sql).toMatch(/level >= \{p\d+:UInt32\}/)
    expect(c.sql).not.toMatch(/level = \{p\d+:UInt32\}/)
  })

  it('asks for only those who stopped there in dropped mode', () => {
    const c = compileFunnel({ ...base2, peopleAt: { step: 1, mode: 'dropped', select: 'ids' } })
    expect(c.sql).toMatch(/level = \{p\d+:UInt32\}/)
    expect(c.sql).not.toMatch(/level >= \{p\d+:UInt32\}/)
  })

  it('compiles the ids shape without joining traits at all', () => {
    // `/dropoff` must keep compiling what it compiles today. A traits join it
    // never asked for is a second scan of person_traits on every existing
    // caller's request.
    const c = compileFunnel({ ...base2, peopleAt: { step: 1, mode: 'dropped', select: 'ids' } })
    expect(c.sql).not.toContain('person_traits')
    expect(c.sql).not.toContain('trait_total')
  })

  it('compiles the members shape with both CTEs the projection needs', () => {
    // memberProjection selects first_seen/last_seen and the context columns,
    // which come from `base` -- NOT from traits. Joining only traits yields a
    // query that references columns nothing in it produces.
    //
    // `toContain('first_seen')` alone is a vacuous pin here: memberProjection
    // emits that bare column name in its SELECT list unconditionally, so the
    // text is present whether or not `base` is actually joined -- caught by
    // running the mutation in Step 6 of the task brief, which this test as
    // originally written did not fail against. Pinning the JOIN clause and
    // the CTE definition itself is what actually exercises the guard.
    const c = compileFunnel({ ...base2, peopleAt: { step: 1, mode: 'reached', select: 'members' } })
    expect(c.sql).toContain('trait_total')
    expect(c.sql).toContain('person_traits')
    expect(c.sql).toContain('first_seen')
    expect(c.sql).toContain('entered_at')
    expect(c.sql).toContain('base AS (')
    expect(c.sql).toContain('LEFT JOIN base USING (person_id)')
  })

  it('keeps the keyset lexicographic in both modes', () => {
    // Collapsing to `entered_at <` alone skips every remaining person sharing
    // the boundary row's instant -- silently, and only under load.
    for (const mode of ['reached', 'dropped'] as const) {
      const c = compileFunnel({
        ...base2,
        peopleAt: {
          step: 1,
          mode,
          select: 'ids',
          cursor: {
            lastSeen: '2026-08-20 00:00:00.000',
            personId: 'p9',
            asOf: '2026-08-21T00:00:00.000Z',
          },
        },
      })
      expect(c.sql).toContain('entered_at <')
      expect(c.sql).toContain('OR (entered_at =')
    }
  })

  it('compiles a count shape with no cursor, no joins and no LIMIT', () => {
    // The next task's count must be computed in the SAME request as the
    // page, never taken from the funnel run's own steps[i].people -- which
    // was computed at a different instant. This is the single predicate
    // that feature turns on, so the count branch must reuse it rather than
    // duplicate it.
    const c = compileFunnel({
      ...base2,
      peopleAt: {
        step: 1,
        mode: 'reached',
        select: 'count',
        cursor: {
          lastSeen: '2026-08-20 00:00:00.000',
          personId: 'p9',
          asOf: '2026-08-21T00:00:00.000Z',
        },
      },
    })
    expect(c.sql).toContain('SELECT count() AS person_count')
    expect(c.sql).toMatch(/level >= \{p\d+:UInt32\}/)
    expect(c.sql).not.toContain('person_traits')
    // The dedup idiom's own `LIMIT 1 BY ...` is unrelated and legitimately
    // present -- what must be absent is a PAGE limit.
    expect(c.sql).not.toMatch(/LIMIT \d+\s*$/)
    expect(c.sql).not.toContain('ORDER BY')
    // The cursor must be ignored entirely for a count -- no keyset, no join.
    expect(c.sql).not.toContain('entered_at <')
    expect(c.sql).not.toContain("'2026-08-20 00:00:00.000'")
  })
})

describe('optional steps', () => {
  const base = {
    projectId: 7,
    database: 'lyraflow',
    range: { since: new Date('2026-08-01T00:00:00Z'), until: new Date('2026-08-08T00:00:00Z') },
    now: new Date('2026-08-08T00:00:00Z'),
  }
  const withOptional = {
    steps: [{ event: 'a' }, { event: 'b' }, { event: 'c', optional: true }, { event: 'd' }],
    window_seconds: 3600,
  }

  it('compiles a funnel with no optional steps byte-identically to before', () => {
    // The guarantee that makes the definition-version bump bookkeeping
    // rather than a migration. Every saved funnel in the product is this
    // shape.
    const plain = { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 }
    const q = compileFunnel({ ...base, definition: plain })
    expect(q.sql).not.toContain('branch_')
    expect(q.sql).not.toContain('optional_')
    expect((q.sql.match(/windowFunnel/g) ?? []).length).toBe(1)
  })

  it('emits one branch aggregate per optional step', () => {
    const q = compileFunnel({ ...base, definition: withOptional })
    expect((q.sql.match(/windowFunnel/g) ?? []).length).toBe(2)
    expect(q.sql).toContain('AS branch_0')
    expect(q.sql).not.toContain('AS branch_1')
  })

  it('leaves the optional step out of the spine aggregate', () => {
    // The spine is a, b, d. If `c` appeared in it, skipping `c` would still
    // disqualify a person from `d` and the feature would not exist.
    //
    // Found by looking up whichever placeholder `c` was bound to, never by
    // assuming a number: `Params` is positional and every insertion above
    // shifts it.
    const q = compileFunnel({ ...base, definition: withOptional })
    const cName = Object.keys(q.params).find((k) => q.params[k] === 'c')
    expect(cName).toBeDefined()
    const spineLine = q.sql.split('\n').find((l) => l.includes('AS level')) ?? ''
    const branchLine = q.sql.split('\n').find((l) => l.includes('AS branch_0')) ?? ''
    expect(spineLine).not.toContain(`{${cName}:String}`)
    expect(branchLine).toContain(`{${cName}:String}`)
  })

  it('counts the optional step in the histogram at its branch level', () => {
    // c branches off b, spine rank 2, so its chain must reach level 3.
    const q = compileFunnel({ ...base, definition: withOptional })
    const bound = q.sql.match(/countIf\(branch_0 >= \{(p\d+):UInt32\}\) AS optional_0/)?.[1] ?? ''
    expect(bound).not.toBe('')
    expect(q.params[bound]).toBe(3)
  })

  it('carries the entry bound into the branch chain, not only the spine', () => {
    // Step 1 is the first condition of EVERY chain. Without the bound a
    // person could enter a branch outside the range the caller asked about.
    const q = compileFunnel({ ...base, definition: withOptional })
    const perPerson = q.sql.slice(q.sql.indexOf('windowFunnel'))
    const bounded = perPerson.match(/AND timestamp < \{p\d+:DateTime64\(3\)\}\)/g) ?? []
    // Once in the spine chain, once in the branch chain, once in the minIf.
    expect(bounded.length).toBeGreaterThanOrEqual(3)
  })

  it('selects the people who reached an optional step from its branch chain', () => {
    const q = compileFunnel({
      ...base,
      definition: withOptional,
      peopleAt: { step: 3, mode: 'reached', select: 'ids' },
    })
    expect(q.sql).toContain('branch_0 >=')
    expect(q.sql).not.toContain('level >=')
    const bound = q.sql.match(/branch_0 >= \{(p\d+):UInt32\}/)?.[1] ?? ''
    expect(bound).not.toBe('')
    // c branches off b, spine rank 2, so reaching the branch means level 3.
    expect(q.params[bound]).toBe(3)
  })

  it('selects the people who SKIPPED an optional step from both chains', () => {
    // Reached the branch point and did not do the step. Needs the spine to
    // say they got that far and the branch to say they went no further.
    const q = compileFunnel({
      ...base,
      definition: withOptional,
      peopleAt: { step: 3, mode: 'skipped', select: 'ids' },
    })
    expect(q.sql).toContain('level >=')
    expect(q.sql).toContain('branch_0 <')
    const levelBound = q.sql.match(/level >= \{(p\d+):UInt32\}/)?.[1] ?? ''
    const branchBound = q.sql.match(/branch_0 < \{(p\d+):UInt32\}/)?.[1] ?? ''
    expect(levelBound).not.toBe('')
    expect(branchBound).not.toBe('')
    // Reached spine rank 2 (a, b) and did not also reach branch level 3 (c).
    expect(q.params[levelBound]).toBe(2)
    expect(q.params[branchBound]).toBe(3)
  })

  it('reads a required step after an optional one by its spine rank', () => {
    // `d` is definition step 4 and spine rank 3. Compiling `level >= 4`
    // would return nobody, on a query that runs and looks fine.
    const q = compileFunnel({
      ...base,
      definition: withOptional,
      peopleAt: { step: 4, mode: 'reached', select: 'ids' },
    })
    expect(q.sql).toContain('level >=')
    const bound = q.sql.match(/level >= \{(p\d+):UInt32\}/)?.[1] ?? ''
    expect(q.params[bound]).toBe(3)
  })

  it('binds every branch level and event, concatenating nothing', () => {
    const q = compileFunnel({ ...base, definition: withOptional })
    expect(q.sql).not.toContain("'c'")
    expect(q.sql).not.toMatch(/branch_\d+ >= \d/)
  })

  it('emits one full chain per optional step, alongside its branch chain', () => {
    const q = compileFunnel({ ...base, definition: withOptional })
    // spine + branch_0 + full_0
    expect((q.sql.match(/windowFunnel/g) ?? []).length).toBe(3)
    expect(q.sql).toContain('AS full_0')
    expect(q.sql).not.toContain('AS full_1')
  })

  it('carries the full chain through to the NEXT required step', () => {
    // [a, b, c(optional), d] -- full_0 must be a, b, c, d and reach level 4.
    const q = compileFunnel({ ...base, definition: withOptional })
    const line = q.sql.split('\n').find((l) => l.includes('AS full_0')) ?? ''
    for (const event of ['a', 'b', 'c', 'd']) {
      const name = Object.keys(q.params).find((key) => q.params[key] === event)
      expect(name).toBeDefined()
      expect(line).toContain(`{${name}:String}`)
    }
  })

  it('counts continued at the full chain length, bound as a value', () => {
    const q = compileFunnel({ ...base, definition: withOptional })
    const m = q.sql.match(/countIf\(full_0 >= \{(p\d+):UInt32\}\) AS continued_0/)
    expect(m).not.toBeNull()
    expect(q.params[m?.[1] ?? '']).toBe(4)
  })

  it('leaves a funnel with no optional steps at exactly one windowFunnel', () => {
    const plain = { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 }
    const q = compileFunnel({ ...base, definition: plain })
    expect((q.sql.match(/windowFunnel/g) ?? []).length).toBe(1)
    expect(q.sql).not.toContain('full_')
    expect(q.sql).not.toContain('continued_')
  })

  it('carries the entry bound into the full chain as well', () => {
    const q = compileFunnel({ ...base, definition: withOptional })
    const line = q.sql.split('\n').find((l) => l.includes('AS full_0')) ?? ''
    expect(line).toMatch(/AND timestamp < \{p\d+:DateTime64\(3\)\}\)/)
  })
})
