import { EVENT_COLUMN_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { EventColumnField } from '@lyraflow/core/segments/ast.js'
import { useEffect, useId, useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import { Combobox } from '../../components/Combobox.js'
import { Label } from '../../components/ui/label.js'
import { usePropertyNames } from './usePropertyNames.js'

/** What one `where` row is filtering on: a column of the event, or a key in
 * its property bag. The two halves of `WherePredicate`, without the operator
 * and the value. */
export interface FieldChoice {
  source: 'property' | 'attribute'
  name: string
}

const ATTRIBUTES = 'Attributes'
const PROPERTIES = 'Properties'

function isAttribute(name: string): name is EventColumnField {
  return (EVENT_COLUMN_FIELDS as readonly string[]).includes(name)
}

/**
 * The field a `where` predicate names -- attributes and properties in ONE
 * picker, sectioned.
 *
 * ## Why one box and not a kind-select beside it
 *
 * The reported symptom was "I don't see attributes. I see properties only",
 * written by someone looking at a feed row that had just shown them URL,
 * Path, Referrer and UTM campaign. A toggle would have made the capability
 * reachable and left the discovery problem exactly where it was: you have to
 * know the word "attribute", and know to flip it, before the name you are
 * looking for appears anywhere. Typing `utm` and seeing `utm_campaign` under
 * a heading needs neither.
 *
 * ## Attributes are matched locally, properties on the server
 *
 * `EVENT_COLUMN_FIELDS` is a compile-time list of fourteen names; asking a
 * server for a prefix match against it would be a request to learn something
 * this bundle already contains. Properties keep the debounced
 * `GET /v1/schema/properties` lookup they have always had, through
 * `usePropertyNames`. The two are filtered by the SAME rule -- `startsWith`
 * on the trimmed text -- because a picker whose two halves narrow
 * differently is a picker that appears to lose rows as you type.
 *
 * ## Free text is a property, with no exceptions
 *
 * Choosing a row states which section it came from, so a property genuinely
 * named `path` and the column named `path` are distinguishable even though
 * they read identically. Typed text carries no such statement, so it means a
 * property -- the behaviour this field has always had, and the only reading
 * that cannot silently retarget a predicate as it is being written.
 *
 * That includes editing a row that already names an attribute: the first
 * keystroke makes it a property row again. A rule preserving the attribute
 * "when the text still spells it" was written and removed, because it could
 * not fire for any edit made one character at a time -- the text stops
 * spelling the attribute at the first keystroke and the row is a property
 * row by the time it spells it again. `columnFieldNote` is the recovery
 * path, and it appears on the row the moment the name matches.
 */
export function FieldCombobox(props: {
  client: ApiClient
  projectId: number
  event: string | undefined
  value: FieldChoice
  onChange: (next: FieldChoice) => void
  label?: string
  onUnauthorized?: () => void
}) {
  const { client, projectId, event, value, onChange, label = 'Property or attribute' } = props
  const [text, setText] = useState(value.name)
  const id = useId()

  useEffect(() => {
    setText(value.name)
  }, [value.name])

  const { options, loading, error } = usePropertyNames({
    client,
    projectId,
    event,
    query: text,
    onUnauthorized: props.onUnauthorized,
  })

  const q = text.trim().toLowerCase()
  const attributes = EVENT_COLUMN_FIELDS.filter((f) => f.startsWith(q))

  // An empty section is omitted rather than rendered with a heading and
  // nothing under it -- a heading over a void reads as a failed lookup.
  const groups = [
    ...(attributes.length > 0 ? [{ label: ATTRIBUTES, options: [...attributes] }] : []),
    ...(options.length > 0 ? [{ label: PROPERTIES, options }] : []),
  ]

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Combobox
        id={id}
        label={label}
        value={text}
        options={[]}
        groups={groups}
        // Only about the PROPERTY half: the attribute list is local and
        // always answered. A spinner over a popup that is already showing
        // fourteen rows would be describing the wrong half of it.
        loading={loading && attributes.length === 0}
        errorMessage={
          error && attributes.length === 0
            ? 'Could not load property suggestions. Attributes and free typing still work.'
            : undefined
        }
        placeholder="Property or attribute name -- starts with what you type"
        onChange={(next, group) => {
          setText(next)
          // `isAttribute` as well as the section, so a stale group label
          // could never put a name the AST's enum refuses into a predicate
          // typed `attribute`.
          if (group === ATTRIBUTES && isAttribute(next)) {
            onChange({ source: 'attribute', name: next })
            return
          }
          onChange({ source: 'property', name: next })
        }}
      />
    </div>
  )
}
