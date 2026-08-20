import { COMPARISON_OPERATORS, Window } from '@lyraflow/core/segments/ast.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { toPickerValue } from './datetime.js'
import {
  OPERATOR_OPTIONS,
  OPERATOR_WORDS,
  WINDOW_KIND_OPTIONS,
  formatBound,
  formatValue,
  operatorWord,
  wherePhrase,
  windowPhrase,
} from './vocabulary.js'

/**
 * Every symbol `COMPARISON_OPERATORS` holds, as a pattern -- used to assert
 * that no rendering leaks one. `between` is deliberately absent: it is a word
 * AND an operator, legitimately, so a test that demanded every word differ
 * from its symbol would need an exception for it and would then be blind to a
 * raw `<=` as well.
 */
const SYMBOLS = ['=', '!=', '>', '>=', '<', '<=']

describe('OPERATOR_OPTIONS', () => {
  it('covers every operator core declares, in core’s own order', () => {
    // Driven off `COMPARISON_OPERATORS`, so an operator added there and not
    // given a word cannot quietly go missing from the list either.
    expect(OPERATOR_OPTIONS.map((o) => o.value)).toEqual([...COMPARISON_OPERATORS])
  })

  it('gives every operator a word, and never falls back to the raw symbol', () => {
    // The failure this exists to catch is silent by construction: an
    // operator with no word renders as `>=` beside six that read as
    // English, which looks like a styling slip rather than a missing entry.
    // `tsc` refuses the missing key first (the words are an exhaustive
    // `Record`), and this is the half a test can see.
    for (const { label } of OPERATOR_OPTIONS) {
      expect(label).toMatch(/^[a-z ]+$/)
    }
    // ...and the pattern really does reject the symbols it is meant to.
    for (const symbol of SYMBOLS) {
      expect(symbol).not.toMatch(/^[a-z ]+$/)
    }
  })

  it('leaves every option’s stored value exactly as the AST spells it', () => {
    expect(OPERATOR_OPTIONS.map((o) => o.value)).toEqual([
      '=',
      '!=',
      '>',
      '>=',
      '<',
      '<=',
      'between',
    ])
  })
})

describe('operatorWord', () => {
  it('is the same word the control offers, for every operator core declares', () => {
    // The point of the module: one lookup, so a summary and a `<select>`
    // cannot name the same operator differently. Compared against
    // `OPERATOR_OPTIONS` rather than against a second literal list here,
    // which would be a third spelling of the same thing.
    for (const { value, label } of OPERATOR_OPTIONS) {
      expect(operatorWord(value)).toBe(label)
      expect(operatorWord(value)).toBe(OPERATOR_WORDS[value])
    }
  })

  it('hands back a value that is not an operator at all, rather than the word `undefined`', () => {
    // Reachable only from stored data: `summarise` renders a wire `filter`
    // cast to `FilterNode`, so its operator is not guaranteed by the type
    // system. A bare index would render "plan undefined paid".
    expect(operatorWord('eq')).toBe('eq')
    expect(operatorWord('')).toBe('')
  })
})

describe('WINDOW_KIND_OPTIONS', () => {
  it('covers every window kind the AST declares, in the AST’s own order', () => {
    // Read off the compiled schema rather than a literal list -- core
    // exports no named array of window kinds, and a hand-written one here
    // could omit a variant added there without anything going red.
    const declared = Window.options.map((o) => o.shape.kind.value)
    expect(WINDOW_KIND_OPTIONS.map((o) => o.kind)).toEqual(declared)
  })

  it('names each variant in words, never as the AST’s own kind', () => {
    for (const { kind, label } of WINDOW_KIND_OPTIONS) {
      expect(label).not.toBe(kind)
    }
    // `ever` is the one that mattered: the summary used to render it as
    // `in ${kind}`, i.e. "in ever".
    const ever = WINDOW_KIND_OPTIONS.find((o) => o.kind === 'ever')
    expect(ever?.label).toBe('any time')
    expect(ever?.label).not.toMatch(/\bever\b/)
  })
})

describe('windowPhrase', () => {
  it('reads as English for an unbounded window -- never the AST’s `ever`', () => {
    expect(windowPhrase({ kind: 'ever' })).toBe('at any time')
    expect(windowPhrase({ kind: 'ever' })).not.toMatch(/\bever\b/)
  })

  it('states a bounded window with its own amount and unit', () => {
    expect(windowPhrase({ kind: 'last', n: 90, unit: 'days' })).toBe('in the last 90 days')
    // Distinct per field: a phrase that hard-coded either would pass a
    // single fixture.
    expect(windowPhrase({ kind: 'last', n: 6, unit: 'hours' })).toBe('in the last 6 hours')
  })

  it('reads an absolute range as `from … to …`, not `between … and …`', () => {
    // Not a preference. `between` is also a comparison operator, and a
    // behaviour carrying both renders one sentence with two `between`s and
    // three `and`s in it, where neither `between` can be told from the
    // other. Pinned with a zone-less reading so this assertion is about the
    // phrasing rather than about the test host's zone.
    const phrase = windowPhrase({
      kind: 'absolute',
      from: '2026-07-01T09:00',
      to: '2026-08-15T18:30',
    })
    expect(phrase).toBe('from 1 Jul 2026, 09:00 to 15 Aug 2026, 18:30')
    expect(phrase).not.toContain('between')
  })

  it('renders each bound from its own field -- not the same bound twice', () => {
    const phrase = windowPhrase({
      kind: 'absolute',
      from: '2026-07-01T09:00',
      to: '2026-08-15T18:30',
    })
    expect(phrase).toContain('1 Jul 2026, 09:00')
    expect(phrase).toContain('15 Aug 2026, 18:30')
  })
})

describe('formatBound -- a wall-clock reading', () => {
  it('names the month and drops the ISO chrome entirely', () => {
    expect(formatBound('2026-07-01T09:00')).toBe('1 Jul 2026, 09:00')
    expect(formatBound('2026-07-01T09:00')).not.toContain('T')
  })

  it('renders December, so the month lookup is not off by one at the end of the list', () => {
    expect(formatBound('2026-12-31T23:59')).toBe('31 Dec 2026, 23:59')
  })

  it('renders January, so it is not off by one at the start either', () => {
    expect(formatBound('2026-01-01T00:00')).toBe('1 Jan 2026, 00:00')
  })

  it('keeps seconds when they are not zero, and drops them when they are', () => {
    expect(formatBound('2026-07-01T09:00:07')).toBe('1 Jul 2026, 09:00:07')
    expect(formatBound('2026-07-01T09:00:00')).toBe('1 Jul 2026, 09:00')
    expect(formatBound('2026-07-01T09:00:07.250')).toBe('1 Jul 2026, 09:00:07')
  })

  it('renders a bare date WITH its time, because it names one (#124)', () => {
    // This used to render the date alone, because whether it meant UTC
    // midnight or the operator's own had not been decided and answering it in
    // a display helper would have been a guess. It is UTC midnight, and
    // printing the date alone would now imply a whole-day meaning it does not
    // have, and would disagree with the rows the segment selects.
    //
    // `00:00` because THIS describe does not stub a zone and so runs in UTC;
    // the one below stubs Asia/Kolkata and shows the same value as 05:30.
    expect(formatBound('2026-08-01')).toBe('1 Aug 2026, 00:00')
  })

  it('hands back anything that is not a reading, exactly as stored', () => {
    // An unfinished condition, a half-typed value, a nonsense month or hour.
    // The row that shows it says separately that it is not finished; blanking
    // or guessing would throw away the operator's own text.
    expect(formatBound('')).toBe('')
    expect(formatBound('soon')).toBe('soon')
    expect(formatBound('2026-13-01T09:00')).toBe('2026-13-01T09:00')
    expect(formatBound('2026-07-32T09:00')).toBe('2026-07-32T09:00')
    // `24:00` is deliberately NOT in this list any more. The language reads it
    // as the following midnight and so does the compiler, so echoing the raw
    // string here made the summary disagree with the rows the segment selects.
    // Pinned as what it resolves to, below.
    expect(formatBound('2026-07-01T09:60')).toBe('2026-07-01T09:60')
  })
})

/**
 * **The conversion half is meaningless in UTC**, and this repository's own
 * containers run in it -- where local IS UTC, a bound rendered through the
 * store-UTC/display-local rule and one rendered straight off the stored string
 * agree on every fixture. `TZ` is pinned the same way `datetime.test.ts` pins
 * it, and for the same reason, to `+05:30`: neither zero nor a whole number of
 * hours, so dropping the minutes is caught as well as dropping the offset.
 */
describe('formatBound -- a stored instant', () => {
  const ZONE = 'Asia/Kolkata'

  beforeAll(() => {
    vi.stubEnv('TZ', ZONE)
  })
  afterAll(() => {
    vi.unstubAllEnvs()
  })

  it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
    expect(new Date('2026-07-01T09:00').toISOString()).toBe('2026-07-01T03:30:00.000Z')
  })

  it('shows a `Z`-suffixed instant as the local reading it names', () => {
    // 03:30Z is 09:00 in +05:30 -- a different hour and a different minute,
    // so a conversion that drops either is visible here.
    expect(formatBound('2026-07-01T03:30:00.000Z')).toBe('1 Jul 2026, 09:00')
  })

  it('carries an instant over a day and month boundary', () => {
    // 20:30Z on 31 Jul is 02:00 on 1 Aug locally: a rendering that got the
    // clock right and the date wrong cannot pass this.
    expect(formatBound('2026-07-31T20:30:00.000Z')).toBe('1 Aug 2026, 02:00')
  })

  it('shows exactly what the picker would show for the same stored value', () => {
    // The property that matters, rather than a second copy of the arithmetic:
    // a bound read in a summary and the same bound opened in the builder
    // cannot disagree, because both go through `toPickerValue`.
    for (const stored of [
      '2026-07-01T03:30:00.000Z',
      '2026-07-31T20:30:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T10:00',
    ]) {
      const picker = toPickerValue(stored)
      const [date = '', time] = picker.split('T')
      const [year, month, day] = date.split('-')
      expect(formatBound(stored)).toContain(time)
      expect(formatBound(stored)).toContain(year)
      expect(formatBound(stored)).toContain(String(Number(day)))
      expect(formatBound(stored)).not.toContain(`${year}-${month}-${day}`)
    }
  })

  it('reads a stored zone-less reading as UTC and shows it locally (#124)', () => {
    // The inverse of what this asserted before. Stored zone-less values exist
    // -- written by an earlier build of this screen, by the API, by the CLI --
    // and they are UTC, so `10:00` shows as `15:30` in this suite's zone. That
    // shift is the accepted, bounded, one-time cost of ending the ambiguity;
    // what it buys is that this string names the same instant the SQL matches.
    expect(formatBound('2026-06-01T10:00')).toBe('1 Jun 2026, 15:30')
  })

  it('resolves `24:00` the way the compiler does, rather than echoing it', () => {
    expect(formatBound('2026-07-01T24:00')).toBe('2 Jul 2026, 05:30')
  })
})

describe('formatValue', () => {
  it('joins a `between` pair with "and", because the join belongs to the value', () => {
    expect(formatValue([100, 5000])).toBe('100 and 5000')
  })

  it('renders null as the word, not as an empty string', () => {
    expect(formatValue(null)).toBe('null')
  })

  it('applies the scalar formatter to each slot of a pair, not to the pair', () => {
    expect(formatValue([1, 2], (v) => `<${v}>`)).toBe('<1> and <2>')
  })
})

describe('wherePhrase', () => {
  it('reads each predicate in the operator words, never the raw symbol', () => {
    // Two predicates and two DIFFERENT operators: a single-predicate list
    // whose only operator is `=` cannot tell a worded operator from a
    // symbol, since "is" and "=" both look like a pass at a glance.
    const phrase = wherePhrase([
      { property: 'page', operator: '=', value: 'changelog' },
      { property: 'duration_ms', operator: '>=', value: 30 },
    ])
    expect(phrase).toBe('page is changelog, duration_ms at least 30')
    expect(phrase).not.toContain('>=')
    expect(phrase).not.toContain('=')
  })

  it('renders a `between` predicate through formatValue', () => {
    expect(wherePhrase([{ property: 'amount', operator: 'between', value: [1, 100] }])).toBe(
      'amount between 1 and 100',
    )
  })

  it('adds no terminator of its own -- the caller closes the list', () => {
    // Deliberate: `summarise` brackets the whole behaviour and the funnel
    // screens bracket the clause. A terminator here would give both two.
    const phrase = wherePhrase([{ property: 'page', operator: '=', value: 'changelog' }])
    expect(phrase).toBe('page is changelog')
    expect(phrase.endsWith(')')).toBe(false)
    expect(phrase.endsWith(',')).toBe(false)
  })

  it('is empty for an empty list, rather than a stray separator', () => {
    expect(wherePhrase([])).toBe('')
  })
})

describe('wherePhrase — attribute predicates', () => {
  // A saved segment reads as a sentence in the list and on the detail
  // screen, and `wherePhrase` used to read `.property` unconditionally --
  // an attribute predicate would have rendered "undefined is
  // august-digest".
  it('renders an attribute predicate by its own field name', () => {
    expect(
      wherePhrase([
        { source: 'attribute', attribute: 'utm_campaign', operator: '=', value: 'august-digest' },
      ]),
    ).toBe('utm_campaign is august-digest')
  })

  it('mixes the two in one clause, in the order given', () => {
    expect(
      wherePhrase([
        { property: 'plan', operator: '=', value: 'pro' },
        { source: 'attribute', attribute: 'path', operator: '=', value: '/pricing' },
      ]),
    ).toBe('plan is pro, path is /pricing')
  })

  // The accepted cost of reading as a sentence: a property named `path` and
  // the column named `path` summarise identically. Recorded as a test so it
  // is a decision someone made, not a surprise someone finds -- the editor
  // rows are where the two are told apart, and this function sees one tree,
  // never the project's property namespace.
  it('reads the same for a property and an attribute of the same name', () => {
    expect(wherePhrase([{ property: 'path', operator: '=', value: '/a' }])).toBe(
      wherePhrase([{ source: 'attribute', attribute: 'path', operator: '=', value: '/a' }]),
    )
  })
})
