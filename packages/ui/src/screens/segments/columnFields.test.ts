import { CONTEXT_FIELDS, EVENT_COLUMN_FIELDS } from '@lyraflow/core/segments/ast.js'
import { describe, expect, it } from 'vitest'
import { columnFieldNote } from './columnFields.js'

describe('columnFieldNote', () => {
  it('says nothing about an ordinary property name', () => {
    expect(columnFieldNote('page')).toBeNull()
    expect(columnFieldNote('duration_ms')).toBeNull()
    expect(columnFieldNote('')).toBeNull()
  })

  it('answers for every column-backed field, not just the ones anyone thought to type', () => {
    // Driven off core's own list rather than a copy: a field added there
    // must not be a name this screen has quietly stopped explaining.
    for (const field of EVENT_COLUMN_FIELDS) {
      const note = columnFieldNote(field)
      expect(note, field).not.toBeNull()
      expect(note, field).toContain(field)
    }
  })

  it('names where the value actually lives, and does not call it an error', () => {
    const note = columnFieldNote('path')
    expect(note).toContain('recorded on the event itself')
    expect(note).toContain('filters properties only')
    // The wording an operator reads must not accuse them. These are the
    // words a rejection would use, and this is not one.
    expect(note).not.toMatch(/invalid|not allowed|cannot be used|error/i)
  })

  it('points at the context condition for a field that has one', () => {
    // `referrer` IS a context field, so there is a working way to match it
    // and the note has to say which -- "this will not work" with no next
    // step is the same dead end as the silent zero.
    const note = columnFieldNote('referrer')
    expect(note).toContain('context condition')
    expect(note).toContain('referrer')
  })

  it('claims no context condition for the four fields that have none', () => {
    // `path`, `url`, `utm_term` and `utm_content` are stored per event and
    // never folded into the device index, so no `context` condition reads
    // them back. Naming one here would replace a silent zero with a
    // confident wrong instruction -- strictly worse.
    for (const field of ['path', 'url', 'utm_term', 'utm_content']) {
      expect(CONTEXT_FIELDS).not.toContain(field)
      expect(columnFieldNote(field), field).not.toContain('context condition')
    }
  })

  it('ignores surrounding whitespace, which a paste leaves behind', () => {
    expect(columnFieldNote('  path  ')).toBe(columnFieldNote('path'))
  })

  it('is exact about the name -- a property that merely contains one is not one', () => {
    expect(columnFieldNote('path_template')).toBeNull()
    expect(columnFieldNote('landing_path')).toBeNull()
  })
})
