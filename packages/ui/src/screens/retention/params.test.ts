import { describe, expect, it } from 'vitest'
import {
  DEFAULTS,
  MAX_PERIODS,
  incompletePredicates,
  readRetentionParams,
  toRequest,
  writeRetentionParams,
} from './params.js'

const read = (qs: string) => readRetentionParams(new URLSearchParams(qs))
const write = (p: Parameters<typeof writeRetentionParams>[1]) =>
  writeRetentionParams(new URLSearchParams(), p).toString()

describe('readRetentionParams', () => {
  it('reads a full definition', () => {
    expect(read('start=signed_up&return=project_created&granularity=day&periods=12')).toEqual({
      ...DEFAULTS,
      start: 'signed_up',
      return: 'project_created',
      granularity: 'day',
      periods: 12,
    })
  })

  it('falls back to defaults for anything unreadable, rather than failing', () => {
    // A hand-edited or truncated link must open a usable screen. Every one of
    // these is reachable by someone editing the address bar.
    expect(read('granularity=fortnight').granularity).toBe(DEFAULTS.granularity)
    expect(read('periods=0').periods).toBe(DEFAULTS.periods)
    expect(read('periods=-3').periods).toBe(DEFAULTS.periods)
    expect(read('periods=2.5').periods).toBe(DEFAULTS.periods)
    expect(read('periods=abc').periods).toBe(DEFAULTS.periods)
  })

  it('refuses a period count past the cap the API enforces', () => {
    // The control must not be able to ask for a grid the server refuses.
    expect(read(`periods=${MAX_PERIODS + 1}`).periods).toBe(DEFAULTS.periods)
    expect(read(`periods=${MAX_PERIODS}`).periods).toBe(MAX_PERIODS)
  })

  // M4 from the whole-branch review: a bare `Number()` coerces shapes that
  // must not resolve to a segment id -- `0x10` to 16, `1e3` to 1000. Both
  // are exactly as valid-looking to `Number.isSafeInteger` as any other
  // digit string, which is why the fix checks the shape first.
  it('refuses hex and exponent forms, matching numeric-id.ts’s strictness', () => {
    expect(read('segment=0x10').segmentId).toBeNull()
    expect(read('segment=1e3').segmentId).toBeNull()
    // The plain digit string those two would otherwise have coerced from
    // still works.
    expect(read('segment=42').segmentId).toBe(42)
  })
})

describe('writeRetentionParams', () => {
  it('omits anything that equals its default, so the link stays readable', () => {
    expect(write({ ...DEFAULTS })).toBe('')
  })

  it('round-trips a chosen definition', () => {
    const chosen = {
      ...DEFAULTS,
      start: 'signed_up',
      return: 'project_created',
      granularity: 'month' as const,
      periods: 3,
    }
    expect(readRetentionParams(new URLSearchParams(write(chosen)))).toEqual(chosen)
  })

  it('keeps parameters it does not own', () => {
    const out = writeRetentionParams(new URLSearchParams('project=7'), DEFAULTS)
    expect(out.get('project')).toBe('7')
  })
})

describe('where predicates in the URL', () => {
  const WHERE = [
    {
      source: 'attribute' as const,
      attribute: 'path' as const,
      operator: '=' as const,
      value: '/',
    },
  ]

  it('round-trips a predicate list, so a shared link reproduces the same grid', () => {
    // The screen has no store; the URL IS its persistence. A predicate left
    // out of it would mean a link that silently rebuilds a DIFFERENT grid
    // from the one whoever shared it was looking at.
    const out = writeRetentionParams(new URLSearchParams(), { ...DEFAULTS, startWhere: WHERE })
    expect(readRetentionParams(out).startWhere).toEqual(WHERE)
  })

  it('keeps the two sides independent', () => {
    const out = writeRetentionParams(new URLSearchParams(), {
      ...DEFAULTS,
      startWhere: WHERE,
      returnWhere: [],
    })
    const back = readRetentionParams(out)
    expect(back.startWhere).toHaveLength(1)
    expect(back.returnWhere).toHaveLength(0)
  })

  it('writes nothing for an empty list, so an untouched screen has a clean address', () => {
    expect(writeRetentionParams(new URLSearchParams(), DEFAULTS).toString()).toBe('')
  })

  it('degrades to no predicates for anything it cannot validate', () => {
    // Reachable by hand-editing the address bar or truncating a pasted link.
    // Validated through core's own schema per element rather than trusted as
    // parsed JSON, so what survives is definitely compilable.
    expect(readRetentionParams(new URLSearchParams('start_where=not-json')).startWhere).toEqual([])
    expect(readRetentionParams(new URLSearchParams('start_where={}')).startWhere).toEqual([])
    expect(
      readRetentionParams(
        new URLSearchParams(`start_where=${encodeURIComponent('[{"operator":"???"}]')}`),
      ).startWhere,
    ).toEqual([])
  })

  it('keeps the valid members of a partly-broken list', () => {
    const mixed = JSON.stringify([WHERE[0], { nonsense: true }])
    const out = readRetentionParams(new URLSearchParams(`start_where=${encodeURIComponent(mixed)}`))
    expect(out.startWhere).toHaveLength(1)
  })
})

describe('toRequest', () => {
  it('omits an empty where list rather than sending []', () => {
    const body = toRequest(DEFAULTS)
    expect('start_where' in body).toBe(false)
  })

  it('sends the predicates when there are any', () => {
    const body = toRequest({
      ...DEFAULTS,
      startWhere: [{ property: 'p', operator: '=', value: 'x' }],
    })
    expect(body.start_where).toHaveLength(1)
  })
})

describe('a half-built predicate', () => {
  // The bug Cem hit on 2026-08-28: "Add predicate" appeared to do nothing.
  // `WherePredicates` adds `{ property: '', operator: '=', value: '' }`, and
  // `property` is `z.string().min(1)` -- so validating each element against
  // the full schema on the way back OUT of the URL threw the new row away
  // before it could be rendered. The control worked; the round trip ate it.
  const BLANK = { property: '', operator: '=', value: '' }

  it('survives the URL round trip, or the editor can never add one', () => {
    const written = writeRetentionParams(new URLSearchParams(), {
      ...DEFAULTS,
      startWhere: [BLANK as never],
    })
    expect(readRetentionParams(written).startWhere).toHaveLength(1)
  })

  it('is still refused as garbage when it is not predicate-shaped at all', () => {
    // Leniency has to stop somewhere: a hand-edited link full of nonsense
    // must still degrade to no predicates rather than to rows the editor
    // cannot render.
    const junk = encodeURIComponent(JSON.stringify([{ nope: 1 }, 'string', 42, null]))
    expect(readRetentionParams(new URLSearchParams(`start_where=${junk}`)).startWhere).toEqual([])
  })

  it('is reported as incomplete, so Run does not send a request the server refuses', () => {
    // Dropping it silently at request time would run a WIDER grid than the
    // operator built, which is the failure this screen refuses everywhere
    // else.
    expect(incompletePredicates({ ...DEFAULTS, startWhere: [BLANK as never] })).toBe(1)
    expect(
      incompletePredicates({
        ...DEFAULTS,
        startWhere: [{ property: 'plan', operator: '=', value: 'pro' }],
      }),
    ).toBe(0)
  })

  it('counts both sides', () => {
    expect(
      incompletePredicates({
        ...DEFAULTS,
        startWhere: [BLANK as never],
        returnWhere: [BLANK as never],
      }),
    ).toBe(2)
  })
})
