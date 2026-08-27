import { describe, expect, it } from 'vitest'
import type { FunnelStep } from '../../api/types.js'
import {
  formatCount,
  formatPercent,
  formatRangeDays,
  formatRelative,
  rangeDays,
  rangePhrase,
  stepChain,
  stepLabel,
} from './format.js'

describe('formatPercent', () => {
  it('renders a server rate as one decimal place', () => {
    expect(formatPercent(0.4078)).toBe('40.8%')
  })
  it('renders exact zero as 0%, never NaN or an em dash', () => {
    expect(formatPercent(0)).toBe('0%')
  })
  it('renders 1 as 100%', () => {
    expect(formatPercent(1)).toBe('100%')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-08-15T12:00:00.000Z')
  it('states the value, not merely a shape', () => {
    expect(formatRelative('2026-08-15T11:58:00.000Z', now)).toBe('2 minutes ago')
  })
  it('handles a run older than a day', () => {
    expect(formatRelative('2026-08-13T12:00:00.000Z', now)).toBe('2 days ago')
  })
})

describe('formatRangeDays', () => {
  it('states the resolved range, from the range itself, not a day count typed elsewhere', () => {
    expect(
      formatRangeDays({ since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' }),
    ).toBe('Last 7 days')
  })

  it('singularises a one-day range', () => {
    expect(
      formatRangeDays({ since: '2026-08-14T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' }),
    ).toBe('Last 1 day')
  })

  it('is not fooled by an unparseable timestamp into a numeric-looking lie', () => {
    expect(formatRangeDays({ since: 'not-a-date', until: '2026-08-15T00:00:00.000Z' })).toBe(
      'unknown range',
    )
  })
})

describe('stepLabel', () => {
  it('is the bare event name when the step is not narrowed', () => {
    expect(stepLabel({ event: 'signup_started' })).toBe('signup_started')
    expect(stepLabel({ event: 'signup_started', where: [] })).toBe('signup_started')
  })

  it('reads a narrowed step in the operator words, bracketed', () => {
    expect(
      stepLabel({
        event: 'page_view',
        where: [
          { property: 'page', operator: '=', value: 'changelog' },
          { property: 'duration_ms', operator: '>=', value: 30 },
        ],
      }),
    ).toBe('page_view (where page is changelog, duration_ms at least 30)')
  })

  it('spells the operator the way the builder does, never the AST symbol', () => {
    // Two operators, neither of them `=`: a fixture whose only operator is
    // `=` cannot tell "is" from a passed-through symbol.
    const label = stepLabel({
      event: 'purchase',
      where: [
        { property: 'currency', operator: '!=', value: 'USD' },
        { property: 'amount', operator: '<=', value: 50 },
      ],
    })
    expect(label).toContain('currency is not USD')
    expect(label).toContain('amount at most 50')
    expect(label).not.toContain('!=')
    expect(label).not.toContain('<=')
  })

  it('marks an optional step, the other way two funnels can read alike and measure differently', () => {
    // Same events in the same order with step 2 optional is a DIFFERENT
    // population -- the people who skipped it still reach step 3 -- and the
    // funnels list renders both through this one function. The same
    // ambiguity the predicates were added here to remove.
    expect(stepLabel({ event: 'docs_view', optional: true })).toBe('docs_view (optional)')
    expect(
      stepLabel({
        event: 'docs_view',
        optional: true,
        where: [{ property: 'page', operator: '=', value: 'changelog' }],
      }),
    ).toBe('docs_view (optional) (where page is changelog)')
    // A required step is untouched, so the marker means what it says.
    expect(stepLabel({ event: 'docs_view' })).toBe('docs_view')
  })
})

describe('stepChain', () => {
  const STEPS: FunnelStep[] = [
    {
      event: 'page_view',
      where: [
        { property: 'page', operator: '=', value: 'changelog' },
        { property: 'duration_ms', operator: '>=', value: 30 },
      ],
    },
    {
      event: 'signup_started',
      where: [
        { property: 'plan', operator: '!=', value: 'free' },
        { property: 'seats', operator: 'between', value: [2, 10] },
      ],
    },
    { event: 'signup_completed' },
  ]

  it('renders each step with its OWN predicates, in order', () => {
    // Two narrowed steps, two predicates each: one narrowed step cannot
    // tell "each step's own" from "the first step's, everywhere".
    expect(stepChain(STEPS)).toBe(
      'page_view (where page is changelog, duration_ms at least 30) → ' +
        'signup_started (where plan is not free, seats between 2 and 10) → ' +
        'signup_completed',
    )
  })

  it("closes every clause, so no predicate can be read as the next step's", () => {
    // The hazard the segments summary was already bitten by: a `where` list
    // is comma-separated with no terminator, so an unbracketed clause
    // absorbs whatever follows it. Every arrow must sit OUTSIDE a bracket
    // pair -- checked by counting, not by eye.
    const chain = stepChain(STEPS)
    for (const segment of chain.split(' → ')) {
      const opens = (segment.match(/\(/g) ?? []).length
      const closes = (segment.match(/\)/g) ?? []).length
      expect(opens, segment).toBe(closes)
    }
    expect(chain).toContain('at least 30) → signup_started')
  })

  it('renders a chain of un-narrowed steps exactly as it always did', () => {
    expect(stepChain([{ event: 'a' }, { event: 'b' }])).toBe('a → b')
  })
})

describe('rangePhrase', () => {
  it('reads inside a sentence, where the label does not', () => {
    // `formatRangeDays` is a label and is capitalised. Dropped mid-sentence it
    // produces "Showing Last 7 days", which is the reason this exists.
    expect(rangePhrase(7)).toBe('the last 7 days')
    expect(`Showing ${rangePhrase(30)}.`).toBe('Showing the last 30 days.')
  })

  it('says "the last day", not "the last 1 day"', () => {
    // The picker says "Last 1 day" because a list wants parallel options. A
    // sentence wants grammar.
    expect(rangePhrase(1)).toBe('the last day')
  })

  it('carries an unparseable range through as words rather than as null', () => {
    expect(rangePhrase(null)).toBe('an unknown range')
    expect(rangePhrase(rangeDays({ since: 'nonsense', until: 'also nonsense' }))).toBe(
      'an unknown range',
    )
  })

  it('counts the same days the label counts', () => {
    // Split from formatRangeDays precisely so the two cannot drift; a range
    // described one way in a label and another in a sentence is worse than
    // either alone.
    const range = { since: '2026-08-01T00:00:00Z', until: '2026-08-08T00:00:00Z' }
    expect(rangeDays(range)).toBe(7)
    expect(formatRangeDays(range)).toContain('7')
    expect(rangePhrase(rangeDays(range))).toContain('7')
  })
})
