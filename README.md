# Lyraflow

**Self-hosted, end-to-end customer journey intelligence and analytics.**

Lyraflow helps you understand the full path your customers take — from first touch to conversion, retention, and beyond — on infrastructure you control. Your customer data stays yours.

> ⚠️ **Early days.** Lyraflow currently ships the ingest spine — you can self-host it, create a project, and send it events over the HTTP API. There is no query API and no UI yet (filtering, journeys, dashboards). Watch the repo to follow along.

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

The **server key** (`sk_…`) is secret and shown only once. It is not needed for
sending events; later releases use it for reading, deletion, and export.

## Sending your first event

Everything below is the whole of v0.1's public surface. There is no UI and no
query API yet — events land in ClickHouse, and you read them with your own
ClickHouse client until the query layer ships.

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

## Upgrading

```sh
docker compose pull || docker compose build
docker compose down
docker compose up -d
```

The `|| docker compose build` covers the period before the first image is
published; once it is, the pull succeeds and the build never runs.

Migrations run automatically on boot, and accepted events are flushed before
shutdown, so no events are lost across an upgrade.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We'd love your help once the foundation is in place.
