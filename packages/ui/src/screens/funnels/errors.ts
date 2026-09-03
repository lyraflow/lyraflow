import { ApiError } from '../../api/client.js'

/**
 * One message per failure an operator can act on. The 422 matters most: it
 * is the only one whose remedy is something they can do from this screen --
 * narrow the range and run it again.
 *
 * Lives in its own module, not in `FunnelDetail.tsx`: the builder (Task 5)
 * imports this too, and a screen exporting a helper a sibling screen
 * imports couples two routes through a component module and invites an
 * import cycle once the builder also renders a detail-shaped preview.
 *
 * A stale/deleted `segment_id` does NOT come through here. Task 1's probe
 * against a live stack found that case answers `200`, not an error -- it
 * runs the funnel over the whole population and says so only via a
 * `segment_id` entry in the run result's `warnings`. There is no status
 * code for it, so this switch has no case for it and must not gain one:
 * `FunnelDetail` handles that signal directly from `warnings`, not from a
 * thrown `ApiError`.
 *
 * `noun` names the thing the message is about, and DEFAULTS to `funnel` so
 * every caller that predates it reads exactly as it did. Three of the six
 * branches name it; the other three (422, 503, the fallback) are already
 * neutral. A dashboard tile runs a trend or a retention report through the
 * same statuses, and "This funnel no longer exists." on a trend tile is a
 * message about a report that is not on the screen -- so the noun is a
 * parameter rather than a second copy of this switch somewhere else, which
 * is how the two spellings of the `detail[]` formatting below would drift.
 */
export function describeError(err: unknown, noun = 'funnel'): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Reload to try again.'
  switch (err.status) {
    case 400:
      // MINOR (whole-branch review): a validation 400 carries a per-path
      // `detail[]` -- e.g. `{ path: "window_seconds", message: "Expected
      // positive integer" }` -- naming exactly which field was wrong.
      // Discarding it and showing only the generic `err.code` ("invalid
      // funnel") gave an operator nothing to act on; decision 8 asks for
      // "the per-path detail[], against the offending field", not a code.
      // Falls back to the code when the server sent no detail (or an empty
      // one) -- `StoredDefinitionError`'s 400 has no `detail[]` at all.
      if (err.detail != null && err.detail.length > 0) {
        return `This ${noun} could not be read: ${err.detail
          .map((d) => `${d.path || 'value'} -- ${d.message}`)
          .join('; ')}`
      }
      return `This ${noun} could not be read: ${err.code}`
    case 404:
      return `This ${noun} no longer exists.`
    case 409:
      return `A ${noun} with that name already exists.`
    case 422:
      return 'That query took too long to finish. Narrow the range and run it again.'
    case 503:
      return 'Lyraflow is temporarily unavailable. Try again shortly.'
    default:
      return 'Something went wrong. Reload to try again.'
  }
}
