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

Ingest listens on port 3000. Every `/v1/*` request authenticates with the
project's **write key** in the `x-lyraflow-write-key` header. That key is public
by design: it is safe in browser JavaScript, and it can only write.

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

Retry a `503` with the **same** `message_id`. Every query deduplicates by event
id, so a replayed event is never double-counted.

If you also send an explicit `timestamp` and replay it unchanged, the storage
engine collapses the replayed rows outright, so the retry costs no extra disk.
Omit `timestamp` and the server stamps each attempt with its own receipt time,
which leaves the retried copy on disk as a duplicate row — correct in every
query, just not free. Long-lived retry queues should send `timestamp`.

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
key.

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
