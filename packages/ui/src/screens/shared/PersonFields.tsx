import { CONTEXT_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { DetailField } from '../../components/DetailList.js'
import { DetailSection, FieldList } from '../../components/DetailList.js'

/**
 * The four context fields recorded ONLY as first-touch.
 *
 * `memberProjection` asks for every context field at `latest` scope, and for
 * these four that returns the first-touch value anyway -- referrer and the
 * UTM trio are stored once, at acquisition, because for an acquisition
 * attribute the original value is the one that means anything (README,
 * *One caveat on `context`*). Labelling them "latest" alongside `os` and
 * `city`, which really are current, would be the panel asserting a freshness
 * the column does not have.
 */
const FIRST_TOUCH_ONLY: readonly string[] = ['referrer', 'utm_source', 'utm_medium', 'utm_campaign']

/** `utm_campaign` -> `UTM campaign`, `device_type` -> `Device type`. */
export function labelFor(field: string): string {
  const words = field.replace(/_/g, ' ')
  const cased = field.startsWith('utm_')
    ? `UTM ${words.slice(4)}`
    : words.charAt(0).toUpperCase() + words.slice(1)
  return FIRST_TOUCH_ONLY.includes(field) ? `${cased} (first touch)` : cased
}

/**
 * The context a member row carries, in the order `CONTEXT_FIELDS` declares --
 * driven off core's own list rather than a copy, so a field added there
 * appears here rather than being silently dropped by a screen that never
 * heard about it.
 *
 * A row's context values are typed `string | number | Record<...>` only
 * because `MemberRow`'s index signature has to cover its named members; every
 * context column is a `String` in ClickHouse, so anything else here is a
 * response that has changed shape, and `String()` on it would print
 * "[object Object]" as though it were a value.
 */
export function contextFields(source: Record<string, unknown>): DetailField[] {
  return CONTEXT_FIELDS.filter((f) => typeof source[f] === 'string').map((f) => ({
    label: labelFor(f),
    value: source[f] as string,
  }))
}

/**
 * The person's traits, both maps merged back into the one bag `identify()`
 * was called with.
 *
 * Same reasoning as the event feed's own properties panel: the string/number
 * split is a storage detail of `person_traits`, not something the person who
 * wrote `{ plan: "pro", seats: 12 }` should reassemble, and a key is only
 * ever in one of the two. Sorted by key, because the maps arrive in whatever
 * order ClickHouse built them and an open row must not reshuffle between two
 * pages of the same walk.
 */
export function traitFields(t: {
  traits?: Record<string, string>
  traits_num?: Record<string, number>
}): DetailField[] {
  const strings = Object.entries(t.traits ?? {}).map(([label, value]) => ({ label, value }))
  const numbers = Object.entries(t.traits_num ?? {}).map(([label, value]) => ({
    label,
    // String(), not toLocaleString(): these are the values a caller sent, and
    // a trait that happens to be an id or a year must not read back as
    // "2,026" in a panel whose job is to show what was received.
    value: String(value),
  }))
  return [...strings, ...numbers].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Empty attributes are dropped and COUNTED, exactly as the event feed's panel
 * does it: ten context fields of which a browser-only visitor carries five
 * would bury the five, and saying nothing would imply the list was complete.
 * "Not shown" and "not recorded" are different facts.
 */
export function AttributesSection(props: { source: Record<string, unknown> }) {
  const context = contextFields(props.source)
  const present = context.filter((f) => f.value !== '')
  const emptyCount = context.length - present.length

  return (
    <DetailSection title="Attributes">
      <FieldList fields={present} />
      {emptyCount > 0 && (
        <p className="mt-2 text-muted-foreground text-xs">
          {emptyCount} more {emptyCount === 1 ? 'attribute has' : 'attributes have'} no value
          recorded for this person and {emptyCount === 1 ? 'is' : 'are'} not listed.
        </p>
      )}
    </DetailSection>
  )
}

/**
 * Traits get the same treatment one level up: the row carries at most
 * `TRAITS_PER_MEMBER_MAX` of them and `trait_total` says how many the person
 * really has, so a capped list says so rather than reading as all of them.
 */
export function TraitsSection(props: {
  traits?: Record<string, string>
  traits_num?: Record<string, number>
  trait_total?: number
  /** Renders the withheld sentence instead of "No traits recorded". */
  withheld?: boolean
}) {
  const { traits: traitsMap, traits_num: traitsNumMap, trait_total: traitTotal, withheld } = props
  const traits = traitFields({ traits: traitsMap, traits_num: traitsNumMap })
  // Suppressed under `withheld`: a nonzero `trait_total` arriving alongside
  // it would otherwise render two contradictory statements -- "not shown for
  // a deletion request" and "N more traits are recorded and not shown here".
  const heldBack = withheld ? 0 : Math.max(0, (traitTotal ?? traits.length) - traits.length)

  return (
    <DetailSection title="Traits">
      {withheld ? (
        <p className="text-muted-foreground text-sm">
          Traits are not shown for someone with a deletion request. A trait carries no timestamp, so
          it cannot be split at the moment their data was erased.
        </p>
      ) : traits.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No traits recorded for this person. They appear here once your app calls identify().
        </p>
      ) : (
        <FieldList fields={traits} />
      )}
      {heldBack > 0 && (
        <p className="mt-2 text-muted-foreground text-xs">
          {heldBack} more {heldBack === 1 ? 'trait is' : 'traits are'} recorded for this person and
          not shown here.
        </p>
      )}
    </DetailSection>
  )
}
