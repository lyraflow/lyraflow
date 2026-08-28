import type { Person } from '../../api/types.js'
import { DetailSection } from '../../components/DetailList.js'
import { formatDate } from '../shared/format.js'

/** One column of the id split -- a plain list of ids, or a line saying there
 * are none, since an empty `<ul>` reads as though the panel forgot to
 * render rather than as a fact about the person. */
function IdList(props: { ids: string[]; testId: string; empty: string }) {
  if (props.ids.length === 0) {
    return <p className="text-muted-foreground text-sm">{props.empty}</p>
  }
  return (
    <ul data-testid={props.testId} className="flex flex-col gap-1 break-all font-mono text-sm">
      {props.ids.map((id) => (
        <li key={id}>{id}</li>
      ))}
    </ul>
  )
}

/**
 * The one thing no other screen shows: that a scattered set of ids is ONE
 * person. That claim is the product's central one, and nothing in the UI
 * has ever displayed it -- a member row, an event's `anonymous_id`/`user_id`
 * pair, none of them put the full set together.
 *
 * `ids` is `group ∪ devices` flattened and sorted server-side and cannot
 * itself say which entries are devices (`Person.ids`'s own doc comment) --
 * `devices` is what makes the split possible, so it is computed here as
 * `ids` minus `devices` rather than trusting the server to have already
 * ordered them that way.
 */
export function IdentityHeader(props: { person: Person }) {
  const { person } = props
  const deviceSet = new Set(person.devices)
  const userIds = person.ids.filter((id) => !deviceSet.has(id))

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="break-all font-semibold text-lg">{person.person_id}</h1>
        <p className="text-muted-foreground text-sm">
          {person.events.toLocaleString('en-US')} events · first seen{' '}
          {formatDate(person.first_seen)} · last seen {formatDate(person.last_seen)}
        </p>
      </div>
      {/* Wraps both columns rather than either alone -- a test asking "is
       * this id shown at all" should not have to know, or guess, which
       * column the server happened to put it in. */}
      <div data-testid="identity-ids" className="grid gap-6 md:grid-cols-2">
        <DetailSection title="User & anonymous ids">
          <IdList
            ids={userIds}
            testId="identity-user-ids"
            empty="No other ids recorded for this person."
          />
        </DetailSection>
        <DetailSection title="Devices">
          <IdList
            ids={person.devices}
            testId="identity-devices"
            empty="No devices recorded for this person."
          />
        </DetailSection>
      </div>
    </div>
  )
}
