# Lyraflow

**Self-hosted, end-to-end customer journey intelligence and analytics.**

Lyraflow helps you understand the full path your customers take — from first touch to conversion, retention, and beyond — on infrastructure you control. Your customer data stays yours.

> ⚠️ **Early days.** Lyraflow currently ships the ingest spine, identity resolution, a segment query API, and per-person deletion and export — you can self-host it, create a project, send it events, stitch anonymous and known activity into one person, count or list the people matching a filter tree, and erase or export any one person's data on request. There is no builder UI yet (segments, journeys, dashboards) and no journey/funnel analysis. Watch the repo to follow along.

## Why Lyraflow?

- **Self-hosted first.** Run it on your own servers. No data leaves your infrastructure.
- **End-to-end journeys.** Not just page views — the entire customer lifecycle across touchpoints.
- **Source-available.** Distributed [fair-code](https://faircode.io) under the [Sustainable Use License](LICENSE.md): free to use, self-host, and modify for internal business purposes.

## License

Lyraflow is [fair-code](https://faircode.io) distributed under the [Sustainable Use License](LICENSE.md).

- Source is always visible
- Free to self-host and use for internal business purposes
- Extensible and modifiable

Note: this is a source-available license, not an [OSI-approved open source](https://opensource.org/osd) license. The practical difference: you may not offer Lyraflow as a paid hosted service to third parties.

## Repository layout

```
packages/   # product packages (workspace)
docs/       # product documentation
```

## Running Lyraflow

Requires Docker and Docker Compose.

```sh
git clone https://github.com/lyraflow/lyraflow.git
cd lyraflow
./install.sh
```

The script generates passwords into `.env`, starts the stack, and waits for
readiness. Then create a project and get your write key:

```sh
docker compose exec lyraflow node packages/cli/dist/index.js create-project "My App"
```

That prints two keys. The **write key** (`wk_…`) is the one the examples below
use, so put it in your shell:

```sh
export LYRAFLOW_WRITE_KEY=wk_...   # the write key printed above
```

The **server key** (`sk_…`) is secret and shown only once — write it down. It
is not needed for sending events; it authenticates `/v1/alias` and
`GET /v1/persons/:id` (see *Identity resolution* below), and deletion and
export too (see *Privacy: deletion and export* below). The *Identity
resolution* examples use it the same way:

```sh
export LYRAFLOW_SERVER_KEY=sk_...  # the server key printed above
```

## Sending your first event

Everything below is the whole of v0.1's public surface. There is still no UI
and no journey/funnel analysis — v0.1 adds identity resolution
(`/v1/identify` binds a device to a person, `/v1/alias` merges two known
people, `GET /v1/persons/:id` reads one person's stitched profile back out —
see *Identity resolution* below), a segment query API for counting and
listing people matching a filter tree (see *Segments* below), a raw event feed
and time-bucketed counts (see *Reading events* below), per-person deletion and
export (see *Privacy: deletion and export* below), and a CLI that wraps all of
the read endpoints for scripts and agents (see [`packages/cli/README.md`](packages/cli/README.md)).

Ingest listens on port 3000. Every ingest request — `/v1/track`, `/v1/page`,
`/v1/identify`, `/v1/batch` — authenticates with the project's **write key**
in the `x-lyraflow-write-key` header. That key is public by design: it is safe
in browser JavaScript, and it can only write. `/v1/alias` and
`GET /v1/persons/:id` are the exception: see *Identity resolution* below for
why those two use the separate, secret server key instead.

```sh
curl -i http://localhost:3000/v1/track \
  -H 'content-type: application/json' \
  -H "x-lyraflow-write-key: $LYRAFLOW_WRITE_KEY" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  -d '{
    "message_id": "0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90",
    "anonymous_id": "visitor-1",
    "event": "signup",
    "properties": { "plan": "trial", "seats": 3 },
    "context": { "path": "/pricing", "utm_source": "newsletter" }
  }'
```

A successful call answers `202 Accepted` with `{"status":"accepted"}`.

**The `-A` is not decoration.** Lyraflow drops events whose `User-Agent` looks
automated — including curl's own default and a missing header — so that bots do
not inflate person counts. Without it this request still answers `202`, and the
event is silently discarded. Use a real browser `User-Agent` when testing by
hand; server-side senders should set one that identifies your service and does
not contain `bot`, `crawler`, `curl/`, `python-requests`, and similar tokens
(the full list is `packages/core/src/enrich/bots.ts`).

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/track` | A named thing a person did. Requires `event`. |
| `POST /v1/page` | A page or screen view. Optional `name`; defaults to `$page`. |
| `POST /v1/identify` | Attach traits to a known user. Requires `user_id`; stored as `$identify`. |
| `POST /v1/batch` | `{"batch": [ … ]}` — 1 to 500 items, each with an explicit `"type"` of `track`, `page`, or `identify`. |

`/health` (liveness), `/ready` (readiness), and `/metrics` (Prometheus text
format) are also served, and are not authenticated.

Sent directly from browser JavaScript (as opposed to a server-side SDK),
`/v1/track`, `/v1/page`, `/v1/identify` and `/v1/batch` are CORS-preflighted
requests. By default Lyraflow answers that preflight for any origin — set
`LYRAFLOW_ALLOWED_ORIGINS` (comma-separated) on the server to restrict it.
This is not a security boundary: the write key already ships in page source,
and any non-browser client ignores CORS entirely. What it buys is
tamper-evidence — stopping someone from pasting your write key on their own
site and quietly polluting your data — not access control. Leave it unset
and any origin is allowed, which is why a fresh install's tracking snippet
works on first paste with no configuration.

### Payload fields

| Field | Required | Notes |
| --- | --- | --- |
| `message_id` | yes | Client-generated UUID. Becomes the event's id; see *Retries* below. |
| `anonymous_id` | one of these two | Device/browser identifier, up to 128 characters. |
| `user_id` | one of these two | Known-user identifier, up to 128 characters. `identify` always requires it. |
| `event` | `track` only | Event name, up to 128 characters. |
| `name` | `page` only | Page name, up to 128 characters. Defaults to `$page`. |
| `properties` | no | Flat object. `track` and `page` only. |
| `traits` | no | Flat object. `identify` only. |
| `timestamp` | no | ISO-8601. Defaults to server time at receipt; see *Retries*. |
| `context` | no | `url`, `path` and `referrer`, up to 2048 characters each; `user_agent`, up to 1024; and the five `utm_*` fields, up to 128 each. |

Property and trait values may be strings, numbers, booleans, or null. Numbers
are stored in a numeric column and everything else as text, so `3` and `"3"` are
not interchangeable. Nested objects and arrays are not supported. An event may
carry up to 250 properties.

**A context field over its limit costs the whole event**, not just that field:
the event fails validation, is dead-lettered, and the response still says
`202` — with `rejected` counting it. This is easier to hit than it looks; an
OAuth callback URL carrying a `redirect_uri` clears 2048 characters without
trying. The browser SDK truncates `url`, `path`, `referrer` and `user_agent`
to these limits before sending, and warns on the console when it does. If you
are calling the HTTP API directly, truncate them yourself.

Client clocks are frequently wrong, so an explicit `timestamp` is clamped to
within 24 hours of server time.

### Responses

- `202` — accepted. **Also returned for malformed events and for events dropped
  as bot traffic**, deliberately: a tracking endpoint that returns an error
  breaks the customer's site. Malformed events are recorded in the
  `events_dead_letter` table with the reason; bot traffic is simply counted and
  discarded. `/metrics` reports the accepted/rejected/throttled totals, so a
  `202` that stored nothing is still visible there.
- `401` — missing or unknown write key.
- `503` with `retry-after: 5` — the server is saturated or shutting down. Retry.
- `400` / `413` — malformed JSON, or a body over 1 MiB. Retrying will not help.

`/v1/batch` always answers with counts: `{"accepted":n,"rejected":n,"throttled":n}`.
It returns `503` if the buffer saturates part-way through, with the counts
describing how far it got; retry the whole batch.

### Retries

Retry a `503` with the **same** `message_id`; it becomes the event's id (see
*Payload fields* above). A replayed event is never double-counted **as long as
your query selects `DISTINCT event_id`** (or otherwise aggregates by it) — a
plain `count(*)` can see it as two rows, and ClickHouse's `FINAL` modifier does
not rescue that when the retry omitted `timestamp` (see below). There is no
query API yet, so this is on you: it is the same discipline any ClickHouse
client of this table needs.

If you also send an explicit `timestamp` and replay it unchanged, the storage
engine's own row collapse — deterministic under `FINAL`, eventual otherwise —
removes the duplicate outright, so the retry costs no extra disk. Omit
`timestamp` and the server stamps each attempt with its own receipt time;
because that receipt time is part of the table's sort key, the two rows never
collapse — deduplicated only by querying `event_id` yourself, correct but not
free. Long-lived retry queues should send `timestamp`.

**That collapse has a 24-hour shelf life, and it expires silently.** The clamp
above rewrites any `timestamp` more than 24 hours from server time to the
boundary — a value computed from *now*, so it is different on every attempt.
A queue that drains within 24 hours of the original event collapses as
described. One that drains later does not: each retry is clamped to a
different instant, lands as another permanent row, and is also misdated to the
clamp boundary rather than when it happened. Nothing reports this. If your
retry queue can outlive a day, aggregate by `event_id` and treat the engine
collapse as an optimisation you do not have.

## Sending events from a browser

For a website or web app, `@lyraflow/sdk-browser` is a small script that calls
`/v1/track`, `/v1/page`, `/v1/identify` and `/v1/batch` for you, and handles
retries, an on-page queue, and (optionally) a consent gate. It is **not**
published to npm and there is no CDN: the server serves its own bundle, so a
self-hosted install never depends on infrastructure outside it.

Paste this before `</head>`:

```html
<script>
  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];
  ["init","track","page","identify","consent","reset","flush"].forEach(function(m){
    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});
  }();
</script>
<script async src="https://analytics.example.com/lyraflow.js"></script>
<script>
  lyraflow.init({ host: 'https://analytics.example.com', writeKey: 'wk_live_…' })
</script>
```

The first block is a stub: it queues any call made before the async script
finishes loading, so a `track()` fired the instant the page renders is never
lost to a race with the network. **`init` is queued the same way as every
other method** — the third block usually runs long before the async script
has loaded, which is exactly why `init` has to be in the stub's method list.
The moment the real script loads it replaces the stub on `window.lyraflow`
and takes the queue with it, running the queued `init` first whatever order
the calls were made in. On a repeat visit the cached script can run *before*
the third block; the queue is then held until that `init` arrives, and drained
by it. Either way nothing queued is lost. Replace both
occurrences of `https://analytics.example.com` with your own Lyraflow host,
and `writeKey` with the `wk_…` key from *Running Lyraflow* above — the same
one your server-side calls already use.

The bundle is served by the app itself at two paths, unauthenticated (a
`<script>` tag has no way to send a header):

| Path | Cache policy |
| --- | --- |
| `GET /lyraflow.js` | `max-age=300` — an upgrade reaches already-cached browsers within five minutes |
| `GET /lyraflow-<version>.js` (e.g. `/lyraflow-0.1.0.js`) | `max-age=31536000, immutable` — this exact version, forever |

Both paths are served gzipped to any client that accepts it, by the app
itself — putting a compressing proxy in front is a valid thing to do, but it
is not something you have to do to avoid shipping three times the bytes.

Use the bare `/lyraflow.js` path, as in the snippet above, unless you have a
specific reason to pin a version. If the sibling package was never built into
your image, both paths answer `503` rather than taking the rest of the server
down.

**The write key is public by design** — it is meant to sit in page source,
same as in any curl example above. It can only write events. The **server
key must never appear here or anywhere in browser-shipped code**: it merges
identities, reads and deletes person data, and runs segment queries — see
*Identity resolution*, *Segments*, and *Privacy* below for everything it
gates.

### Methods

`init()` must be called once, before anything else. Every other method is
silently dropped (and logs a console warning) if called first.

```js
lyraflow.init({
  host: 'https://analytics.example.com',
  writeKey: 'wk_live_…',
  cookieDomain: '.example.com', // optional; auto-detected if omitted, see below
  requireConsent: false,        // optional; default false, see Consent below
  autoPageView: false,          // optional; default false — fire one page() at init
  debug: false,                 // optional; default false — verbose console.debug logging
})
```

```js
lyraflow.track('signup', { plan: 'trial', seats: 3 })
```

```js
lyraflow.page()            // name defaults server-side to "$page"
lyraflow.page('Pricing')   // an explicit name
```

```js
lyraflow.identify('user-42', { plan: 'trial' })
```

```js
lyraflow.consent(true)   // or false — see Consent below
```

```js
lyraflow.reset()   // e.g. on logout: flushes, then rotates to a fresh anonymous id
```

```js
await lyraflow.flush()   // e.g. before a manual redirect the browser's own unload handling won't catch
```

Events are queued in `localStorage` and sent in batches to `/v1/batch` (see
*Sending your first event* above for that endpoint's own semantics), on a
timer and again on page unload using `fetch`'s `keepalive` option, so a
tab closed mid-batch still delivers what was already queued.

### Consent

Off by default (`requireConsent: false`): the SDK starts sending immediately,
the same as any other analytics snippet. Set `requireConsent: true` and it
starts in a **pending** state instead — nothing touches a cookie,
`localStorage`, or the network until `lyraflow.consent(true)` is called. (One
exception: if the browser already signals Do Not Track or Global Privacy
Control, `requireConsent: true` starts the gate **refused** outright, without
waiting for a call. With `requireConsent` left off, neither signal is read at
all — that compliance decision is left entirely to you.) Anything tracked
while pending is held in memory (not persisted) and released once consent is
granted; `lyraflow.consent(false)` discards it and stops the SDK from sending
anything further.

**A refusal cannot be remembered by the SDK.** Persisting "this visitor said
no" would itself mean writing a cookie or `localStorage` entry — exactly what
a refusal declines. Your application owns that choice: store it however you
already store consent decisions, and pass the outcome back in on the next
load (`requireConsent: false` once you know they said yes, or call
`lyraflow.consent(false)` again before anything else runs if they said no).

### `LYRAFLOW_ALLOWED_ORIGINS`

The CORS preflight restriction described in *Sending your first event* above
applies here too, since this is exactly what triggers it: the same
`LYRAFLOW_ALLOWED_ORIGINS` env var, and the same limit. It stops someone from
quietly reusing your write key on a different origin without you noticing —
it is **not** a security boundary, because the write key already ships in
page source and any non-browser sender ignores CORS entirely.

### Single-page apps

The SDK does not patch `history.pushState` or listen for route changes — call
`lyraflow.page()` yourself after each client-side navigation completes.

## Identity resolution

v0.1 stitches a device's anonymous activity to the person it belongs to, and
lets you merge two people that turn out to be the same one. Filtering and
segmentation are built on top of it — see [Segments](#segments) below — but
there is still no builder UI, journey analysis, or dashboards; see the note at
the top of this README.

### Binding a device to a person

Send `/v1/identify` with both `anonymous_id` and `user_id` to bind the device
to the person from that moment on:

```sh
curl -i http://localhost:3000/v1/identify \
  -H 'content-type: application/json' \
  -H "x-lyraflow-write-key: $LYRAFLOW_WRITE_KEY" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  -d '{
    "message_id": "3fa5e3fd-3c8b-4b8b-9b8e-6e3f9e5b8a01",
    "anonymous_id": "visitor-1",
    "user_id": "user-42",
    "traits": { "plan": "trial" }
  }'
```

The first time a device is bound, every event ever recorded under that
`anonymous_id` — before this `identify` call and after it — resolves to that
person, not just events going forward. If the device is later bound to a
*different* person (a shared computer, a re-identified session), the
timeline splits at that second `identify` call's own timestamp: events
before it keep the first person, events from it onward follow the second.
Resolution always follows the event's own (clamped) timestamp, never the time
the `identify` request happened to arrive at the server.

That time-split describes how an **event** is resolved to a person: it is the
rule applied row by row to the `events` table, and it is what a query over
those events sees. It is **not** how `GET /v1/persons/:id` counts a profile —
that read takes a simpler union over every id, with no timestamp condition,
and on a shared or rebound device the two deliberately disagree. *Reading a
person* below states exactly how.

**Sizing note: every `identify` with an `anonymous_id` writes a row.** That
includes the repeat `identify` a logged-in browser typically sends on every
page load. Repeats are not deduplicated: if you omit `timestamp`, each call
is stamped with server receipt time, so no two land on the same instant and
nothing collapses them. At 100k identified pageviews/day that is 100k rows
per day in Postgres' `identity_bindings`, growing without bound, and each row
is also carried into the ClickHouse identity dictionaries — which reload in
full every 5–15 seconds. If you send high identified volume, expect this to
be the fastest-growing table in your Postgres, and watch dictionary reload
time alongside it.

This is a known cost in v0.1, not an oversight. A write-side suppression
(skip the insert when the device is already bound to this person) was built
and then reverted: it is not safe against a late, out-of-order `identify`,
which can silently and permanently hand one person's later activity to
another. Correctness won. A safe fix belongs in the range derivation rather
than the write path; see `packages/server/src/identity/bindings.ts` for the
full reasoning and the reproduction.

Practical mitigation today: call `identify` once per session rather than once
per page view. Alternatively, send a **stable** explicit `timestamp` for
repeats of an unchanged binding — an identical
(`anonymous_id`, `user_id`, `timestamp`) triple collapses onto the existing
row and adds nothing. A `timestamp` that advances on every call does not
help; it is the repetition, not the presence, of the value that collapses
the write.

**Keep that stable value inside the 24-hour clamp window.** Bindings are
written at the event's *clamped* timestamp, so a fixed value — a session start
time, say — stops collapsing once it is more than 24 hours old: the clamp
rewrites it to a boundary computed from the current time, which moves on every
call, and each repeat writes a fresh row again. A session pinned at login and
still open two days later is the ordinary way to hit this. Re-pin the value at
least daily, or use the once-per-session call, which has no such expiry.

### Merging two people

`POST /v1/alias` merges two known people — an id migration, a duplicate
signup — under the **server key**, not the write key: aliasing mutates
identity for the whole project, so it must not be reachable with the public,
browser-shipped key.

```sh
curl -i http://localhost:3000/v1/alias \
  -H 'content-type: application/json' \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' \
  -d '{ "from_user_id": "user-42-old", "to_user_id": "user-42" }'
```

Answers `200` with `{"status":"merged"}`, or `{"status":"noop"}` if the two
ids already resolve to the same person. **Aliasing is not reversible in
v0.1** — there is no `unalias`, and merging `A` into `B` and then `B` into
`A` lands on `noop` rather than undoing the first merge. `400` for a missing
or empty `from_user_id`/`to_user_id`; `401` for a missing or invalid server
key. `503` with `retry-after: 5` — the merge runs in a `SERIALIZABLE`
transaction, so two merges touching the same alias group at the same moment
can make Postgres abort one of them (`40001`); the server answers `503`
rather than pretending the merge happened. Retry the identical request — it
is idempotent, and a merge that already succeeded answers `noop`.

### Reading a person

`GET /v1/persons/:id` returns one person's stitched profile — also server-key
only:

```sh
curl -i "http://localhost:3000/v1/persons/user-42" \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -A 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
```

```json
{
  "person_id": "user-42",
  "ids": ["user-42", "visitor-1"],
  "first_seen": "2026-08-01T12:00:00.000Z",
  "last_seen": "2026-08-06T09:30:00.000Z",
  "events": 14
}
```

`:id` can be any id that has ever pointed at this person — a device id, the
current canonical id, or an id since merged away by `/v1/alias` — and the
response always reflects the current, merged state. This read goes straight
to Postgres rather than through ClickHouse's identity dictionaries, so it
sees a binding or a merge the instant it is written, with no refresh delay.
`404` for an id nothing has ever recorded an event under; `401` for a missing
or invalid server key.

If `:id` is a **device id** that has been bound to more than one person over
time — a shared laptop — it resolves to the person bound **most recently**,
and the profile you get back is that person's. There is no single right
answer for a shared device, so this one is picked deliberately: it is the
device's current owner.

**This read is time-split, matching event resolution.** `first_seen`,
`last_seen` and `events` are computed the same way *Binding a device to a
person* (above) resolves an event: a device that has been shared or rebound
between two people splits at the rebind, and each profile counts only the
events that fell inside its own window on that device. An event that carries
a `user_id` of its own belongs to that person regardless of which device it
sits on, even during a stretch where the device itself was bound to someone
else. `ids` is unaffected by any of this — it stays the full set of ids ever
associated with the person, with no timestamp condition, because there is no
notion of an id being "in force" only some of the time.

A person's windows are their devices multiplied by however many times each
was rebound, which has no fixed bound. Past 200 device windows the request is
refused with `400`:

```json
{
  "error": "person_history_too_fragmented",
  "detail": "this person spans 214 device windows, above the limit of 200"
}
```

rather than silently widening the query to fit — widening a window is exactly
how the old union behaviour would come back.

## Segments

A segment is a filter tree. `POST /v1/segments/preview` runs one ad hoc,
without saving it; `POST /v1/segments` and friends (below) save one so it can
be named, re-run, and listed. Every segment endpoint is server-key only — the
write key ships in browser JavaScript, and a segment's count and membership
are aggregate information about everyone in the project.

```sh
curl -i http://localhost:3000/v1/segments/preview \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "ast_version": 1,
    "filter": {
      "kind": "group", "op": "and", "children": [
        { "kind": "trait", "key": "plan", "operator": "=", "value": "trial" },
        { "kind": "behavior", "event": "import_started", "aggregate": "count",
          "operator": ">=", "value": 3,
          "window": { "kind": "last", "n": 7, "unit": "days" } },
        { "kind": "not", "child": {
          "kind": "behavior", "event": "invite_teammate", "aggregate": "count",
          "operator": ">=", "value": 1, "window": { "kind": "ever" } } }
      ]
    }
  }'
```

That reads as *trial users who ran an import at least three times in the last
seven days but never invited a teammate*, and the response is:

```json
{
  "person_count": 128,
  "warnings": [],
  "as_of": "2026-08-07T09:30:00.000Z"
}
```

`as_of` is the instant the count describes. Events become queryable within
seconds rather than instantly, so a count is a recent answer, not a live one —
the timestamp says which answer you got instead of implying it is current. A
repeated preview of the same tree within a short window can be served from an
in-process cache; a cache hit still reports the `as_of` of the request that
actually computed it, never a fresher-looking timestamp than the count itself.

### Retrieving members, not just the count

Add `"include": ["members"]` to get one bounded page of the people matching,
alongside the same count:

```sh
curl -s http://localhost:3000/v1/segments/preview \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "ast_version": 1, "filter": { "kind": "trait", "key": "plan", "operator": "=", "value": "trial" }, "include": ["members"] }'
```

```json
{
  "person_count": 128,
  "warnings": [],
  "as_of": "2026-08-07T09:30:00.000Z",
  "members": [
    { "person_id": "user-42", "first_seen": "2026-07-01T00:00:00.000Z",
      "last_seen": "2026-08-06T09:30:00.000Z", "country": "US", "region": "CA",
      "city": "San Francisco", "device_type": "desktop", "os": "macOS",
      "browser": "Chrome", "referrer": "https://google.com",
      "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "launch" }
  ],
  "next_cursor": "eyJ...base64url...",
  "window_exhausted": false
}
```

Each member row carries `person_id`, `first_seen`, `last_seen`, and the ten
`context` fields (see *Node types* below) at their **current** value — not the
`first_touch` one, even for the four fields that are only ever recorded as
first-touch (see the caveat below `context` for why `latest` reads the same
value there). Traits are not returned: a per-person map of arbitrary size,
multiplied by a hundred rows, is unbounded by construction.

Pages are 100 rows, ordered `last_seen` descending. Pass the previous
response's `next_cursor` back as `cursor` to continue:

```sh
curl -s http://localhost:3000/v1/segments/preview \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "ast_version": 1, "filter": { "kind": "trait", "key": "plan", "operator": "=", "value": "trial" }, "include": ["members"], "cursor": "eyJ...base64url..." }'
```

`next_cursor` is `null` once there is no further page, or once the walk has
served 1,000 rows (10 pages) — `window_exhausted: true` marks that second
case specifically, so a caller can tell "you have seen everyone" apart from
"there is more, but not through this endpoint". This is a **preview of a
population, not an export of it**: there is no way to page past 1,000 rows,
and no point-in-time snapshot of membership is kept — re-running the same
segment later can return a different set as people's data changes. A cursor is
opaque, signed for the project that issued it, and rejected with `400` if
tampered with, built by hand, or replayed against a different project's server
key.

### Node types

| `kind` | Matches on |
| --- | --- |
| `group` | `and` / `or` over `children` |
| `not` | negates one `child` |
| `trait` | a trait set through `identify()` |
| `context` | country, region, city, device_type, os, browser, referrer, or a `utm_*` value, with `scope` of `latest` or `first_touch` |
| `lifecycle` | `first_seen` / `last_seen` |
| `behavior` | an event name (or `*` for any), aggregated as `count`, `sum`, `min`, `max`, or `distinct`, over a `last` / `absolute` / `ever` window |

Operators are `=`, `!=`, `>`, `>=`, `<`, `<=`, and `between`. `between` takes
exactly two values; every other operator takes exactly one.

One caveat on `context`: `referrer`, `utm_source`, `utm_medium` and
`utm_campaign` are recorded **only** as first-touch, because for an
acquisition attribute the original value is the one that means something. A
`scope` of `latest` on those four returns the first-touch value rather than a
different one. The other six fields record both.

`ast_version` is required and must be `1`. A tree saved today carries the
version it was written with, so a later release can migrate it rather than
silently reinterpret it.

### Warnings

`warnings` is advisory — the query still ran. Each entry names the node
responsible by path, so a builder UI can point at it:

```json
{
  "person_count": 4210,
  "warnings": [
    { "path": "filter.children[1]",
      "reason": "the `import_started` condition uses an `ever` window, which scans all history rather than a bounded window" }
  ],
  "as_of": "2026-08-07T09:30:00.000Z"
}
```

### Limits

A filter tree is bounded, because the endpoint is reachable by anyone holding
the server key:

| Limit | Value |
| --- | --- |
| Nesting depth | 10 |
| Total nodes | 100 |
| Behavioural conditions | 25 |
| Member page size | 100 rows |
| Member paging window | 1,000 rows (10 pages) per walk |

Exceeding a tree limit is a `400` naming which one:

```json
{ "error": "filter tree is nested deeper than 10 levels", "code": "depth" }
```

A malformed tree is also a `400`, with a per-field path:

```json
{
  "error": "invalid filter tree",
  "detail": [{ "path": "filter.value", "message": "`between` requires exactly two values; other operators require one" }]
}
```

A tree that is *valid* but too expensive to finish returns `422` — it exceeded
the query's time or memory ceiling. Narrow a window, or drop an `ever`, and
try again. `401` is a missing or invalid server key. A malformed or tampered
`cursor` is a `400` with an error mentioning `cursor`.

### Saved segments

A saved segment is a named, stored filter tree you can re-run without
resending it, and see listed alongside your others. Create one with
`POST /v1/segments`:

```sh
curl -i http://localhost:3000/v1/segments \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "name": "Trial power users", "ast_version": 1,
        "filter": { "kind": "trait", "key": "plan", "operator": "=", "value": "trial" } }'
```

```json
{
  "id": 17,
  "name": "Trial power users",
  "ast_version": 1,
  "filter": { "kind": "trait", "key": "plan", "operator": "=", "value": "trial" },
  "stale": false,
  "last_count": null,
  "last_evaluated_at": null,
  "created_at": "2026-08-07T09:00:00.000Z",
  "updated_at": "2026-08-07T09:00:00.000Z"
}
```

The tree is validated against the exact same shape and cost limits as
`/v1/segments/preview` — a `201` here is a guarantee it will also *run*
cleanly later, not merely that it parsed. A duplicate name within the same
project is a `409`.

| Method & path | Does |
| --- | --- |
| `GET /v1/segments` | List every segment in the project, name-ordered |
| `POST /v1/segments` | Create one |
| `GET /v1/segments/:id` | Read one |
| `PATCH /v1/segments/:id` | Rename it, replace its filter tree, or both |
| `DELETE /v1/segments/:id` | Delete it — `204` |
| `POST /v1/segments/:id/preview` | Run it and record the result |

`PATCH` accepts `name`, or `ast_version` + `filter`, or both. Sending a filter
clears the stored `last_count` / `last_evaluated_at` snapshot in the same
statement, because a stored count describes the tree it came from; a
rename-only `PATCH` leaves the snapshot untouched. A body that carries
`ast_version` or `filter` at all but fails to parse as a valid tree is
rejected with `400` and a field path, the same as a malformed body to
`POST /v1/segments` — it is never treated as a rename-only request.

`GET`, `PATCH`, and `DELETE` on a segment id that does not exist, or that
belongs to another project, both answer `404` — never `403`, which would
confirm the id exists. A non-numeric `:id` is a `400` naming
`invalid_segment_id`, rather than a `503` from an unbound query parameter.

`POST /v1/segments/:id/preview` runs the *stored* tree — it accepts the same
`include`/`cursor` body as the ad hoc preview endpoint and returns the same
shape, minus `warnings` (nothing to warn about a tree that already saved
cleanly) — and then records `last_count` / `last_evaluated_at` on the segment,
whichever output mode you asked for:

```sh
curl -s -X POST http://localhost:3000/v1/segments/17/preview \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
# {"person_count":128,"as_of":"2026-08-07T09:30:00.000Z"}
```

**A row that predates today's AST or caps is marked, not hidden.** If a stored
tree no longer parses — written by an older build, or against a schema
version this release no longer understands — `GET`/`PATCH`/`POST .../preview`
on that one segment return `400`:

```json
{ "error": "stored filter tree does not parse under ast_version 1", "ast_version": 1 }
```

but `GET /v1/segments` never fails the whole list for one bad row. That
segment appears with `"filter": null, "stale": true` so you can still see it,
rename it, or delete it, while every other segment in the list renders
normally — every listed segment carries `stale` (`false` for an ordinary one)
so a client can check the one field regardless of which route the row came
from.

### Autocomplete: event and property names

`GET /v1/schema/events` and `GET /v1/schema/properties` list the event names
and property keys a project has recorded — the raw source a segment builder's
autocomplete can be built on. Both are server-key only, for the same reason as
`/v1/segments/preview`: a project's event taxonomy describes its product, and
the browser-shipped write key must not be able to read it.

**Only events carrying at least one property are discoverable this way.** Both
endpoints read from `event_schema`, which is fed by an `ARRAY JOIN` over each
event's property map — an event with an empty map produces no rows at all, so
it is invisible to `/v1/schema/events` too, not merely absent from
`/v1/schema/properties`. A `retry_semantics` event with no properties will
never show up in an events autocomplete built on this endpoint, even though it
is sitting in `events` right now. If your product sends property-less events
you want to filter or discover this way, give them at least one property.

```sh
curl -s http://localhost:3000/v1/schema/events?q=import \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
# {"events":[{"event_name":"import_started"}]}

curl -s http://localhost:3000/v1/schema/properties?event=import_started \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
# {"properties":[{"property_key":"rows","value_kind":"number"},{"property_key":"source","value_kind":"string"}]}
```

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `q` | both | prefix filter, matched against the event name or property key |
| `event` | properties only | restrict to one event's properties |
| `limit` | both | max rows to return, default 50, capped at 100 |

`limit` above 100 is rejected with `400`, not silently truncated. Results are
**name-ordered and unranked** — no frequency or recency signal, because
`event_schema` carries no counts. Deliberately thin: prefix vs. fuzzy
matching, and ranking by frequency, recency, or name, are questions for
whichever builder UI ends up consuming this: this ships the raw read any of
those can be built on top of, rather than a guess at one of them.

### What this does not do yet

There is **no builder UI** — every segment above is built and run through the
HTTP API directly, in JSON. There is **no export** of a segment's membership:
the members endpoints are a bounded 1,000-row preview, not a way to pull an
entire population out. There is **no point-in-time membership** — a saved
segment stores its last count and when it was computed, not who was in it at
that moment, so you cannot ask "who matched this segment last Tuesday".
Membership is also not recomputed automatically on any schedule; a saved
segment's snapshot only updates when you explicitly run it. Those are
planned; none of them exist today.

## Reading events

Two read endpoints answer "what happened" and "how much, over time" directly
against the event store, with no filter tree to write first — the first thing
anyone reaches for after instrumenting a site. Both are **server-key only**,
like every other read below, and both **exclude events belonging to a person
who has been deleted** — the same suppression boundary every other read path
enforces (see *Privacy: deletion and export* below) applies here too, from the
moment a deletion is accepted, not only once the purge finishes.

### `GET /v1/events`

The event feed, always ordered oldest-first:

```sh
curl -s "http://localhost:3000/v1/events?since=2026-08-09T03:16:00.000Z&limit=2" \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
```

```json
{
  "events": [
    { "event_id": "22222222-2222-2222-2222-222222222223", "timestamp": "2026-08-09T03:17:34.357Z", "event_name": "signup", "anonymous_id": "visitor-3", "user_id": "", "properties": {"plan":"trial"}, "properties_num": {}, "url": "", "path": "", "referrer": "", "utm_source": "", "utm_medium": "", "utm_campaign": "", "utm_term": "", "utm_content": "", "device_type": "desktop", "os": "macos", "browser": "chrome", "country": "", "region": "", "city": "" },
    { "event_id": "22222222-2222-2222-2222-222222222224", "timestamp": "2026-08-09T03:17:34.364Z", "event_name": "signup", "anonymous_id": "visitor-4", "user_id": "", "properties": {"plan":"trial"}, "properties_num": {}, "url": "", "path": "", "referrer": "", "utm_source": "", "utm_medium": "", "utm_campaign": "", "utm_term": "", "utm_content": "", "device_type": "desktop", "os": "macos", "browser": "chrome", "country": "", "region": "", "city": "" }
  ],
  "next_cursor": "WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM2NCIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNCJd"
}
```

| Parameter | Meaning |
| --- | --- |
| `since` | ISO 8601 datetime — only events at or after this instant |
| `until` | ISO 8601 datetime — only events at or before this instant |
| `event` | exact event name |
| `person` | a person id, resolved exactly the way `GET /v1/persons/:id` resolves one (alias and device-id lookup — see *Identity resolution* above) |
| `limit` | events per page, default 50, capped at 500 |
| `after` | an opaque cursor from a previous response's `next_cursor`, to continue from there |

**When `since` is omitted and no cursor (`after`) is given either, the server
defaults to the last 24 hours.** That default deliberately does not apply once
a cursor is present: a cursor already carries its own lower bound, and
stacking the 24-hour default on top of an older cursor would silently drop
every event between the cursor's real position and the default's edge — a gap
that, once `next_cursor` has advanced past it, is never reachable again. An
explicit `since` alongside a cursor still applies normally; it is only the
*default* that backs off in a cursor's presence.

`next_cursor` is a **keyset position over `(timestamp, event_id)`, and
opaque** — treat it as an opaque token, never decoded or constructed by hand.
Unlike the segment cursor above, it is not signed: forging one only lets a
caller holding the server key read their own project's events in a different
order, which they could already do by choosing their own `since`/`until`, so
there is nothing here for a signature to protect. `next_cursor` is `null` on
an empty page. `limit` above 500 is rejected with `400 {"error":"invalid_query"}`,
never silently clamped.

### `GET /v1/events/stats`

Time-bucketed counts — "how much, over time" rather than "what happened":

```sh
curl -s "http://localhost:3000/v1/events/stats?since=2026-08-09T03:00:00.000Z&interval=1h" \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
```

```json
{ "buckets": [ { "bucket": "2026-08-09T03:00:00.000Z", "events": 8 } ] }
```

Add `group_by=event_name` to split each bucket by event name — `event_name`
is present on a bucket **only** when grouping was requested:

```json
{ "buckets": [ { "bucket": "2026-08-09T03:00:00.000Z", "event_name": "signup", "events": 8 } ] }
```

| Parameter | Meaning |
| --- | --- |
| `since` | ISO 8601 datetime |
| `until` | ISO 8601 datetime, defaults to now |
| `interval` | `1m`, `1h`, or `1d`; default `1h` |
| `group_by` | only `event_name` is accepted |

**There is a hard cap of 1,000 buckets per request.** This route sums groups
server-side rather than paging rows, so unlike the feed it has no `limit` to
hide an oversized window behind — a window whose bucket count at the
requested resolution would exceed 1,000 is rejected before any query runs:

```json
{ "error": "window_too_large", "detail": "this window at 1h resolution would produce 57892 buckets, above the limit of 1000" }
```

**The default window, when `since` is omitted, scales with `interval`** rather
than a single fixed span — a flat 24-hour default collides with the
1,000-bucket cap at fine resolutions, so a bare `?interval=1m` with nothing
else would otherwise be an unconditional `400`:

| `interval` | Default window when `since` is omitted |
| --- | --- |
| `1m` | 1 hour |
| `1h` | 24 hours |
| `1d` | 7 days |

`401` for a missing or invalid server key, on both endpoints.

## Privacy: deletion and export

`DELETE /v1/persons/:id` erases a person's data — the same subject
`GET /v1/persons/:id` describes: the id is resolved through the same alias and
device-id lookup, so deleting a device id or a since-merged id reaches the
right person. Server-key only, like every endpoint below it that reads or
mutates a person's data.

```sh
curl -i -X DELETE http://localhost:3000/v1/persons/user-42 \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
```

```json
{
  "request_id": 118,
  "person_id": "user-42",
  "suppressed_at": "2026-08-07T09:30:00.000Z"
}
```

`person_id` is the **canonical** id, which can differ from the one you sent —
deleting an id that was later merged into another still resolves to, and
erases, the survivor of that merge. `suppressed_at` is the boundary: events at
or before it stop appearing anywhere, immediately.

The boundary belongs to the **person**, not to the single id you named, and a
person is every id merged into them. So the boundary that applies to a read
can move as identities merge: if two people who were each deleted at different
times are later merged with `/v1/alias`, the surviving person carries the
**later** of the two boundaries, and events after the earlier deletion but at
or before the later one become hidden too.

That direction holds for the profile read and the export, which resolve the
whole merged group and take the strictest boundary in it. **It does not hold
for segment counts and member lists.** Those resolve a person through the
identity dictionaries and read whichever person the merge produced — so merging
a recently-deleted person *into* one deleted earlier can make some of the first
person's erased events countable in a segment again, until the purge worker
removes the rows for real. This only ever concerns subjects who have already
been deleted, it is bounded by the purge (usually under a minute), and no
never-deleted person is affected. If you need the guarantee to be absolute
rather than eventual, wait for `GET /v1/deletions/:id` to report `completed`
before treating a deletion as final — which is the right thing to do anyway,
since only the purge actually removes data.

Deletion is asynchronous. The moment the API answers `202`, the person's past
data stops appearing in segment counts, member lists, profile reads and
exports — that is the suppression list, and it takes effect immediately,
including for a `/v1/segments/preview` result already sitting in the
in-process cache (see *Segments* above): a `DELETE` clears that
project's cached entries as part of the same request. The rows are then
erased for real by a worker inside the server process, usually within a
minute. Until it finishes, person-level aggregates (`first_seen`, `last_seen`,
event counts) can still reflect erased events for someone whose activity
straddles the deletion instant, because those are pre-aggregated per month
and a month cannot be split. Event-level reads are exact throughout. Poll
`GET /v1/deletions/:id` for `status: "completed"`.

**A saved segment's `last_count` does not know a deletion happened.** It is a
snapshot from whenever the segment was last run (`POST /v1/segments/:id/preview`
or its own creation), not a live figure — a deletion changes what an ad hoc
`/v1/segments/preview` reports on the very next call, but it does not touch
`last_count` on any saved segment, which stays exactly as stale as it already
was until something explicitly re-runs that segment. This is true regardless
of caching; it is simply what "snapshot, not a live count" already meant.

Suppression is scoped in time, not permanent. Erasure is a right to have past
data deleted, not a promise never to be measured again — if the same user
keeps using your application, they eventually reappear as a person with a
history of their own.

**But that history does not start at the `202`.** Under suppression alone,
an event recorded between the `202` and the purge finishing genuinely is
visible — every read path filters by the boundary, and this new event is
after it. The purge, though, is not boundary-aware: by design, it deletes
*every* event the person has, with no "at or before `suppressed_at`" clause
— honouring the boundary here would mean keeping the identity bindings that
say those events are this person's, and unsuppressed bindings for a deleted
person are the exact leak the purge's step order exists to prevent. So an
event landing in that gap is shown by every read path for the minute or so
the purge takes, and then erased along with everything older. The person's
surviving history begins after the **purge completes**, not after the
request is accepted, and activity recorded in that gap does not survive — it
is erased with the rest. Requesting deletion again moves the boundary
forward and erases whatever accumulated since, including while a previous
request is still waiting on the purge worker, which is exactly the case an
operator re-requesting after a failed attempt needs to work. If a previous
request failed part way through — its events already erased, its identity rows
not — the repeat `DELETE` reopens **that** request and returns its original
`request_id`, instead of reporting the now-eventless person as `404`. Once the
purge has actually *finished*, a repeat request for a person with no activity
since then finds nothing left to erase, and answers `404` like any other id
nothing has recorded.

**Not covered:** backups. Lyraflow deletes from the live stores it manages. A
backup you took before the deletion still contains the person's data, and
restoring it will restore them — the suppression list itself is in Postgres
and is backed up with it, so a restored person stays hidden from queries, but
their rows are back. Rotating or re-taking backups after a deletion is the
operator's responsibility, and this is stated rather than pretended.

One exception to "stays hidden": a device the erased person used, later
bound to a genuinely DIFFERENT person, then a backup from before the
deletion restored after that. The erased person's anonymous activity on that
device is attributed by device id when nothing else claims it; once someone
else's identity has since taken over that device, a restored anonymous event
resolves to the NEW person instead, and nothing hides it — it appears as
theirs, inflating their history. This needs all three of the purge having
completed, that device rebound to someone else, and a backup predating the
original deletion restored afterwards; a person's own identified events
(anything carrying its own user id) are unaffected regardless. Narrow, and
stated rather than silently left for an operator to discover.

A deletion request with no subject is `404`:

```json
{ "error": "person_not_found" }
```

**Read that `404` carefully — it does not mean "this id was never seen."** It
means no events could be resolved *for a person* from the id you sent. Erasure,
export and the profile read all cover people the **identity graph** knows
about, and an id only enters that graph through `/v1/identify` (or `/v1/alias`).
A purely anonymous visitor — an `anonymous_id` that has sent events but has
never been identified — cannot be resolved from that `anonymous_id` alone, and
answers `404` here even though their events are sitting in the store. If you
have been handed a raw cookie or device id by a data-subject request and get a
`404`, that is the case to rule out first: it is not evidence the id was never
recorded. Resolve it to a user id (anything you have ever called `/v1/identify`
with for that device) and request erasure for that instead. Widening resolution
to cover never-identified visitors is a change we intend to make; today it is a
documented limit rather than a silent one.

`401` for a missing or invalid server key.

### Checking on a deletion

`GET /v1/deletions/:id` reports what happened to a request returned by the
`DELETE` above:

```sh
curl -s http://localhost:3000/v1/deletions/118 \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
```

```json
{ "status": "completed", "requested_at": "2026-08-07T09:30:00.000Z", "completed_at": "2026-08-07T09:30:41.000Z" }
```

| `status` | Meaning |
| --- | --- |
| `pending` | Waiting for the purge worker. If an attempt has already failed, `error` carries why and the request is waiting to be retried |
| `in_progress` | A worker is erasing this person's rows right now |
| `completed` | Erasure finished — `completed_at` is set |
| `failed` | The worker gave up after repeated attempts; `error` carries the last one. This is not an API error — the request was accepted, and this is telling you it did not finish |

**`failed` does not mean nothing happened.** The purge erases in a fixed order
— events first, identity last — so a request that failed part way through has
usually already deleted some of the person's data. Treat `failed` as "partly
erased, stopped", never as "no change". The recovery is to send the same
`DELETE /v1/persons/:id` again: it picks the unfinished request back up and
returns `202` with **the same `request_id`**, rather than `404`-ing a person
whose events are already gone. Keep polling that id.

`:id` belonging to another project, or to no request at all, is `404` with
`{ "error": "deletion_not_found" }` — never `403`, which would confirm the id
exists. A non-numeric `:id` is `400` with `{ "error": "invalid_deletion_id" }`.

### Exporting a person

`GET /v1/persons/:id/export` answers a subject-access request: everything
Lyraflow has recorded about one person, as streamed NDJSON — one JSON object
per line, not a single JSON document. Server-key only, like every endpoint in
this section.

```sh
curl -s http://localhost:3000/v1/persons/user-42/export \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
```

```json
{"type":"person","person_id":"user-42","ids":["user-42","visitor-1"],"traits":{"plan":"pro"},"first_seen":"2026-08-01T12:00:00.000Z","last_seen":"2026-08-06T09:30:00.000Z"}
{"type":"event","event_id":"…","timestamp":"2026-08-01T12:00:00.000Z","event_name":"page","properties":{…},…}
{"type":"event","event_id":"…","timestamp":"2026-08-06T09:30:00.000Z","event_name":"import_started","properties":{…},…}
{"type":"end","events":2}
```

Three line shapes. The first line is always `type: "person"` — the same
identity `GET /v1/persons/:id` returns (`person_id`, `ids`, `first_seen`,
`last_seen`), plus `traits`, and *without* that read's `events` count: the
count moved to the terminator below, where it can be checked against what
was actually received. Then one `type: "event"` line per event, oldest
first, carrying every field recorded for it. The last line is always `type:
"end"`, and `events` is the number of `event` lines that actually preceded
it.

**The export is a stream, and it terminates itself.** The response status and
headers are sent before the first line, which means a failure part-way
through cannot be reported as an HTTP error — the connection would already
be committed to `200`. Instead, on a mid-stream failure the response simply
ends without ever writing the final `end` line. **A response without a
final `{"type":"end","events":N}` line is incomplete and must be discarded.**
Always check for that line, and check that its `events` count matches the
number of `event` lines you actually received — a truncated response that
happens to look complete is exactly the failure a subject-access export
cannot afford to miss.

The export honours deletion the same way the person read does: a person who
has been deleted exports only the events recorded after the deletion
boundary, and a person with nothing left after that boundary is `404`, the
same `{ "error": "person_not_found" }` an unresolvable id gets. As with
`DELETE`, that `404` also covers a visitor who has never been through
`/v1/identify` — see *Deleting a person* above, where the same limit is
described in full. An `anonymous_id` alone is not enough to export a subject.
Traits are omitted entirely once a boundary exists — a trait carries no
event time (it is the *latest* value known for that key, not a timestamped
fact), so it cannot be split at the deletion instant the way an event can;
returning it would be a way to read back exactly what the deletion asked to
remove.

The same device-window cap `GET /v1/persons/:id` enforces applies here too:
past 200 device windows the export answers `400`
`person_history_too_fragmented`, identically to the person read. Unlike
`DELETE /v1/persons/:id`, which chunks and must never refuse to erase the
most fragmented people, refusing to *render* an export for them is an
acceptable answer — nothing about their data goes unerased because of it.

Every query behind this endpoint runs under a ceiling — 300 seconds and the
same 4 GiB memory ceiling segment queries use. For almost every person this
is invisible; for someone with an exceptionally large recorded history,
hitting one is expected behaviour, not a bug, but which one you hit produces
a different, distinguishable symptom, and it matters which:

- The **summary** query and, when it runs, the **traits** lookup both
  execute *before* the response is sent at all. If either one hits a
  ceiling, the export never starts: you get a `503` — the same generic
  failure response every other endpoint gives an internal error, with
  `retry-after` set.
- The **per-event** query streams *after* the response has already started.
  If it hits a ceiling partway through, the export cannot become an HTTP
  error any more — the stream simply ends, without its final `end` line,
  exactly like any other mid-stream failure above. This is the only one of
  the three the discard rule was written for.

If you self-host and an export is being cut short for one particular
person, an unusually large history hitting one of these ceilings is the
first thing to check: a `503` means it never started, a response missing
`end` means it started and was cut short — before assuming either is a bug.

`401` for a missing or invalid server key.


## Upgrading

```sh
docker compose pull || docker compose build
docker compose down
docker compose up -d
```

The `|| docker compose build` covers the period before the first image is
published; once it is, the pull succeeds and the build never runs.

Migrations run automatically on boot, and accepted events are flushed before
shutdown, so no events are lost across an upgrade. Identity bindings and
aliases live in Postgres and survive the same way; the ClickHouse identity
dictionaries are rebuilt from that data on every boot, not migrated, so a
restart never leaves them stale or missing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We'd love your help once the foundation is in place.
