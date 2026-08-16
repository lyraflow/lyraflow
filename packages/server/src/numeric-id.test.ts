import { describe, expect, it } from 'vitest'
import { parseNumericId } from './numeric-id.js'

describe('parseNumericId', () => {
  it.each(['1', '42', '9007199254740991'])('accepts %s', (raw) => {
    expect(parseNumericId(raw)).toBe(Number(raw))
  })

  // A bare `Number()` + `Number.isInteger()` check accepts every one of
  // these — hex, a leading `+`, surrounding whitespace, and exponent
  // notation all coerce to a normal-looking finite integer, and
  // `Number.isInteger(1e21)` is `true`. Each must be rejected by the
  // `/^\d+$/` shape check before `Number()` ever sees it.
  it.each([
    ['0x10', 'hex notation'],
    ['+5', 'a leading plus sign'],
    [' 1 ', 'surrounding whitespace'],
    ['1e3', 'exponent notation'],
    ['', 'an empty string'],
    ['-1', 'a negative number'],
    ['0', 'zero'],
    ['1.0', 'a decimal point'],
    ['not-a-number', 'non-numeric text'],
    ['99999999999999999999', 'a value beyond MAX_SAFE_INTEGER'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseNumericId(raw)).toBeNull()
  })
})
