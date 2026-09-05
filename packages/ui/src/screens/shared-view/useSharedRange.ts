import { useCallback, useState } from 'react'
import { AUTO, CUSTOM, type RangeChoice, readRange, writeRange } from '../shared/range.js'

/**
 * The range a shared page shows, read from and written to the URL's query
 * string with `history.replaceState`.
 *
 * `replaceState` by hand rather than react-router's `useSearchParams`,
 * which is what Trends, Retention and the operator's dashboard use: there
 * is no router on this page at all (`main.tsx` mounts `SharedApp` directly
 * off the pathname, before `App` and therefore before `AppRouter`), so
 * those hooks would throw. The URL still has to carry the range so that a
 * viewer who reloads, or sends the link on with a range chosen, sees the
 * same page -- which is the whole reason this is not just `useState`.
 *
 * `replace`, not `push`: the browser Back button on a shared link should
 * leave the page, not walk back through every range the viewer tried. This
 * matches how `Dashboard.tsx` writes its own range (`{ replace: true }`).
 *
 * `custom` (and its two dates) has no meaning here and reads as `auto`.
 * `SHARED_RANGE_PRESETS` is the entire vocabulary the public run route
 * accepts, so a `?range=custom&from=…` URL -- which is exactly what an
 * operator gets by copying their own dashboard's address bar -- would
 * otherwise send a preset the server refuses. Normalising to `auto` shows
 * each report's own default window instead, which is the honest answer to
 * "this range cannot be expressed here" and the same thing an unset range
 * already does.
 */
export function useSharedRange(): [RangeChoice, (next: RangeChoice) => void] {
  const [range, setRange] = useState<RangeChoice>(() =>
    normalise(readRange(new URLSearchParams(window.location.search))),
  )

  // Stable identity with no dependencies: `SharedTile` lists `range` among
  // its effect's dependencies and a page can hold many tiles, so anything
  // up here that changes identity per render re-issues every tile's run.
  // `setRange` is a state setter and `window` is a global, so there is
  // nothing to depend on.
  const set = useCallback((next: RangeChoice) => {
    const clean = normalise(next)
    const search = writeRange(new URLSearchParams(window.location.search), clean).toString()
    // The pathname is preserved verbatim, not rebuilt: it carries the share
    // token, and this call is the one place on the page that could drop it.
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}`,
    )
    setRange(clean)
  }, [])

  return [range, set]
}

/** The dates are cleared for EVERY preset, not only for `custom`: they are
 *  meaningless without it (see `RangeChoice`), and leaving them on the value
 *  would let `writeRange` put `from`/`to` back into a URL that nothing on
 *  this page reads. */
function normalise(r: RangeChoice): RangeChoice {
  return r.preset === CUSTOM ? { preset: AUTO, from: '', to: '' } : { ...r, from: '', to: '' }
}
