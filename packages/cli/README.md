# `@lyraflow/cli`

A small, dependency-light CLI over Lyraflow's read API — the event feed,
time-bucketed counts, a person's profile, saved segments, and the event/
property schema — built for scripts and for agents driving Lyraflow directly
from a terminal, not for browsing. It wraps `GET /v1/events`,
`GET /v1/events/stats`, `GET /v1/persons/:id`, `GET /v1/persons/:id/export`,
`DELETE /v1/persons/:id`, `GET /v1/deletions/:id`, `GET /v1/segments`,
`POST /v1/segments/:id/preview`, `GET /v1/schema/events` and
`GET /v1/schema/properties` — see the main [README](../../README.md) for what
each of those endpoints actually does; this document is about the CLI's own
surface on top of them.

`create-project`, `migrate`, and `healthcheck` are separate, operational
commands this binary also ships (used once per install, not per query) — see
*Running Lyraflow* in the main README for those. Everything below is the
read-oriented surface.

## Running it

Inside a running install, the binary is already built at
`packages/cli/dist/index.js`:

```sh
docker compose exec -e LYRAFLOW_HOST=http://localhost:3000 -e LYRAFLOW_SERVER_KEY=$LYRAFLOW_SERVER_KEY \
  lyraflow node packages/cli/dist/index.js events --since 1h --json
```

Building from a checkout (`pnpm build` at the repo root, or
`pnpm --filter @lyraflow/cli build`) produces the same `dist/index.js`, runnable
directly with `node` wherever it can reach your Lyraflow host — self-hosted
Lyraflow, not npm or a CDN, so there is no `npx lyraflow`. The examples below
assume the environment is already configured (see *Configuration*) and just
show `lyraflow <command>`.

## Configuration

Every read command needs a host and the project's **server key** — the same
secret key that gates `GET /v1/persons/:id` and everything else server-key-only
in the main README, never the public write key:

| Variable | Meaning |
| --- | --- |
| `LYRAFLOW_HOST` | Base URL of your Lyraflow server, e.g. `http://localhost:3000` |
| `LYRAFLOW_SERVER_KEY` | The project's server key (`sk_…`) |

```sh
export LYRAFLOW_HOST=http://localhost:3000
export LYRAFLOW_SERVER_KEY=sk_...
```

`--host` and `--server-key` override the environment variables for one
invocation. An explicit, non-empty flag always wins; an *empty* `--host=` or
`--server-key=` falls back to the environment variable instead of silently
becoming a blank value:

```sh
lyraflow events --host http://staging:3000 --server-key sk_staging_... --json
```

Missing both the flag and the env var for either one is a usage error (exit
`2`) before any request is sent:

```
Error: LYRAFLOW_HOST and LYRAFLOW_SERVER_KEY must be set (or pass --host/--server-key) (usage_error)
```

## `--json` is the stable interface; the table is not

Every command supports `--json` and `--human`. **`--json` is the documented,
versioned contract — field names, types, and the absence of a wrapper object
are promised and change only with a bump to `output_schema`** (see
`lyraflow --version` below). The human-readable table is not part of that
contract: it can gain columns, lose them, or be reformatted entirely in any
release, because it exists for a person glancing at a terminal, not for a
program to parse.

Without either flag, the CLI guesses from whether stdout is a terminal —
`--human` when it is, `--json` otherwise. **An agent should pass `--json`
explicitly rather than rely on that detection.** Detection is a real footgun:
the same command can render differently depending on how it happens to be
invoked (a real terminal vs. a pty-allocated harness vs. a pipe), which is
exactly the "works in my terminal, breaks in CI" failure mode `--json` exists
to route around. When both `--json` and `--human` are passed, `--json` wins.

`json` mode is NDJSON: one `JSON.stringify`d record per line for a list, one
line for a single record — no wrapping array, no header row. An empty list
prints nothing at all, in either mode.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The request reached the API and was rejected, or (for `persons delete` specifically) the deletion was declined |
| `2` | Usage error — nothing was ever sent to the API |

An agent can branch on these without parsing any output.

```sh
lyraflow events --limit 99999 --json
# {"error":"--limit must be at most 500, got 99999","code":"usage_error"}
# exit 2 — never sent

lyraflow events --server-key sk_wrong --json
# {"error":"the server key was rejected","code":"invalid_server_key"}
# exit 1 — sent, rejected
```

**Piping into something that exits early is still success.** `lyraflow events
--json | head -2` exits `0` — a closed reader (`head`, `less`, a script that
stops consuming) is a normal end for a streaming command, not a failure, and
is handled both for a synchronous write failure and for the asynchronous
`EPIPE` a real closed pipe produces on `process.stdout`.

## `lyraflow events`

```
lyraflow events [--since] [--until] [--event] [--person] [--limit] [--after] [--follow] [--json|--human]
```

Wraps `GET /v1/events` — see *Reading events* in the main README for the wire
contract this passes through unchanged. `--since`, `--until`, `--event`,
`--person`, `--limit`, and `--after` map directly to that endpoint's query
parameters.

**When you omit `--since` and don't pass `--after`, this CLI defaults `--since`
to the last 15 minutes** — narrower than the server's own 24-hour default,
deliberately: "is my instrumentation working right now" is the question this
command exists to answer at a terminal, and a full day scrolling past is not
what that wants. Verified against a live server:

```sh
lyraflow events --since 1h --limit 2 --json
```
```json
{"event_id":"22222222-2222-2222-2222-222222222223","timestamp":"2026-08-09T03:17:34.357Z","event_name":"signup","anonymous_id":"visitor-3","user_id":"","properties":{"plan":"trial"},"properties_num":{},"url":"","path":"","referrer":"","utm_source":"","utm_medium":"","utm_campaign":"","utm_term":"","utm_content":"","device_type":"desktop","os":"macos","browser":"chrome","country":"","region":"","city":""}
{"event_id":"22222222-2222-2222-2222-222222222224","timestamp":"2026-08-09T03:17:34.364Z","event_name":"signup","anonymous_id":"visitor-4","user_id":"","properties":{"plan":"trial"},"properties_num":{},"url":"","path":"","referrer":"","utm_source":"","utm_medium":"","utm_campaign":"","utm_term":"","utm_content":"","device_type":"desktop","os":"macos","browser":"chrome","country":"","region":"","city":""}
```

`--limit` is validated client-side against the server's own cap (500) before
anything is sent — see *Exit codes* above for what an over-large `--limit`
looks like.

### stderr carries more than errors

Two things land on stderr besides a genuine error, both rendered through the
same `--json`/`--human` machinery as everything else — under `--json` each is
a JSON object, one per line, not prose:

- **The resume cursor.** After a non-`--follow` run (or a `--follow` session
  that stops), the last `next_cursor` seen is written to stderr so a caller
  can resume later without a separate request:

  ```
  {"next_cursor":"WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM3MSIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNSJd"}
  ```

  Feed it back with `--after` to continue exactly where the last run left off:

  ```sh
  lyraflow events --after 'WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM3MSIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNSJd' --json
  ```

- **A truncation warning.** A *cursorless* poll (the very first one, or the
  first after an empty one) that comes back with exactly `--limit` events
  cannot tell "that was everything" from "a burst pushed older events out of
  the page" — the CLI says so, loudly, naming the oldest event actually shown.
  Captured against a live server with a deliberately small `--limit`:

  ```
  {"warning":"this page hit --limit 3; events older than 2026-08-09T03:17:34.357Z in this window may exist and were not shown — rerun with the same --since and --until 2026-08-09T03:17:34.357Z to see them, or increase --limit"}
  {"next_cursor":"WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM3MSIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNSJd"}
  ```

  Note what the warning recommends: narrowing `--until`, not `--since` — a
  cursorless request always answers with the newest `--limit` events in the
  window, so narrowing `--since` only widens the window at the far end and
  returns the identical page.

### `--follow`

Polls every 2 seconds, using the server's own cursor once one exists. Be
precise about what this guarantees and what it does not:

- **Once a cursor exists, nothing already seen is repeated, and nothing after
  it is missed** — every later poll asks for `after: <cursor>` and nothing
  else, never a `since` that could re-scan or drift.
- **A cursorless poll is a tail, not a full scan.** If more than one page's
  worth of events arrived before the first poll (or the first poll after an
  empty one) runs, only the newest page is shown, and the truncation warning
  above fires on stderr naming the oldest event actually shown — the older
  ones in that burst are gone from `--follow`'s perspective the moment the
  cursor advances past them.
- **An event delivered late, but timestamped before the current cursor
  position, can still be missed.** Ingest admits events up to 24 hours behind
  the server's own clock (clock skew), and forward-only keyset paging has no
  way to notice a row landing behind where it has already moved past. This is
  inherent to the paging scheme, not a bug this CLI works around.

`--follow` exits `0` when interrupted cleanly (e.g. `Ctrl-C`), writing the
resume cursor to stderr first, same as a normal non-`--follow` run.

## `lyraflow stats`

```
lyraflow stats [--since] [--until] [--interval] [--by-event] [--json|--human]
```

Wraps `GET /v1/events/stats`. `--interval` is one of `1m`, `1h`, `1d` (default
`1h`); `--by-event` requests `group_by=event_name` on the wire.

```sh
lyraflow stats --by-event --json
```
```json
{"bucket":"2026-08-09T03:00:00.000Z","event_name":"signup","events":8}
```

**When `--since` is omitted, this CLI computes a default scaled to
`--interval`** — the same per-interval table the server itself defaults to
(see *Reading events* in the main README: 1 hour at `1m`, 24 hours at `1h`,
7 days at `1d`) — anchored to `--until` when you gave one, or to now
otherwise. This is what lets a bare `lyraflow stats --interval 1m` succeed
instead of colliding with the server's 1,000-bucket cap, which a flat 24-hour
default would do:

```sh
lyraflow stats --interval 1m --json
```
```json
{"bucket":"2026-08-09T03:16:00.000Z","events":4}
{"bucket":"2026-08-09T03:17:00.000Z","events":4}
```

## `lyraflow persons <get|export|delete> <id>`

One id per call, resolved server-side exactly the way `GET /v1/persons/:id`
resolves it (aliases, device-id fallback — see *Identity resolution* in the
main README).

### `persons get <id>`

```sh
lyraflow persons get user-42 --json
```
```json
{"person_id":"user-42","ids":["user-42","visitor-1"],"first_seen":"2026-08-09T03:16:15.405Z","last_seen":"2026-08-09T03:20:31.657Z","events":4}
```

### `persons export <id>`

Streams `GET /v1/persons/:id/export`'s NDJSON straight through, byte for
byte — `--json`/`--human` do not change this output at all; the format *is*
NDJSON, always, and the flags only affect how an error from this command
itself is rendered.

```sh
lyraflow persons export user-99
```
```json
{"type":"person","person_id":"user-99","ids":["user-99","visitor-9"],"traits":{"plan":"trial"},"first_seen":"2026-08-09T03:22:46.441Z","last_seen":"2026-08-09T03:22:46.441Z"}
{"type":"event","event_id":"44444444-4444-4444-4444-444444444441","timestamp":"2026-08-09T03:22:46.441Z","received_at":"2026-08-09T03:22:46.441Z","event_name":"$identify","anonymous_id":"visitor-9","user_id":"user-99","properties":{"plan":"trial"},"properties_num":{},"url":"","path":"","referrer":"","utm_source":"","utm_medium":"","utm_campaign":"","utm_term":"","utm_content":"","device_type":"desktop","os":"macos","browser":"chrome","country":"","region":"","city":""}
{"type":"end","events":1}
```

If the stream ends without that final `{"type":"end",…}` line, the data
received so far is still written (an agent piping to a file should see what
actually arrived) but the command exits `1` and reports the omission on
stderr — exit `0` from this command means "this export is complete and
trustworthy," which an unterminated stream is not.

### `persons delete <id>` — irreversible

This permanently erases the person and their event history (subject to the
purge and suppression semantics documented under *Privacy: deletion and
export* in the main README). Its exit codes carry the actual safety design:

- **At a real terminal (stdin is a TTY), it prompts** — `y`/`yes` (case
  insensitive) confirms, anything else, including no answer within 2 minutes,
  **declines**. A declined confirmation exits `1`: the operation did not
  happen, which is a different fact from success.
- **When stdin is not a terminal, `--yes` is required**, or the command
  refuses outright with a usage error (exit `2`) and never calls the API at
  all. An agent's stdin is essentially never a TTY, so this is what stops an
  accidental invocation from erasing someone, while still letting a caller do
  it deliberately with `--yes`. This is gated on **stdin**, not stdout — a
  pty-allocated harness (tmux, `script`, most agent runners) commonly reports
  stdout as a terminal too, and keying the check on stdout was a real defect
  this CLI fixed.

```sh
lyraflow persons delete user-42 </dev/null --json
```
```json
{"error":"refusing to delete without --yes when stdin is not a terminal (nothing to prompt)","code":"usage_error"}
```
exit `2`.

```sh
lyraflow persons delete user-42 --yes --json
```
```json
{"request_id":3,"person_id":"user-42","suppressed_at":"2026-08-09T03:20:40.467Z"}
```
exit `0`. Poll the result with `lyraflow deletions get <request_id>` below.

## `lyraflow deletions get <id>`

```sh
lyraflow deletions get 3 --json
```
```json
{"status":"completed","requested_at":"2026-08-09T03:20:40.468Z","completed_at":"2026-08-09T03:20:46.547Z"}
```

`status` is one of `pending`, `in_progress`, `completed`, `failed` — see
*Checking on a deletion* in the main README for what each means.

## `lyraflow segments <list|run>`

### `segments list`

```sh
lyraflow segments list --json
```
```json
{"id":2,"name":"Trial signups","ast_version":1,"filter":{"kind":"trait","key":"plan","operator":"=","value":"trial"},"stale":false,"last_count":null,"last_evaluated_at":null,"created_at":"2026-08-09T03:22:29.723Z","updated_at":"2026-08-09T03:22:29.723Z"}
```

### `segments run <id> [--members] [--cursor <c>]`

Runs the saved segment (`POST /v1/segments/:id/preview`) and records the
result, same as the endpoint itself.

Without `--members`, the summary is the only output and goes to **stdout** —
an agent asking only for a count should not have to read stderr to get it:

```sh
lyraflow segments run 2 --json
```
```json
{"person_count":0,"as_of":"2026-08-09T03:22:38.590Z"}
```

With `--members`, the member rows go to stdout (the record list) and the
summary — `person_count`, `as_of`, `next_cursor`, `window_exhausted` — moves
to **stderr**, the same "stdout stays a pure record stream" rule `events
--follow` follows for its own `next_cursor`:

```sh
lyraflow segments run 2 --members --json
```

Captured against a live server for a segment matching nobody at the moment it
ran — the member list is genuinely empty (nothing is written for an empty
list, in either mode) and only the stderr summary line appears:

```json
{"person_count":0,"as_of":"2026-08-09T03:22:38.834Z","next_cursor":null,"window_exhausted":false}
```

A matching segment prints one JSON line per member on stdout instead, each
carrying `person_id`, `first_seen`, `last_seen`, and the `context` fields
described under *Retrieving members, not just the count* in the main README.

`--cursor` requires `--members` — passing it without also asking for members
is a usage error (exit `2`), since there is no members page to resume without
`--members` in the same request.

## `lyraflow schema <events|properties>`

```
lyraflow schema events [--q <prefix>] [--limit <n>] [--json|--human]
lyraflow schema properties [--q <prefix>] [--event <name>] [--limit <n>] [--json|--human]
```

`--limit` defaults to 50, capped at 100 — validated client-side the same way
`events`' own `--limit` is.

```sh
lyraflow schema properties --event signup --json
```
```json
{"property_key":"plan","value_kind":"string"}
```

`--event` only applies to `properties`; passing it to `schema events` is
rejected as an unexpected flag for that subcommand rather than silently
ignored.

## `lyraflow --version`

```sh
lyraflow --version --json
```
```json
{"version":"0.1.0","output_schema":1}
```

`version` is the CLI's own release, and moves with every release. `output_schema`
moves only when a documented JSON field changes shape or meaning — this is the
number to check before trusting a field name, not `version`.
