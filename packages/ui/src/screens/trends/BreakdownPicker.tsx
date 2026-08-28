import { EVENT_COLUMN_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { ApiClient } from '../../api/client.js'
import { Label } from '../../components/ui/label.js'
import { PropertyCombobox } from '../segments/PropertyCombobox.js'

export const BREAKDOWN_SOURCES = ['none', 'event_name', 'attribute', 'property'] as const
export type BreakdownSource = (typeof BREAKDOWN_SOURCES)[number]

const SOURCE_LABELS: Record<BreakdownSource, string> = {
  none: 'Nothing',
  event_name: 'Event name',
  attribute: 'An event column',
  property: 'An event property',
}

/**
 * What to split a trend by.
 *
 * The source and the field are two controls rather than one list, because the
 * two halves come from different places: the columns are a closed set the AST
 * declares, and the properties are whatever the project has recorded. One
 * merged combobox would have to interleave them and would then have to say,
 * per row, which kind each was -- the same ambiguity `wherePredicateField`
 * exists to resolve.
 */
export function BreakdownPicker(props: {
  id: string
  client: ApiClient
  projectId: number
  event: string
  source: BreakdownSource
  field: string
  onChange: (next: { source: BreakdownSource; field: string }) => void
  onUnauthorized?: () => void
}) {
  const { id, client, projectId, event, source, field, onChange, onUnauthorized } = props

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={`${id}-source`}>Split by</Label>
        <select
          id={`${id}-source`}
          aria-label="Split by"
          value={source}
          onChange={(e) =>
            // The field is cleared on a source change, never carried across:
            // `utm_source` is a valid column and an unlikely property name,
            // and carrying it would silently ask a different question.
            onChange({ source: e.target.value as BreakdownSource, field: '' })
          }
          className="h-9 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
        >
          {BREAKDOWN_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {source === 'attribute' && (
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={`${id}-column`}>Column</Label>
          <select
            id={`${id}-column`}
            aria-label="Column"
            value={field}
            onChange={(e) => onChange({ source, field: e.target.value })}
            className="h-9 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
          >
            <option value="">Choose a column…</option>
            {EVENT_COLUMN_FIELDS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      )}

      {source === 'property' && (
        <PropertyCombobox
          client={client}
          projectId={projectId}
          // Scoped to the chosen event when there is one, so the suggestions
          // are the keys that event actually carries rather than every key in
          // the project.
          event={event === '' ? undefined : event}
          value={field}
          onChange={(next) => onChange({ source, field: next })}
          label="Property"
          placeholder="e.g. plan"
          hint="A key from the event's own properties."
          emptyMessage="No properties recorded for this event yet."
          onUnauthorized={onUnauthorized}
        />
      )}
    </>
  )
}
