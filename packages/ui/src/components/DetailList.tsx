import { ChevronRight } from 'lucide-react'
import { Fragment } from 'react'

/** One `label: value` line of an expanded row. */
export interface DetailField {
  label: string
  value: string
}

/**
 * The chevron that opens a table row, and the only focusable control in it.
 *
 * A row's whole width is the click target -- a 16px chevron is hard to hit on
 * a 40px row, and where every row expands there is nothing else a click could
 * have meant -- so this exists for the keyboard, and it stops propagation
 * rather than letting its own click also reach the row's handler, which would
 * toggle twice and land back where it started.
 *
 * Shared by the event feed and the segment member list. They were written a
 * day apart and the second was a copy of the first; the parts worth sharing
 * are not the markup but the decisions in it -- what the accessible name
 * says, that the chevron rotates rather than swapping glyph, that the button
 * is the keyboard path.
 */
export function ExpandToggle(props: {
  open: boolean
  /** Names the row, not the control: "details for $page at 18:55:14". The
   * verb and the word "details" are added here so every table says it the
   * same way. */
  describes: string
  controls: string
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      aria-expanded={props.open}
      aria-controls={props.controls}
      aria-label={`${props.open ? 'Hide' : 'Show'} details for ${props.describes}`}
      className="flex size-5 items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      onClick={(e) => {
        e.stopPropagation()
        props.onToggle()
      }}
    >
      <ChevronRight
        className={`size-4 transition-transform ${props.open ? 'rotate-90' : ''}`}
        aria-hidden="true"
      />
    </button>
  )
}

/**
 * A `label: value` list, as a real `<dl>`.
 *
 * `break-all` rather than `truncate`: a URL with a long query string and a
 * person id are the two most common things in one of these, and a truncated
 * value is unreadable in exactly the case someone opened the row to read it.
 *
 * An EMPTY STRING is rendered as "(empty)" rather than omitted, and that is
 * the caller's decision to make, not this component's: a property whose value
 * is empty is one the sender wrote, while an attribute that never arrived is
 * a different fact. Callers drop the second kind before passing it here -- and
 * say how many they dropped.
 */
export function FieldList(props: { fields: DetailField[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {props.fields.map((field) => (
        <Fragment key={field.label}>
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="break-all font-mono">
            {field.value === '' ? (
              <span className="text-muted-foreground">(empty)</span>
            ) : (
              field.value
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** A heading over one section of an expanded row. */
export function DetailSection(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {props.title}
      </h3>
      {props.children}
    </section>
  )
}

/** The two-column frame an expanded row's sections sit in. */
export function DetailPanel(props: { id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-6 px-4 py-4 md:grid-cols-2" id={props.id}>
      {props.children}
    </div>
  )
}
