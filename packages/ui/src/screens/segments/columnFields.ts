import { EVENT_COLUMN_FIELDS } from '@lyraflow/core/segments/ast.js'

/**
 * The one line a `where` row shows when a PROPERTY predicate has been given
 * the name of an event attribute.
 *
 * This note used to say the name could not be filtered on at all -- there
 * was no attribute predicate, so `path` or `utm_campaign` typed here was
 * well-formed, saveable, and read an empty map slot. It now says something
 * narrower and more useful: the name is available, one section up in the
 * picker, and this row is not pointing at it.
 *
 * Three decisions, none of them cosmetic:
 *
 * - **It is a note, not a rejection.** The field is free-typed by design --
 *   this codebase lets a definition be written ahead of the data that fills
 *   it (`PropertyCombobox`'s own doc comment; `StepRows`' reasoning for
 *   keeping predicates when a step's event changes). A property genuinely
 *   named `path` is possible, and refusing it would turn a coincidence of
 *   naming into an error. Nothing about saving changes.
 * - **It is not phrased as a mistake.** Free text means a property, which is
 *   what this field has always meant; the operator did nothing wrong. The
 *   sentence says the name is also an attribute and where to pick it.
 * - **It fires for a property predicate only.** Once a row names the
 *   attribute, the note would be describing a problem the row does not have
 *   -- `WherePredicates` checks the predicate's `source` before asking.
 *
 * Pure and total over a string, so it is the same answer everywhere it is
 * asked -- both callers of `WherePredicates` (a segment behaviour's `where`
 * and a funnel step's) read it, because both compile through the same
 * function and both offer the same two sections.
 */
export function columnFieldNote(property: string): string | null {
  const name = property.trim()
  if (!(EVENT_COLUMN_FIELDS as readonly string[]).includes(name)) return null
  return (
    `"${name}" is also an attribute of the event itself. This row filters the event's ` +
    `properties; pick "${name}" under Attributes to filter the event's own value.`
  )
}
