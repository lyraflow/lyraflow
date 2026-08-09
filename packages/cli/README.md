# `@lyraflow/cli`

A small, dependency-light CLI over Lyraflow's read API — the event feed,
time-bucketed counts, a person's profile, saved segments, and the event/
property schema — built for scripts and for agents driving Lyraflow directly
from a terminal, not for browsing. It wraps `GET /v1/events`,
`GET /v1/events/stats`, `GET /v1/persons/:id`, `GET /v1/persons/:id/export`,
`DELETE /v1/persons/:id`, `GET /v1/deletions/:id`, `GET /v1/segments`,
`POST /v1/segments/:id/preview`, `GET /v1/schema/events`,
`GET /v1/schema/properties` and `GET /v1/project` — see the main
[README](../../README.md) for what each of those endpoints actually does;
this document is about the CLI's own surface on top of them.

`create-project`, `migrate`, and `healthcheck` are separate, operational
commands this binary also ships (used once per install, not per query) — see
*Running Lyraflow* in the main README for those. `healthcheck` reads its own
env var, `LYRAFLOW_URL` (defaulting to `http://localhost:3000`), not
`LYRAFLOW_HOST` — the two are not interchangeable and neither falls back to
the other:

```sh
LYRAFLOW_URL=http://localhost:3000 lyraflow healthcheck
# ready
# exit 0
```

Everything below is the read-oriented surface.

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
| `1` | The command failed |
| `2` | Usage error — nothing was ever sent to the API |

An agent can branch on these without parsing any output. **Exit `1` covers
more than "the API answered and rejected the request" — do not assume it
implies the server was reached.** It is every `ApiError` (`client.ts`),
which includes:

- the server answered a non-2xx status (a rejected key, a `400`, a `503`, …);
- the request **never reached anything** — an unreachable host, a DNS
  failure, a malformed `--host`. `code` is `no_response` or `invalid_url` in
  that case, and the message never claims otherwise. Note what that message
  does *not* contain: the host you passed. `--host` is a value from your
  command line, and a value from a command line can be a secret typed one
  slot off — so the error names the flag and the environment variable to
  check, never what either of them was set to;
- the host answered `2xx` with something this CLI cannot use — a body that
  is not JSON, not a JSON object, or an object missing the list of records
  the command asked for. `code` is `invalid_response_body` or
  `invalid_response_shape`. Usually it means `--host`/`LYRAFLOW_HOST` is
  pointed at something that is not a Lyraflow server: an auth proxy's login
  page, a load balancer's error JSON, one host off. Note the deliberate
  limit: a command that returns a *list* fails this way when the list is
  missing, but a command that returns a *single record* (`persons get`,
  `deletions get`) does not check which fields that record has — an empty
  `{}` is printed as `{}` and exits `0`. The CLI guarantees that a
  wrong-shaped body never crashes and never silently becomes an empty
  result; it does not validate the server's fields for you;
- for `persons export` specifically, a stream that ended without its
  terminating `{"type":"end",…}` line — the data received is real but
  incomplete, `code` is `export_incomplete`;
- for `persons delete` specifically, a declined or failed confirmation
  prompt — the deletion did not happen, which is a different fact from
  success.

```sh
lyraflow events --limit 99999 --json
# {"error":"--limit must be at most 500, got 99999","code":"usage_error"}
# exit 2 — never sent

lyraflow events --server-key sk_wrong --json
# {"error":"the server key was rejected","code":"invalid_server_key"}
# exit 1 — reached the server, rejected

lyraflow events --host http://127.0.0.1:1 --json
# {"error":"could not reach the configured host (--host, or LYRAFLOW_HOST)","code":"no_response"}
# exit 1 too — reached nothing at all
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

Captured whole — **stdout and stderr both** — because this particular window
has more than 2 events in it, so this small `--limit` genuinely fills the
page and triggers the truncation warning covered in the next section. Shown
here in full rather than trimmed to stdout alone, so the first example a
reader copies doesn't leave out something the command actually printed:

stdout:
```json
{"event_id":"77777777-7777-7777-7777-777777777772","timestamp":"2026-08-09T04:05:36.837Z","event_name":"pageview","anonymous_id":"flag-visitor-2","user_id":"","properties":{},"properties_num":{},"url":"","path":"","referrer":"","utm_source":"","utm_medium":"","utm_campaign":"","utm_term":"","utm_content":"","device_type":"desktop","os":"macos","browser":"chrome","country":"","region":"","city":""}
{"event_id":"77777777-7777-7777-7777-777777777773","timestamp":"2026-08-09T04:05:36.844Z","event_name":"pageview","anonymous_id":"flag-visitor-3","user_id":"","properties":{},"properties_num":{},"url":"","path":"","referrer":"","utm_source":"","utm_medium":"","utm_campaign":"","utm_term":"","utm_content":"","device_type":"desktop","os":"macos","browser":"chrome","country":"","region":"","city":""}
```

stderr:
```json
{"warning":"this page hit --limit 2; events older than 2026-08-09T04:05:36.837Z in this window may exist and were not shown — rerun with the same --since and --until 2026-08-09T04:05:36.837Z to see them, or increase --limit"}
{"next_cursor":"WyIyMDI2LTA4LTA5IDA0OjA1OjM2Ljg0NCIsIjc3Nzc3Nzc3LTc3NzctNzc3Ny03Nzc3LTc3Nzc3Nzc3Nzc3MyJd"}
```

Both stderr lines are explained just below. `--limit` is validated
client-side against the server's own cap (500) before anything is sent — see
*Exit codes* above for what an over-large `--limit` looks like.

### stderr carries more than errors

Two things land on stderr besides a genuine error, both rendered through the
same `--json`/`--human` machinery as everything else — under `--json` each is
a JSON object, one per line, not prose:

- **The resume cursor.** After a non-`--follow` run (or a `--follow` session
  that stops), the last `next_cursor` seen is written to stderr so a caller
  can resume later without a separate request. One case omits it — see the
  merged-stream note under `--follow` below:

  ```
  {"next_cursor":"WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM3MSIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNSJd"}
  ```

  Feed it back with `--after` to continue exactly where the last run left off:

  ```sh
  lyraflow events --after 'WyIyMDI2LTA4LTA5IDAzOjE3OjM0LjM3MSIsIjIyMjIyMjIyLTIyMjItMjIyMi0yMjIyLTIyMjIyMjIyMjIyNSJd' --json
  ```

- **A truncation warning.** A *cursorless* poll — the first one, and any
  poll before the session has ever received a cursor — that comes back with
  exactly `--limit` events
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
- **A cursorless poll is a tail, not a full scan.** A session starts without
  a cursor and stays that way until a poll actually returns events; once it
  has one it never goes back (an empty poll later on does not clear it). If
  more than one page's worth of events arrives while it is still in that
  state, only the newest page is shown, and the truncation warning above
  fires on stderr naming the oldest event actually shown — the older ones in
  that burst are gone from `--follow`'s perspective the moment the cursor
  advances past them.
- **An event delivered late, but timestamped before the current cursor
  position, can still be missed.** Ingest admits events up to 24 hours behind
  the server's own clock (clock skew), and forward-only keyset paging has no
  way to notice a row landing behind where it has already moved past. This is
  inherent to the paging scheme, not a bug this CLI works around.

**`--follow` exits `0` on `SIGINT`/`SIGTERM` (e.g. `Ctrl-C`, or the single
`SIGTERM` `docker stop` and systemd send), normally writing the resume
cursor to stderr first, same as a normal non-`--follow` run.** One signal is always
enough, and it takes effect immediately — including while a poll's own HTTP
request is still open, which is where a follow session spends most of its
time. The in-flight request is abandoned rather than waited for; measured
against a host that accepts the connection and never answers, the process is
gone within about ten milliseconds of the signal. There is no "press it
again" fallback to know about, because there is nothing to fall back from.

The one thing it does wait for is your own reader. If records are still
being written when the signal arrives (a pipe into something slower than the
CLI), they are flushed before the process exits, so an interrupt never
silently drops records the cursor then skips past. That wait is bounded at
two seconds; if a reader is so far behind that it expires, the CLI says so
on stderr, immediately before the cursor it invalidates:

```json
{"warning":"interrupted while output was still being written; some records may not have reached the reader, so the next_cursor below may skip them"}
```

**On a merged stream (`2>&1`) that has itself backed up, expect neither
line.** The warning and the cursor are written together, as one write, so
that a cursor can never arrive without the warning that says not to trust
it — a cursor alone would silently skip the records that never left the
buffer. When stderr shares a congested pipe with stdout there may be no room
for that write, and rather than emit half of it the CLI emits none. The
visible result is truncated output, nothing on stderr, and exit `0`, which
is indistinguishable from a clean stop with nothing to report.

If you interrupt a `--follow` session and no cursor appears, do not assume
you saw everything: re-run bounded by `--since`/`--until` over the window
you care about. Keeping stderr on its own stream — the ordinary case, and
what the examples here assume — avoids the situation entirely.

Only `events --follow` handles these signals. Every other command — `events`
without `--follow` included — keeps the ordinary behaviour: the signal kills
it outright, with no exit code of its own.

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

**When `--since` is omitted, the effective window is scaled to `--interval`**
— the same per-interval table the server itself defaults to (see *Reading
events* in the main README: 1 hour at `1m`, 24 hours at `1h`, 7 days at
`1d`). *How* that happens differs by case, because it has to:

- **`--until` given, `--since` not**: this CLI always computes `--since`
  itself, anchored to *your* `--until` rather than the server's own clock —
  the server's own default anchors to its own `now`, which would silently
  mismatch a caller-supplied `--until` at any interval.
- **Neither given, at the default interval (`1h`)**: this CLI still computes
  and sends an explicit `--since` (`now - 24h`) itself, rather than leaving it
  to the server — purely so the resolved value is visible in `--json` output
  like every other parameter, not because the server would answer
  differently without it.
- **Neither given, at `1m` or `1d`**: this CLI sends no `--since` at all, and
  the server's own identical per-interval default applies.

The *observed* window is the same table above in every case; only the
middle case bothers computing a value that was already going to match. This
is what lets a bare `lyraflow stats --interval 1m` succeed instead of
colliding with the server's 1,000-bucket cap, which a flat 24-hour default
would do:

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
lyraflow schema events --json
```
```json
{"event_name":"purchase"}
```

```sh
lyraflow schema properties --event purchase --json
```
```json
{"property_key":"plan","value_kind":"string"}
```

Only events carrying at least one property are discoverable this way — see
*Autocomplete: event and property names* in the main README for why.

`--event` only applies to `properties`; passing it to `schema events` is
rejected as an unexpected flag for that subcommand rather than silently
ignored.

## `lyraflow snippet`

```
lyraflow snippet [--since <duration>] [--json|--human]
```

Prints a paste-ready browser install snippet — this project's own host and
write key already substituted into the exact block documented under *Sending
events from a browser* in the main README — plus the SDK's full callable
surface, and which event names have actually arrived, so you can tell
"installed but nothing has called `track()` yet" from "instrumented and
firing." **The only command in this CLI whose job is to print a key.** The
write key is printed on purpose: it is public by construction (it ships
inside the browser bundle — see *Sending events from a browser* in the main
README). The **server key** this CLI authenticates with is never printed,
here or anywhere else in this CLI's output.

Three requests happen, in order: `GET /v1/project` (the write key — this one
must succeed, or there is nothing to print), `GET /v1/schema/events`, and
`GET /v1/events/stats`. **Neither of the last two, alone, is a complete
event-name list**, and this command combines them rather than trusting
either on its own:

- `GET /v1/schema/events` lists every event name this project has EVER
  carried at least one *property* on — all-time, not windowed. But
  `event_schema` (its source) is fed by a materialized view keyed on the
  event's property map, so an event that has **never** carried a property —
  `lyraflow.track('signup')` with no second argument, the single most common
  first call anyone makes — produces **zero rows there**, no matter how many
  times it fired. Only events carrying at least one property are
  discoverable this way — see *Autocomplete: event and property names* in
  the main README for the same limitation on `lyraflow schema`.
- `GET /v1/events/stats` reports counts WINDOWED by `--since` (default
  `7d`), but it aggregates the raw event table directly, so it sees a
  property-less event just fine, as long as it fired inside the window.

This command reports the **union** of the two name lists. A name present
only in `schema/events`, with nothing in the window, is shown with a `0`
count: it fired historically and has since stopped, which is one of the more
useful things this output can say about instrumentation that used to work. A
name present only in `events/stats` — a property-less event that fired
inside the window — is shown with its real count, where reporting from
`schema/events` alone would have dropped it and, on a project whose events
carry no properties at all, printed "No events recorded yet" about a
genuinely working install. Neither source is complete even after the union:
an event that has **never** carried a property and did not fire within
`--since` is invisible to both requests — **widen** the window (e.g.
`--since 30d`) to find it. Narrowing cannot: shrinking `--since` only ever
removes names from the `events/stats` half of the union, it never adds one.

**Widening has a ceiling, at about 1000 days.** `events/stats` is requested
at one bucket per day, and the server refuses a request needing more than
1000 buckets — so a `--since` past roughly two years and nine months comes
back `window_too_large`. It costs the **counts only**: `schema/events` is
all-time and un-windowed, so the event *names* still print, with `-` in
place of every count, and the output says which request went missing. Ask
for a narrower window to get counts back.

Both requests are informational, and they degrade **independently**: a
failure in one still prints the snippet *and* whatever the other returned —
the snippet itself needs neither of them, and neither request needs the
other.

Captured against a live server (host and write key replaced with the
placeholders used elsewhere in this doc; the wording, the counts, and which
names appear are exactly what the command printed):

```sh
lyraflow snippet --human
```
```
<script>
  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];
  ["init","track","page","identify","consent","reset","flush"].forEach(function(m){
    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});
  }();
</script>
<script async src="https://analytics.example.com/lyraflow.js"></script>
<script>
  lyraflow.init({ host: "https://analytics.example.com", writeKey: "wk_live_…" })
</script>

Event counts for 2026-08-02T12:22:49.443Z to 2026-08-09T12:22:49.469Z, every event name that fired in this window, plus every all-time name that has ever carried a property (an all-time, property-less name that fired outside this window will not appear). A zero count means it fired before this window, not that it is broken:
  legacy_import  0
  mid_window     1
  page_view      1
  raw_click      1
  signup         2
```

`raw_click` above never carries a property — `lyraflow.track('raw_click')`,
no second argument — and `schema/events` alone would never have listed it at
any `--since`. `mid_window` fired two days before this ran; narrowing the
window shows both what the union adds and what a real window boundary looks
like, from the same live server, immediately after:

```sh
lyraflow snippet --since 1h --json
```
```json
{"host":"https://analytics.example.com","write_key":"wk_live_…","methods":["init","track","page","identify","consent","reset","flush"],"events":{"since":"2026-08-09T11:22:49.621Z","until":"2026-08-09T12:22:49.643Z","counts":[{"event_name":"legacy_import","count":0},{"event_name":"mid_window","count":0},{"event_name":"page_view","count":1},{"event_name":"raw_click","count":1},{"event_name":"signup","count":2}],"truncated":false},"sdk_version":"0.1.0","snippet":"<script>\n  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];\n  [\"init\",\"track\",\"page\",\"identify\",\"consent\",\"reset\",\"flush\"].forEach(function(m){\n    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});\n  }();\n</script>\n<script async src=\"https://analytics.example.com/lyraflow.js\"></script>\n<script>\n  lyraflow.init({ host: \"https://analytics.example.com\", writeKey: \"wk_live_…\" })\n</script>"}
```

`mid_window` drops from `1` to `0` — narrowing `--since` genuinely changes
counts, not just which zero-count rows appear. `raw_click` and `page_view`
are unaffected here because both fired well inside even the 1-hour window.
`legacy_import` stays `0` in both: it fired ten days before this ran, outside
either window.

**`events` is a union, not always the shape above** — exact-set equality
only holds within each arm:

- On success: `{"since", "until", "counts", "truncated"}`, as printed above.
  `truncated: true` means `schema/events` — only that request; `events/stats`
  has its own, separate ceiling unrelated to this field — came back at
  exactly the server's own page-size ceiling (100 rows). That is the only
  available signal that there may be more all-time, property-bearing names,
  since that endpoint returns no total count to check against. It says
  nothing about names `events/stats` alone contributed to `counts`, and
  **`counts.length` can exceed 100 even when `truncated` is `true`**: the
  window half of the union adds names the 100-row ceiling never applied to
  in the first place, so 100 property-bearing names plus any number of
  property-less, in-window names can both be true at once (verified live: a
  fixture with 130 property-bearing names and one property-less in-window
  name produced `truncated: true` alongside `counts.length === 131`).
- When **one** of the two requests failed: the same success shape, plus a
  `"partial": {"source", "code", "message"}` — `source` is the literal
  `"schema/events"` or `"events/stats"`, naming the request that did *not*
  answer. `partial` is **absent** whenever both succeeded, so the exact key
  set above is unchanged on the ordinary path. Which one is missing changes
  what `counts` means, which is why the field names it rather than saying
  "something failed":
  - `"source": "events/stats"` — the names are the all-time,
    property-bearing list and are **not windowed**, and every `count` is
    **`null`**: unknown, not zero. (`null`, not `0`, precisely so a
    consumer cannot mistake "we could not ask" for "it fired before this
    window". The human table prints `-`.) `truncated` still applies.
  - `"source": "schema/events"` — `counts` is exactly what fired inside the
    window, with real counts; an all-time name that fired only outside it is
    absent. `truncated` is always `false` here: there was no page to cut.
- When **both** failed: `{"error": {"code", "message"}}` instead — with **no
  `counts` field at all**, carrying `schema/events`' error as the first
  request sent. The command still exits `0`: see *Exit codes* above for why
  — the snippet itself (host, write key, methods) needs neither request, so
  losing it over an events list that merely could not be fetched would be
  the wrong trade. A consumer that reads `.events.counts` unconditionally
  gets `undefined` on this successful exit, with nothing on stderr to
  explain it — check for `.events.error` first, and for `.events.partial`
  before trusting a count.

`methods` is always `["init","track","page","identify","consent","reset","flush"]`
— the exact list the printed stub's own method array is built from, not a
second, hand-maintained copy, so it cannot silently drop a method the SDK
actually exports.

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
