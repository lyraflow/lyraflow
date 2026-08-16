import { AlertTriangle } from 'lucide-react'
import type { CostWarning } from '../../api/types.js'

/**
 * Every warning the server returned, always, above the numbers it qualifies,
 * with no dismiss control.
 *
 * This is the screen's honesty surface and it is not decorative. A funnel
 * run over a range shorter than its own window under-reports conversion,
 * because people who entered near the end have not had their full window to
 * finish. The server computes `partial_window_entrants` and writes the
 * sentence; the only way to get this wrong is to bury it. A funnel whose
 * segment filter has broken returns 200 with real, plausible numbers
 * computed over the wrong population -- the warning is the only signal.
 *
 * `reason` renders verbatim. Rewriting it here would make two sources of
 * truth for one explanation, and the server's is the one with the numbers.
 */
export function WarningPanel(props: { warnings: CostWarning[] }) {
  if (props.warnings.length === 0) return null
  return (
    <ul className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
      {props.warnings.map((w, i) => (
        <li key={`${w.path}-${i}`} className="flex items-start gap-2 text-sm text-foreground">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-primary"
            strokeWidth={1.5}
            aria-hidden="true"
          />
          <span>{w.reason}</span>
        </li>
      ))}
    </ul>
  )
}
