import { describe, expect, it } from 'vitest'
import { coerceForKind, kindNote, learnKinds } from './propertyKinds.js'

describe('coerceForKind', () => {
  // The bug in one assertion. `wherePredicate` reads `properties_num` only
  // when the value is a JavaScript number, and every control in the builder
  // yields a string -- so this conversion is the whole difference between a
  // condition that matches and one that answers zero.
  it('makes a numeric property carry a number', () => {
    expect(coerceForKind('21', 'number')).toBe(21)
    expect(coerceForKind('0', 'number')).toBe(0)
    expect(coerceForKind('-3.5', 'number')).toBe(-3.5)
  })

  // Not a round-trip test on the text: the schema said this key holds
  // numbers, and 2134 is what `properties_num` holds for an event that sent
  // 02134. Refusing it because `String(Number(x)) !== x` would leave a string
  // that reads the wrong map -- the very defect being fixed.
  it('converts a value the text alone would refuse', () => {
    expect(coerceForKind('02134', 'number')).toBe(2134)
  })

  // Both directions, because a row moved from a numeric property to a text
  // one is this same bug with the maps swapped.
  it('makes a text property carry a string', () => {
    expect(coerceForKind(21, 'string')).toBe('21')
  })

  // `Number('')` is 0, and a half-finished row is not a claim that something
  // equals zero.
  it('leaves an empty value alone', () => {
    expect(coerceForKind('', 'number')).toBe('')
    expect(coerceForKind('   ', 'number')).toBe('   ')
  })

  it('leaves a value that is not a number alone, so the box keeps what was typed', () => {
    expect(coerceForKind('twenty', 'number')).toBe('twenty')
  })

  // `mixed` and `undefined` both mean "not established". A coercion on a
  // guess is the thing this function exists to avoid; the row says so
  // instead (see `kindNote`).
  it('changes nothing when the kind is unknown or mixed', () => {
    expect(coerceForKind('21', undefined)).toBe('21')
    expect(coerceForKind('21', 'mixed')).toBe('21')
    expect(coerceForKind(21, 'mixed')).toBe(21)
  })

  it('converts both bounds of a between', () => {
    expect(coerceForKind(['1', '9'], 'number')).toEqual([1, 9])
    expect(coerceForKind([1, 9], 'string')).toEqual(['1', '9'])
  })

  // Identity, not equality: the callers self-heal from an effect and compare
  // by reference to decide whether to write back. A new object every run
  // would be an effect that writes on every render forever.
  it('returns the same value by identity when there is nothing to do', () => {
    const tuple: [string, string] = ['a', 'b']
    expect(coerceForKind(tuple, 'string')).toBe(tuple)
    expect(coerceForKind(21, 'number')).toBe(21)
    expect(coerceForKind('a', 'string')).toBe('a')
  })
})

describe('kindNote', () => {
  it('says nothing when the kind is known', () => {
    expect(kindNote('results', 'number', '21')).toBeNull()
    expect(kindNote('plan', 'string', 'pro')).toBeNull()
  })

  // The residue of the bug, said out loud: with no kind to coerce against
  // the predicate stays text, and before this line the only evidence of that
  // was a count of zero.
  it('warns when a numeric-looking value sits on a property of unknown kind', () => {
    const note = kindNote('results', undefined, '21')
    expect(note).toContain('results')
    expect(note).toContain('as text')
  })

  it('warns when the project has recorded the property both ways', () => {
    const note = kindNote('results', 'mixed', '21')
    expect(note).toContain('both as text and as a number')
  })

  // Silent for a value that cannot be suffering from this. A note on every
  // unrecorded property would be noise on the case this builder is designed
  // for -- writing a definition ahead of the data that fills it.
  it('says nothing for a value that does not look numeric', () => {
    expect(kindNote('plan', undefined, 'pro')).toBeNull()
    expect(kindNote('plan', undefined, '')).toBeNull()
    expect(kindNote('', undefined, '21')).toBeNull()
  })

  it('warns on either bound of a between', () => {
    expect(kindNote('results', undefined, ['1', '9'])).not.toBeNull()
    expect(kindNote('results', undefined, ['a', 'b'])).toBeNull()
  })
})

describe('learnKinds', () => {
  // Accumulating, not replacing. A lookup is scoped to whatever text is in
  // one box, so the answer for a property stops coming back as soon as the
  // operator types past it -- and a map that replaced itself would forget
  // the kind of the property it was about to coerce.
  it('keeps what it already knew', () => {
    const first = learnKinds({}, [{ name: 'results', kind: 'number' }])
    const second = learnKinds(first, [{ name: 'query', kind: 'string' }])
    expect(second).toEqual({ results: 'number', query: 'string' })
  })

  it('takes a later answer over an earlier one', () => {
    const out = learnKinds({ results: 'string' }, [{ name: 'results', kind: 'number' }])
    expect(out.results).toBe('number')
  })

  // Identity again, and for the same reason: this is held in state, so a new
  // object per lookup is a re-render per lookup that told it nothing.
  it('returns the same object when nothing is new', () => {
    const known = { results: 'number' as const }
    expect(learnKinds(known, [{ name: 'results', kind: 'number' }])).toBe(known)
    expect(learnKinds(known, [])).toBe(known)
  })
})
