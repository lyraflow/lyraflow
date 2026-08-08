# @lyraflow/sdk-browser

The browser tracking library. Not published to npm — the server builds this
package and serves the bundle itself at `/lyraflow.js` and
`/lyraflow-<version>.js`. See the *Sending events from a browser* section of
the top-level [`README.md`](../../README.md) for the snippet, the public API,
and the consent model. This file is for people working on the SDK itself.

## Releasing: the version is load-bearing

`VERSION` in `src/index.ts` and `version` in `package.json` must move
together — `version.test.ts` fails the build if they drift — and **both must
be bumped whenever the bundle changes**, in the same change.

The server serves `/lyraflow-<VERSION>.js` with `max-age=31536000,
immutable`. A browser that pinned that path and cached it does not ask again
for a year, and does not revalidate either. Ship a fix without moving the
version and every one of those browsers keeps running the old bundle out of
its own cache, with nothing on the server able to reach it. The assertion
ties the constant to the manifest; it cannot tell you that the bundle changed
and the manifest did not, so that part is yours.

## Manual pre-release checklist

The automated suite runs against a DOM shim (`happy-dom`), not a real
browser. That is fine for almost everything here, but three behaviours
depend on mechanics a shim can only approximate — and an approximation can
agree with a wrong implementation just as easily as a correct one, because
it never has to face the real thing it's standing in for. Run these by hand,
in an actual browser, before cutting a release:

1. **Keepalive delivery survives unload.** Load a page with the SDK, fire a
   `track()` call, and close the tab (or navigate away) immediately — don't
   wait for the flush timer. Confirm the event still reaches the server. This
   is `fetch`'s `keepalive: true` flag doing its job on the real network
   stack and the real browser unload sequence; a shim's `fetch` has no
   unload sequence to race against, so it cannot fail this test the way a
   real browser can.

2. **The cookie-domain probe on a real multi-label domain.** Load the page on
   a domain with more than two labels under the public suffix — an `app.`
   subdomain of a `.co.uk`-shaped domain is the sharpest case — and confirm
   the *same* visitor id (the `lyraflow_aid` cookie) is shared across two
   different subdomains of it. The probe (`probeCookieDomain` in
   `src/identity.ts`) works by asking the real browser which cookie domain it
   will actually accept, one label at a time; a shim's cookie jar does not
   enforce the public-suffix rules real browsers do, so it will accept
   domains a real browser would silently reject, and the test would pass for
   the wrong reason.

3. **`localStorage` under pressure.** Fill `localStorage` to its quota (or
   just use a private/incognito window, where several browsers cap it much
   lower), then confirm tracking keeps working and the page doesn't break.
   The queue is supposed to degrade to memory-only when `localStorage.setItem`
   throws (see `queue.ts`'s `writeStore`) — a shim's storage is effectively
   unbounded, so it never throws, and this path only ever runs for real
   against a real quota.
