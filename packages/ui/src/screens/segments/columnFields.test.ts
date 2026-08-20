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

  it('names the attribute as the remedy, and does not call it an error', () => {
    const note = columnFieldNote('path')
    expect(note).toContain('Attributes')
    expect(note).toContain('properties')
    // The wording an operator reads must not accuse them. Free text in this
    // field means a property, which is what it has always meant, so naming
    // one that happens to also be an attribute is not a mistake. These are
    // the words a rejection would use, and this is not one.
    expect(note).not.toMatch(/invalid|not allowed|cannot be used|error/i)
  })

  // Before attribute predicates existed this note had two forms: the ten
  // context fields were told to reach for a `context` condition, and the
  // four with no such condition -- `path`, `url`, `utm_term`, `utm_content`
  // -- were told the fact and given no remedy at all. All fourteen now have
  // the same one, in the same box, so the split is gone; a note that still
  // sent an operator to a `context` condition would be answering a
  // per-event question with a person-level condition.
  it('offers the same remedy for every field, including the four with no context condition', () => {
    for (const field of EVENT_COLUMN_FIELDS) {
      const note = columnFieldNote(field)
      expect(note, field).toContain('Attributes')
      expect(note, field).not.toContain('context condition')
    }
    for (const field of ['path', 'url', 'utm_term', 'utm_content']) {
      expect(CONTEXT_FIELDS).not.toContain(field)
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
