import { CONTEXT_FIELDS, EVENT_COLUMN_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { EventColumnField } from '@lyraflow/core/segments/ast.js'

/**
 * The one line a `where` predicate shows when its property names a COLUMN on
 * the event rather than a key in the event's property bag.
 *
 * Why this exists at all: `wherePredicate` (core, `segments/predicates.ts`)
 * compiles to `properties[<key>]` / `properties_num[<key>]` and nothing else.
 * A predicate on `path`, `referrer` or any device/geo field is therefore
 * well-formed, passes every schema, saves without complaint, and reads an
 * empty map slot. "page_view where path is /changelog" is the first thing an
 * operator writes and the first thing that answers zero, and until now the
 * only signal was the zero itself.
 *
 * Three decisions, none of them cosmetic:
 *
 * - **It is a note, not a rejection.** The field is free-typed by design --
 *   this codebase lets a definition be written ahead of the data that fills
 *   it (`PropertyCombobox`'s own doc comment; `StepRows`' reasoning for
 *   keeping predicates when a step's event changes). Refusing input here
 *   would contradict that for a predicate that is not invalid, only unable
 *   to match. Nothing about saving changes.
 * - **It is not phrased as a mistake.** The operator did nothing wrong; the
 *   name simply lives somewhere a property predicate does not read. The
 *   sentence says where the value IS, and -- for the ten fields that have
 *   one -- points at the condition that does read it, rather than leaving
 *   them with a dead end.
 * - **The remedy is claimed only where it exists.** `path`, `url`,
 *   `utm_term` and `utm_content` are stored per event and never folded into
 *   `device_index`, so no `context` condition matches them either. Telling
 *   an operator to reach for one would replace a silent zero with a
 *   confident wrong instruction, which is worse. Those get the fact and no
 *   remedy.
 *
 * Pure and total over a string, so it is the same answer everywhere it is
 * asked -- both callers of `WherePredicates` (a segment behaviour's `where`
 * and a funnel step's) read it, because both compile through the same
 * function and fall into the same trap.
 */
export function columnFieldNote(property: string): string | null {
  const name = property.trim()
  if (!(EVENT_COLUMN_FIELDS as readonly string[]).includes(name)) return null
  const field = name as EventColumnField
  const fact = `"${field}" is recorded on the event itself, not among its properties, and this filters properties only.`
  if (!(CONTEXT_FIELDS as readonly string[]).includes(field)) return fact
  return `${fact} A segment's context condition on "${field}" is what matches it.`
}
