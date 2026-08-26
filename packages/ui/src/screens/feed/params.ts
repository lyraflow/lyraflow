import { DEFAULT_RANGE_ID, type FeedRange, rangeById } from './range.js'

/**
 * The feed's range and event filter, carried in the URL.
 *
 * **The URL rather than `localStorage`, and the reason is not persistence.**
 * Both survive a refresh, which is what was asked for. Only one of them
 * makes the thing on screen sendable: an operator who finds a spike wants to
 * put it in front of someone else, and a link is how they do that. The URL
 * also gives back and forward their ordinary meaning for free, and it cannot
 * go stale against a project the way a stored preference can.
 *
 * **Defaults are omitted, never written.** A feed nobody has filtered stays
 * at `/feed`, so a URL carrying parameters always means somebody chose them.
 * Writing `?range=24h` for the default would make every link look like a
 * deliberate narrowing.
 */
export const RANGE_PARAM = 'range'
export const EVENT_PARAM = 'event'

/**
 * The ceiling `/v1/events` and `/v1/events/stats` both enforce (`z.string()
 * .max(128)`). Clamped here rather than left to the server: a pasted URL is
 * the one input path that reaches these polls without passing through the
 * combobox, and a 400 on every poll would surface as "could not load the
 * feed" with nothing pointing at the address bar.
 */
export const MAX_EVENT_LENGTH = 128

export interface FeedParams {
  range: FeedRange
  /** `''` is no filter, matching what the combobox reports when cleared. */
  event: string
}

/** Reads what is in the URL, falling back to the defaults for anything
 * missing or unrecognised -- a link outlives the option list it was made
 * from, and an unknown range must open the feed rather than break it. */
export function readFeedParams(search: URLSearchParams): FeedParams {
  // `rangeById` owns the unknown-id fallback, and owning it once is the
  // point: a second check here could not fail, so a mutation that deleted
  // it left the suite green and made this look like the guard when it was
  // not.
  return {
    range: rangeById(search.get(RANGE_PARAM) ?? DEFAULT_RANGE_ID),
    event: (search.get(EVENT_PARAM) ?? '').slice(0, MAX_EVENT_LENGTH),
  }
}

/**
 * The URL these params should produce, preserving anything else already in
 * the query string.
 *
 * Other parameters are carried through rather than dropped: this screen does
 * not own the whole query string, and a future one that adds its own must
 * not have it silently deleted on the next keystroke here.
 */
export function writeFeedParams(current: URLSearchParams, params: FeedParams): URLSearchParams {
  const next = new URLSearchParams(current)
  if (params.range.id === DEFAULT_RANGE_ID) next.delete(RANGE_PARAM)
  else next.set(RANGE_PARAM, params.range.id)
  if (params.event === '') next.delete(EVENT_PARAM)
  else next.set(EVENT_PARAM, params.event.slice(0, MAX_EVENT_LENGTH))
  return next
}
