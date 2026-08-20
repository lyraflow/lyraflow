import { describe, expect, it } from 'vitest'
import {
  AST_VERSION,
  CONTEXT_FIELDS,
  EVENT_COLUMN_FIELDS,
  LIFECYCLE_FIELDS,
  Lifecycle,
  SegmentQuery,
  WherePredicate,
} from './ast.js'

const trait = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }

describe('SegmentQuery', () => {
  it("accepts the spec's worked example", () => {
    // "trial users who ran import at least 3 times in the last 7 days but
    //  never invited a teammate"
    const parsed = SegmentQuery.safeParse({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [
          trait,
          {
            kind: 'behavior',
            event: 'import_started',
            aggregate: 'count',
            operator: '>=',
            value: 3,
            window: { kind: 'last', n: 7, unit: 'days' },
          },
          {
            kind: 'not',
            child: {
              kind: 'behavior',
              event: 'invite_teammate',
              aggregate: 'count',
              operator: '>=',
              value: 1,
              window: { kind: 'ever' },
            },
          },
        ],
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('pins AST_VERSION so saved trees cannot be orphaned silently', () => {
    expect(AST_VERSION).toBe(1)
    expect(SegmentQuery.safeParse({ ast_version: 2, filter: trait }).success).toBe(false)
  })

  it('requires a property for numeric aggregates and forbids it for count', () => {
    const beh = (extra: Record<string, unknown>) =>
      SegmentQuery.safeParse({
        ast_version: 1,
        filter: {
          kind: 'behavior',
          event: 'purchase',
          operator: '>',
          value: 100,
          window: { kind: 'ever' },
          ...extra,
        },
      }).success

    expect(beh({ aggregate: 'sum', property: 'amount' })).toBe(true)
    expect(beh({ aggregate: 'sum' })).toBe(false) // sum of what?
    expect(beh({ aggregate: 'count', property: 'amount' })).toBe(false) // count of what?
    expect(beh({ aggregate: 'count' })).toBe(true)
  })

  it('requires two values for `between` and one otherwise', () => {
    const life = (operator: string, value: unknown) =>
      SegmentQuery.safeParse({
        ast_version: 1,
        filter: { kind: 'lifecycle', field: 'first_seen', operator, value },
      }).success

    expect(life('between', ['2026-01-01', '2026-02-01'])).toBe(true)
    expect(life('between', '2026-01-01')).toBe(false)
    expect(life('>', '2026-01-01')).toBe(true)
    expect(life('>', ['2026-01-01', '2026-02-01'])).toBe(false)
  })

  it('rejects a context scope it does not know', () => {
    expect(
      SegmentQuery.safeParse({
        ast_version: 1,
        filter: {
          kind: 'context',
          field: 'country',
          scope: 'sometimes',
          operator: '=',
          value: 'DE',
        },
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown context field, because fields are column names', () => {
    // Context fields become column identifiers, which cannot be bound
    // parameters. The allowlist is the injection boundary.
    expect(
      SegmentQuery.safeParse({
        ast_version: 1,
        filter: {
          kind: 'context',
          field: 'country; DROP TABLE events',
          scope: 'latest',
          operator: '=',
          value: 'DE',
        },
      }).success,
    ).toBe(false)
  })

  it('accepts arbitrary nesting', () => {
    let node: unknown = trait
    for (let i = 0; i < 5; i++) node = { kind: 'group', op: 'or', children: [node] }
    expect(SegmentQuery.safeParse({ ast_version: 1, filter: node }).success).toBe(true)
  })
})

describe('LIFECYCLE_FIELDS', () => {
  // What this pins is that the schema is BUILT from the array rather than
  // written out beside it. It cannot catch a re-inlined enum that happens to
  // spell the same two values -- nothing can, short of reading the source
  // text -- but that is not the failure worth defending against. The one
  // that shipped for two releases was an inline enum and a hand-written copy
  // in a .tsx file two packages away, both correct, neither able to see the
  // other change. Any divergence now fails here.
  it('is exactly the field set the schema accepts', () => {
    // Read off the REJECTION rather than out of the schema object. zod's
    // `invalid_enum_value` issue carries the options it checked against,
    // which is the enum's own answer to "what would you have taken" -- and
    // it survives the `.and()` and `.refine()` this schema is wrapped in,
    // where reaching for `.innerType().shape` does not.
    const r = Lifecycle.safeParse({
      kind: 'lifecycle',
      field: 'nope',
      operator: '>',
      value: '2026-08-01T00:00:00Z',
    })
    expect(r.success).toBe(false)
    const issue = r.success
      ? undefined
      : r.error.issues.find((i) => i.code === 'invalid_enum_value' && i.path[0] === 'field')
    expect(issue, 'the field is no longer a closed enum').toBeDefined()
    expect([...(issue as { options: string[] }).options].sort()).toEqual(
      [...LIFECYCLE_FIELDS].sort(),
    )
  })

  it('accepts every field it names, and nothing else', () => {
    for (const f of LIFECYCLE_FIELDS) {
      const node = { kind: 'lifecycle', field: f, operator: '>', value: '2026-08-01T00:00:00Z' }
      expect(Lifecycle.safeParse(node).success, f).toBe(true)
    }
    // `created_at` is the name someone reaches for first, and it is not a
    // column the base CTE produces.
    expect(
      Lifecycle.safeParse({
        kind: 'lifecycle',
        field: 'created_at',
        operator: '>',
        value: '2026-08-01T00:00:00Z',
      }).success,
    ).toBe(false)
  })

  it('lists each name once', () => {
    expect(new Set(LIFECYCLE_FIELDS).size).toBe(LIFECYCLE_FIELDS.length)
  })
})

describe('EVENT_COLUMN_FIELDS', () => {
  it('contains every context field, so the two lists cannot diverge', () => {
    for (const field of CONTEXT_FIELDS) {
      expect(EVENT_COLUMN_FIELDS).toContain(field)
    }
  })

  it('names the per-event columns no context condition can read back', () => {
    // The four that prompted the whole list. `path` in particular is the
    // first predicate a new operator writes, and the one that returns zero
    // with no explanation; a list built only from CONTEXT_FIELDS would miss
    // exactly it.
    for (const field of ['path', 'url', 'utm_term', 'utm_content']) {
      expect(EVENT_COLUMN_FIELDS).toContain(field)
      expect(CONTEXT_FIELDS).not.toContain(field)
    }
  })

  it('lists each name once', () => {
    expect(new Set(EVENT_COLUMN_FIELDS).size).toBe(EVENT_COLUMN_FIELDS.length)
  })

  it('does not make any of these names invalid to write as a predicate', () => {
    // Informational, never a validation rule: `properties` comes from the
    // caller's own bag and `path` from `context`, so a property genuinely
    // named `path` exists and its predicate is a real one.
    expect(
      WherePredicate.safeParse({ property: 'path', operator: '=', value: '/changelog' }).success,
    ).toBe(true)
  })
})
