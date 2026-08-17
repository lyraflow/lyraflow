import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { summarise } from './summarise.js'
import { OPERATOR_WORDS, windowPhrase } from './vocabulary.js'

const trait = (key: string) => ({ kind: 'trait', key, operator: '=', value: 'x' }) as const
const group = (...children: unknown[]) => ({ kind: 'group', op: 'and', children }) as const

describe('summarise', () => {
  it('renders a single trait without group chrome', () => {
    expect(summarise(trait('plan') as never)).toBe('plan is x')
  })
  it('joins a group with its operator', () => {
    expect(summarise(group(trait('a'), trait('b')) as never)).toBe('a is x and b is x')
  })
  it('parenthesises a nested group so precedence is not lost in one line', () => {
    const root = { kind: 'group', op: 'or', children: [trait('a'), group(trait('b'), trait('c'))] }
    expect(summarise(root as never)).toBe('a is x or (b is x and c is x)')
  })
  it('renders a behaviour as a readable clause', () => {
    const b = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    expect(summarise(b as never)).toBe('count of checkout in the last 30 days at least 3')
  })
  it('marks a negated node', () => {
    expect(summarise({ kind: 'not', child: trait('a') } as never)).toBe('not (a is x)')
  })

  // --- Mutations invented beyond the tests above --------------------------
  //
  // Every trait/group fixture above uses the same operator ('=') and the
  // same value ('x') on every node, and every top-level test is a
  // two-child group. A `summarise` that swapped `key`/`operator`, hard-coded
  // '=' or 'x', always joined with the literal string 'and', or dropped a
  // node's own value in favour of another node's, would still pass every
  // test above. Distinct operators/values per node, per-node join
  // correctness, and a 3-child group close that gap.

  it('renders each node with its own operator and value, not another node in the tree', () => {
    const root = {
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'trait', key: 'plan', operator: '!=', value: 'free' },
        { kind: 'trait', key: 'age', operator: '>', value: 18 },
      ],
    }
    expect(summarise(root as never)).toBe('plan is not free or age more than 18')
  })

  it('joins a 3-child group with the operator between every pair, not just twice at the ends', () => {
    const root = group(trait('a'), trait('b'), trait('c'))
    expect(summarise(root as never)).toBe('a is x and b is x and c is x')
  })

  it('renders an "or" group distinctly from an "and" group built from the same children', () => {
    const children = [trait('a'), trait('b')]
    const andSummary = summarise({ kind: 'group', op: 'and', children } as never)
    const orSummary = summarise({ kind: 'group', op: 'or', children } as never)
    expect(andSummary).not.toBe(orSummary)
    expect(andSummary).toBe('a is x and b is x')
    expect(orSummary).toBe('a is x or b is x')
  })

  it('renders a non-count behaviour using its own aggregate, property, window unit, operator and value', () => {
    const b = {
      kind: 'behavior',
      event: 'page_view',
      aggregate: 'sum',
      property: 'duration_ms',
      window: { kind: 'last', n: 6, unit: 'hours' },
      operator: '<',
      value: 500,
    }
    expect(summarise(b as never)).toBe(
      'sum of duration_ms of page_view in the last 6 hours less than 500',
    )
  })

  it('renders an "ever" window distinctly from a "last" window', () => {
    const b = {
      kind: 'behavior',
      event: 'signup',
      aggregate: 'count',
      window: { kind: 'ever' },
      operator: '>=',
      value: 1,
    }
    expect(summarise(b as never)).toBe('count of signup at any time at least 1')
  })

  it('renders a context node using its own field, scope and value', () => {
    const c = { kind: 'context', field: 'country', scope: 'latest', operator: '=', value: 'US' }
    expect(summarise(c as never)).toBe('country (latest) is US')
  })

  it('renders a lifecycle node using its own field and value', () => {
    const l = {
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>=',
      value: '2026-01-01T09:00',
    }
    expect(summarise(l as never)).toBe('first_seen at least 1 Jan 2026, 09:00')
  })

  it('negates a group, not just a trait, and still nests it correctly', () => {
    const root = { kind: 'not', child: group(trait('a'), trait('b')) }
    expect(summarise(root as never)).toBe('not (a is x and b is x)')
  })

  it('renders a "between" operator\'s two-value tuple as "X and Y", pinning the phrasing', () => {
    const t = { kind: 'trait', key: 'age', operator: 'between', value: [18, 65] }
    expect(summarise(t as never)).toBe('age between 18 and 65')
  })

  // --- `behavior.where` was previously unexercised ------------------------
  //
  // `grep -n "where" summarise.test.ts` returned nothing before this:
  // the phrasing, the join separator between predicates and the per-
  // predicate format were all unverified. A single-predicate fixture alone
  // would not pin the join, since its rendering is identical whether the
  // predicates are joined with ', ' or concatenated with nothing at all --
  // so the two-predicate case below uses two predicates that differ from
  // each other in every field, so swapping their order or the separator
  // changes the string.

  it('appends a single where predicate as a readable clause', () => {
    const b = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      where: [{ property: 'amount', operator: '>', value: 100 }],
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    expect(summarise(b as never)).toBe(
      'count of checkout in the last 30 days at least 3 where amount more than 100',
    )
  })

  it('joins two or more where predicates with ", ", in order -- not concatenated, not reversed', () => {
    const b = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      where: [
        { property: 'amount', operator: '>', value: 100 },
        { property: 'currency', operator: '=', value: 'USD' },
      ],
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    expect(summarise(b as never)).toBe(
      'count of checkout in the last 30 days at least 3 where amount more than 100, currency is USD',
    )
  })

  it('renders an empty where array the same as no where at all -- no dangling "where"', () => {
    const withEmptyWhere = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      where: [],
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    const withoutWhere = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    const expected = 'count of checkout in the last 30 days at least 3'
    expect(summarise(withEmptyWhere as never)).toBe(expected)
    expect(summarise(withoutWhere as never)).toBe(expected)
    expect(summarise(withEmptyWhere as never)).not.toContain('where')
  })
})

/**
 * The rewording, pinned where it can actually regress.
 *
 * The builder's controls were reworded first and these two screens -- the
 * segments list and the segment detail, both of which render a saved tree
 * through this function -- were not, so an operator read `>=` and the phrase
 * "in ever" on the screens they visit most and English on the one they visit
 * least. The words now come from `vocabulary.ts`; what follows asserts they
 * ARRIVE here, per operator and per window variant, rather than that any one
 * fixture happens to read well.
 *
 * The coincidence point to watch: `between` is a word AND an operator, so a
 * fixture using only `between` renders identically whether this function
 * translates or not. Every loop below therefore runs over all of
 * `COMPARISON_OPERATORS`, and the symbol assertions exclude nothing.
 */
describe('summarise -- the operator’s vocabulary, not the AST’s', () => {
  it('renders every operator core declares as its word, never as its symbol', () => {
    for (const operator of COMPARISON_OPERATORS) {
      // `between` takes two values, every other operator exactly one
      // (`ast.ts`'s own refine), so the fixture follows the schema rather
      // than sending a shape the AST would reject.
      const value = operator === 'between' ? [1, 2] : 1
      const line = summarise({ kind: 'trait', key: 'seats', operator, value } as never)
      expect(line).toContain(OPERATOR_WORDS[operator])
      // The symbols, as a set: an operator rendered raw shows up here even
      // if its own word happens to be a substring of the sentence for
      // another reason.
      for (const symbol of ['=', '!=', '>', '>=', '<', '<=']) {
        expect(line).not.toContain(symbol)
      }
    }
  })

  it('renders a tree carrying every operator at once with a word for each', () => {
    // One tree rather than one node per assertion: this is the shape the
    // screens actually render, and a per-node test cannot catch a rendering
    // that reads one node's operator while formatting another's.
    const root = {
      kind: 'group',
      op: 'and',
      children: COMPARISON_OPERATORS.map((operator, i) => ({
        kind: 'trait',
        key: `k${i}`,
        operator,
        value: operator === 'between' ? [1, 2] : i,
      })),
    }
    const line = summarise(root as never)
    for (const operator of COMPARISON_OPERATORS) {
      expect(line).toContain(OPERATOR_WORDS[operator])
    }
    for (const symbol of ['=', '!=', '>', '>=', '<', '<=']) {
      expect(line).not.toContain(symbol)
    }
  })

  it('never renders the phrase "in ever", for any node shape carrying an unbounded window', () => {
    // The literal string this pin exists for, plus the bare AST kind it came
    // from -- asserted on a behaviour alone, negated, nested in a group, and
    // carrying `where` predicates, because every one of those is a separate
    // return path through this function.
    const behaviour = {
      kind: 'behavior',
      event: 'docs_search',
      aggregate: 'count',
      window: { kind: 'ever' },
      operator: '>=',
      value: 20,
    }
    const shapes = [
      behaviour,
      { kind: 'not', child: behaviour },
      group(trait('a'), behaviour),
      { ...behaviour, where: [{ property: 'q', operator: '!=', value: '' }] },
      { ...behaviour, aggregate: 'sum', property: 'amount' },
    ]
    for (const node of shapes) {
      const line = summarise(node as never)
      expect(line).not.toContain('in ever')
      expect(line).not.toMatch(/\bever\b/)
      expect(line).toContain('at any time')
    }
  })

  it('phrases every window variant exactly as the shared vocabulary does', () => {
    // Compared against `windowPhrase` rather than against literals here: what
    // must hold is that this function reads the ONE list, so a second copy
    // added to this file later fails rather than merely disagreeing with a
    // string frozen in a test.
    const windows = [
      { kind: 'last', n: 90, unit: 'days' },
      { kind: 'last', n: 12, unit: 'hours' },
      { kind: 'absolute', from: '2026-07-01T09:00', to: '2026-08-15T18:30' },
      { kind: 'ever' },
    ]
    for (const window of windows) {
      const line = summarise({
        kind: 'behavior',
        event: 'purchase',
        aggregate: 'count',
        window,
        operator: '>=',
        value: 1,
      } as never)
      expect(line).toContain(windowPhrase(window as never))
      // And no ISO chrome survives into the sentence.
      expect(line).not.toContain('T09:00')
      expect(line).not.toContain('.000Z')
    }
  })

  it('renders an absolute window with no raw ISO string and no doubled "between"', () => {
    const b = {
      kind: 'behavior',
      event: 'checkout_started',
      aggregate: 'sum',
      property: 'amount',
      window: { kind: 'absolute', from: '2026-07-01T09:00', to: '2026-08-15T18:30' },
      operator: 'between',
      value: [100, 5000],
    }
    // The whole line, because this is the one fixture where the window's own
    // phrasing and the comparison operator could collide: rendered as
    // "between X and Y ... between 100 and 5000", neither `between` can be
    // told from the other.
    expect(summarise(b as never)).toBe(
      'sum of amount of checkout_started from 1 Jul 2026, 09:00 to 15 Aug 2026, 18:30 between 100 and 5000',
    )
  })

  it('renders a lifecycle bound as a date a person reads, not as a stored instant', () => {
    const l = {
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>=',
      value: '2026-06-01T00:00:00.000Z',
    }
    const line = summarise(l as never)
    expect(line).not.toContain('2026-06-01T00:00:00.000Z')
    expect(line).not.toContain('.000Z')
    expect(line).toContain('Jun 2026')
    expect(line).toContain('at least')
  })

  it('renders both bounds of a `between` lifecycle condition, each as a date', () => {
    // The value is a two-slot tuple for this one operator, and a conversion
    // applied only to the scalar case would leave these two raw.
    const l = {
      kind: 'lifecycle',
      field: 'last_seen',
      operator: 'between',
      value: ['2026-06-01T09:00', '2026-07-01T18:30'],
    }
    expect(summarise(l as never)).toBe('last_seen between 1 Jun 2026, 09:00 and 1 Jul 2026, 18:30')
  })

  it('leaves a trait value that merely looks like a date exactly as stored', () => {
    // A trait value is arbitrary operator data. Reformatting one would be
    // this module inventing a type for it -- and would rewrite a value the
    // operator can see in the builder's own text box.
    const t = { kind: 'trait', key: 'cohort', operator: '=', value: '2026-06-01T00:00:00.000Z' }
    expect(summarise(t as never)).toBe('cohort is 2026-06-01T00:00:00.000Z')
  })
})

/**
 * **In UTC this describe proves nothing**, which is why it pins `TZ` the way
 * `datetime.test.ts` does: where local IS UTC, a bound rendered through the
 * store-UTC/display-local rule and one rendered straight off the stored string
 * agree on every fixture, so an unconverted summary would pass.
 */
describe('summarise -- a stored instant, read in the operator’s own zone', () => {
  beforeAll(() => {
    vi.stubEnv('TZ', 'Asia/Kolkata')
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
    expect(new Date('2026-07-01T09:00').toISOString()).toBe('2026-07-01T03:30:00.000Z')
  })

  it('shows an absolute window’s bounds in local time, as the builder’s picker does', () => {
    const b = {
      kind: 'behavior',
      event: 'purchase',
      aggregate: 'count',
      window: {
        kind: 'absolute',
        from: '2026-07-01T03:30:00.000Z',
        to: '2026-07-31T20:30:00.000Z',
      },
      operator: '>=',
      value: 1,
    }
    // 03:30Z is 09:00 locally; 20:30Z on 31 Jul is 02:00 on 1 Aug locally.
    expect(summarise(b as never)).toBe(
      'count of purchase from 1 Jul 2026, 09:00 to 1 Aug 2026, 02:00 at least 1',
    )
  })

  it('shows a lifecycle bound in local time too', () => {
    const l = {
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>=',
      value: '2026-07-01T03:30:00.000Z',
    }
    expect(summarise(l as never)).toBe('first_seen at least 1 Jul 2026, 09:00')
  })
})

describe('summarise -- a clause never swallows the tree’s own join word', () => {
  // Every one of these renders an ` and ` that belongs to the CHILD. Without
  // brackets around that child, the group's own ` and `/` or ` lands directly
  // after it and a reader cannot tell which is which -- and this string is the
  // only place most operators ever read a definition back, so misreading it
  // means acting on the wrong population.
  //
  // All three shapes appeared together in one real segment on the list screen,
  // and only the nested-group case was handled.

  it('brackets a behaviour carrying a where clause', () => {
    const out = summarise({
      kind: 'group',
      op: 'and',
      children: [
        {
          kind: 'behavior',
          event: 'purchase',
          aggregate: 'count',
          operator: '>=',
          value: 3,
          window: { kind: 'last', n: 90, unit: 'days' },
          where: [
            { property: 'currency', operator: '=', value: 'USD' },
            { property: 'amount', operator: '>', value: 50 },
          ],
        },
        { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      ],
    })
    // The where list must close before the tree's `and`.
    expect(out).toContain('amount more than 50) and plan is pro')
    // And the ambiguous reading must be gone outright.
    expect(out).not.toContain('amount more than 50 and plan')
  })

  it('brackets a between condition, whose value is itself joined by "and"', () => {
    // `formatValue` renders a two-element value as "100 and 5000", so a bare
    // `between` child puts two `and`s in a row doing different jobs.
    const out = summarise({
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'trait', key: 'seats', operator: 'between', value: [100, 5000] },
        { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      ],
    })
    expect(out).toContain('(seats between 100 and 5000) and plan is pro')
    expect(out).not.toContain('5000 and plan is pro')
  })

  it('brackets a between condition inside an or, where the misreading changes the segment', () => {
    // With `or` the stakes are visible: unbracketed, "seats between 100 and
    // 5000 or plan is pro" could be read as "between 100" and "(5000 or plan
    // is pro)".
    const out = summarise({
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'trait', key: 'seats', operator: 'between', value: [100, 5000] },
        { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      ],
    })
    expect(out).toBe('(seats between 100 and 5000) or plan is pro')
  })

  it('leaves a self-delimiting child alone, so brackets stay meaningful', () => {
    // The counter-half: bracketing everything would be as unreadable as
    // bracketing nothing. A plain leaf, and a `not` (which already renders its
    // own parentheses), must not gain a second pair.
    const out = summarise({
      kind: 'group',
      op: 'and',
      children: [
        { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
        { kind: 'not', child: { kind: 'trait', key: 'is_trial', operator: '=', value: true } },
      ],
    })
    expect(out).toBe('plan is pro and not (is_trial is true)')
  })

  it('does not bracket a top-level behaviour with a where clause', () => {
    // `part` is only reached inside a group's join. A definition that IS one
    // behaviour has nothing following it, so an outer pair would be noise --
    // the same reason a top-level group renders as its bare join.
    const out = summarise({
      kind: 'behavior',
      event: 'purchase',
      aggregate: 'count',
      operator: '>=',
      value: 1,
      window: { kind: 'ever' },
      where: [{ property: 'amount', operator: '>', value: 50 }],
    })
    expect(out).not.toMatch(/^\(/)
    expect(out).toContain('where amount more than 50')
  })
})
