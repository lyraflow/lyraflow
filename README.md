# Lyraflow

**Self-hosted, end-to-end customer journey intelligence and analytics.**

Lyraflow helps you understand the full path your customers take — from first touch to conversion, retention, and beyond — on infrastructure you control. Your customer data stays yours.

> ⚠️ **Early days.** Lyraflow currently ships the ingest spine and identity resolution — you can self-host it, create a project, send it events, and stitch anonymous and known activity into one person. There is no query API and no UI yet (filtering, journeys, dashboards). Watch the repo to follow along.

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
`GET /v1/persons/:id` (see *Identity resolution* below), and later releases
use it for deletion and export too. The *Identity resolution* examples use it
the same way:

```sh
export LYRAFLOW_SERVER_KEY=sk_...  # the server key printed above
```

## Sending your first event

Everything below is the whole of v0.1's public surface. There is still no UI
and no general query API (filtering, journeys, dashboards) — events land in
ClickHouse, and you read them with your own ClickHouse client until the query
layer ships. What v0.1 does add is identity resolution: `/v1/identify` binds a
device to a person, `/v1/alias` merges two known people, and
`GET /v1/persons/:id` reads one person's stitched profile back out — see
*Identity resolution* below.

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
| `context` | no | `url`, `path`, `referrer`, `user_agent`, and the five `utm_*` fields. |

Property and trait values may be strings, numbers, booleans, or null. Numbers
are stored in a numeric column and everything else as text, so `3` and `"3"` are
not interchangeable. Nested objects and arrays are not supported. An event may
carry up to 250 properties.

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

## Identity resolution

v0.1 stitches a device's anonymous activity to the person it belongs to, and
lets you merge two people that turn out to be the same one. There is no
filtering or segmentation on top of this yet — see the note at the top of
this README.

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

A segment is a filter tree, and `POST /v1/segments/preview` answers one
question about it: **how many people match?** It is server-key only — the
write key ships in browser JavaScript, and a segment count is aggregate
information about everyone in the project.

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
the timestamp says which answer you got instead of implying it is current.

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

Exceeding any of them is a `400` naming which one:

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
try again. `401` is a missing or invalid server key.

### Autocomplete: event and property names

`GET /v1/schema/events` and `GET /v1/schema/properties` list the event names
and property keys a project has actually recorded — the raw source a segment
builder's autocomplete can be built on. Both are server-key only, for the same
reason as `/v1/segments/preview`: a project's event taxonomy describes its
product, and the browser-shipped write key must not be able to read it.

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

Only counting is implemented. There is **no saved-segment API** — no way to
name a segment, store it, or list stored ones — and **no way to retrieve the
members** of a segment, only to count them. Segment membership is also not
recomputed or tracked over time. Those are planned; none of them exist today.


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
