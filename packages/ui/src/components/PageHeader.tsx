import type { ReactNode } from 'react'
import { cn } from '../lib/utils.js'

/**
 * The title row every screen puts at the top, in one place instead of
 * nineteen.
 *
 * The screens had settled on three sizes for the same thing -- `text-lg` on
 * thirteen, `text-xl` on three, `text-2xl tracking-tight` on the shared public
 * page -- with the class order varying between copies. `text-xl` is the
 * default because `text-lg` does not read as a page title next to the body
 * text beneath it; `SharedDashboard` keeps `text-2xl` by passing
 * `titleClassName`, since it renders with no sidebar and a larger title is
 * correct there.
 *
 * `min-w-0 break-words` is the default rather than opt-in. Three screens
 * already carried it by hand because a segment, funnel or dashboard name is
 * operator-supplied and unbounded (#218: a long one pushed Edit and Delete off
 * the row). Making it the default is what stops the fourth screen forgetting.
 *
 * The `actions` slot is also the button hierarchy. Primary right-most as
 * `variant="default"`, secondary as `outline`, destructive as `ghost` with
 * `text-destructive` -- unless deleting is what the screen is FOR. Before this
 * existed, Segment detail paired a bare-text Edit with a bordered Delete, so
 * the destructive action outranked the primary one.
 */
export function PageHeader(props: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** Only `SharedDashboard` passes this. See the note above. */
  titleClassName?: string
}) {
  return (
    <div className="flex items-start justify-between gap-2">
      <div className="flex min-w-0 flex-col gap-1">
        <h1
          className={cn(
            'min-w-0 break-words font-semibold text-xl tracking-tight',
            props.titleClassName,
          )}
        >
          {props.title}
        </h1>
        {props.subtitle != null && (
          <p className="text-muted-foreground text-sm">{props.subtitle}</p>
        )}
      </div>
      {props.actions != null && (
        <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
      )}
    </div>
  )
}
