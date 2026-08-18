/**
 * Share one in-flight request between identical concurrent callers.
 *
 * NOT A CACHE, and the distinction is the whole point (#127). Nothing is
 * retained after a request settles, so there is no staleness question to
 * answer -- no TTL, no invalidation rule, nothing to get wrong when an
 * operator changes the event a step names. The next call after the last one
 * settles goes to the network exactly as it would have.
 *
 * What it fixes: suggestion fields fetch on mount so the list is present the
 * moment the field is focused. Opening a segment for editing therefore mounts
 * every condition at once, and sibling `where` predicates under the same
 * behaviour ask for the identical `(projectId, event, '')` list, one request
 * each, all in the same instant. A modest tree issues seven; one near the
 * hundred-node cap issues far more.
 *
 * A rejection is shared too, deliberately: callers that would each have made
 * the same failing request each see the same failure, which is what they
 * would have got separately.
 */
export function dedupeInFlight<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  key: (...args: A) => string,
): (...args: A) => Promise<R> {
  const inFlight = new Map<string, Promise<R>>()
  return (...args: A) => {
    const k = key(...args)
    const existing = inFlight.get(k)
    if (existing) return existing
    // The stored promise is the one with the cleanup attached, so the entry
    // is removed whether the request resolved or rejected -- a failed lookup
    // must not pin its key and make every later attempt return the same old
    // rejection forever.
    const started = fn(...args).finally(() => {
      inFlight.delete(k)
    })
    inFlight.set(k, started)
    return started
  }
}
