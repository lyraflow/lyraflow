<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img src="brand/lockup-light.svg" alt="Lyraflow" width="200">
  </picture>
</h1>

**Self-hosted customer journey analytics. Your data stays on your servers.**

Lyraflow records what people do in your product, stitches anonymous visits to
known accounts, and lets you ask who did what. It runs on your own machine
under Docker, and nothing leaves it.

> **Early days.** v0.9 is the API and the operations behind it — ingest,
> identity, segments, funnels, event reads, privacy, retention, quotas and
> backup — with a web UI over the top: a live event feed where any event opens
> to show everything it arrived with, funnels that read as a flow and whose
> steps can gate on who someone is as well as what they did, a segment builder
> that filters on an event's own attributes as well as its properties, and
> settings for your projects and your own account. Clicking a funnel step or a
> segment lists the people behind the number, with their traits. There is
> still **no person profile**: no per-person event history, and no way to open
> someone who is neither in a segment nor at a funnel step. Journeys and
> dashboards are still ahead. See [Web UI](#web-ui) for exactly what exists
> and what does not.

## What it is good at

**Knowing who someone is.** A visitor browses anonymously, signs up two weeks
later, then uses your product from a phone. Lyraflow ties all of that to one
person, and reads their history back stitched. If two people share a device,
each event is attributed to whoever was signed in *at that moment* — not to
whoever used it last.

**Deleting someone completely.** `DELETE /v1/persons/:id` erases the underlying
rows, and every read path — segment counts, member lists, person reads, exports
— is filtered from the instant the request is accepted, not when the purge
finishes. A person deleted a second ago is already invisible.

**Being cheap to run and hard to surprise.** Events go to ClickHouse and
identity to Postgres, one container each. Old events expire on a schedule you
set. A project can be given a monthly event cap. One script backs both
databases up together; another puts them back. Every limit in this document
has a number attached, and the ones with known slack say so.

**Being scriptable.** Events, people, segments, schema and deletions all have
CLI wrappers with machine-readable output, so scripts and agents can use them
without a browser. See [`packages/cli/README.md`](packages/cli/README.md).

## License

Lyraflow is [fair-code](https://faircode.io) distributed under the
[Sustainable Use License](LICENSE.md). The source is always visible, and you
are free to self-host, use and modify it for your own business.

It is **not** an [OSI-approved open source](https://opensource.org/osd)
license. The practical difference: you may not sell Lyraflow as a hosted
service to other people.

## Getting started

Four steps. About five minutes, most of it waiting for Docker.

### 1. Install

You need Docker and **Docker Compose v2.21.0 or newer**. Nothing else.

That version is not arbitrary. `install.sh` asks Compose for a container's
status with a Go template (`docker compose ps caddy --format '{{.Status}}'`),
and `--format` only learned to accept a template in v2.21.0 — before that it
took `table` or `json` and answered anything else with
`format value "…" could not be parsed`. Everything else these scripts use is
older: `up --wait` since v2.1.1, `ps --status` since the first v2 release.

If you are on something older, the install still completes — that call is on an
error path and falls back to saying nothing rather than failing. You would only
notice by getting a less specific message when a container fails to start.
Check yours with `docker compose version`.

```sh
git clone https://github.com/lyraflow/lyraflow.git
cd lyraflow
./install.sh
```

That generates passwords into `.env`, starts three containers, and waits until
the app answers on port 3000.

That is a local install: plain HTTP on port 3000, which is all the examples
below need. **Running this on a server with a domain name?** Pass it to the
installer and Lyraflow serves HTTPS itself:

```sh
./install.sh analytics.example.com
```

See [Serving over HTTPS](#serving-over-https) for what that changes, and for
the one case — a domain proxied through Cloudflare — where it needs a hand.

Then create a project:

```sh
docker compose exec lyraflow node packages/cli/dist/index.js create-project "My App"
```

It prints two keys, and the difference between them matters:

| | |
| --- | --- |
| **Write key** `wk_…` | **Public.** It can only write events. Ship it in your page source — that is what it is for. |
| **Server key** `sk_…` | **Secret, shown once.** Reads people, merges them, deletes and exports them. Write it down; only its hash is stored, so nothing can recover it for you. |

Run `create-project` again for each additional website you want to track
separately — one install holds as many projects as you like, and the rest of
this document shows one only because a project is the unit each example
operates on. If you are tracking two sites, read
[*Tracking more than one site*](#tracking-more-than-one-site) before
instrumenting either: whether they are one project or two decides whether a
person using both is one person or two, and that cannot be changed later
without re-ingesting.

Keep both to hand:

```sh
export LYRAFLOW_WRITE_KEY=wk_...
export LYRAFLOW_SERVER_KEY=sk_...
```

### 2. Put the snippet on your website

Ask Lyraflow for the snippet rather than writing it yourself — it fills in your
host and write key, and escapes them correctly:

```sh
docker compose exec \
  -e LYRAFLOW_HOST=http://localhost:3000 \
  -e LYRAFLOW_SERVER_KEY=$LYRAFLOW_SERVER_KEY \
  lyraflow node packages/cli/dist/index.js snippet
```

Paste what it prints into your site's `<head>`. It loads a ~5 KB script, starts
recording page views immediately, and queues events in `localStorage` if your
server is unreachable, so a deploy or a blip loses nothing.

When someone signs in, tell Lyraflow who they are — this is what ties their
anonymous browsing to their account:

```js
lyraflow.identify('user-42', { plan: 'pro' })
```

Details, consent handling and single-page-app routing: [Sending events from a
browser](#sending-events-from-a-browser).

### 3. Send events from your backend

Anything your server knows and the browser does not — payments, cancellations,
webhooks — goes over the same ingest API with the same write key:

```sh
curl -i http://localhost:3000/v1/track \
  -H 'content-type: application/json' \
  -H "x-lyraflow-write-key: $LYRAFLOW_WRITE_KEY" \
  -A 'MyApp/1.0 (+https://example.com)' \
  -d '{
    "message_id": "0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90",
    "user_id": "user-42",
    "event": "subscription_started",
    "properties": { "plan": "pro", "seats": 3 }
  }'
```

You get `202 Accepted` with `{"status":"accepted"}`.

**Set a real `User-Agent`, as above.** Lyraflow discards events that look
automated so bots do not inflate your person counts — and curl's default, or no
header at all, counts as automated. Without one this request still answers
`202` and the event is silently dropped. Avoid `bot`, `crawler`, `curl/`,
`python-requests` and similar (full list: `packages/core/src/enrich/bots.ts`).

### 4. See your data

The CLI wraps the read endpoints. It is already built inside the running
container, so give yourself a shorthand:

```sh
lyraflow() {
  docker compose exec \
    -e LYRAFLOW_HOST=http://localhost:3000 \
    -e LYRAFLOW_SERVER_KEY="$LYRAFLOW_SERVER_KEY" \
    lyraflow node packages/cli/dist/index.js "$@"
}
```

Then:

```sh
lyraflow stats --since 24h --by-event    # how many of each event, per hour
lyraflow events --since 1h               # the raw feed, newest first
lyraflow events --follow                 # watch them arrive live
lyraflow persons get user-42             # one person's stitched profile
```

Every command takes `--json` for scripts and agents; the table output is for
humans and is not a stable interface. Full reference:
[`packages/cli/README.md`](packages/cli/README.md).

Or watch the same feed in a browser: sign in at `http://localhost:3000` — see
[Web UI](#web-ui).

Nothing to look at yet? [Demo data](#demo-data) fills a project with
synthetic history so the screens have something to show.

**That is the whole loop** — instrument, send, read. Everything below is
detail on each part.

## Demo data

An empty project tells you nothing. The segments screen, the funnels screen
and the feed are all uninformative until there is history to look at, and
waiting ninety days for your own traffic to accumulate is not a way to
evaluate anything. So there is a command that fills a project with synthetic
people and events:

```sh
docker compose exec lyraflow node packages/cli/dist/index.js \
  create-project "Demo"

docker compose exec lyraflow node packages/cli/dist/index.js \
  seed-demo demo
```

By default that is 400 people and 5,000 events spread over 90 days: a
signup-to-purchase funnel with realistic drop-off, identify traits
(`plan`, `country`, `signup_source`, `seats`, `mrr_usd`, `is_trial`), UTM
campaigns on first touch, purchase amounts, and visitors who browsed
anonymously before signing up. `last 7 days`, `last 30 days` and `ever`
give three different answers, which is the point.

```sh
seed-demo <project> [--persons N] [--events N] [--days N] [--seed N] [--anchor <instant>]
```

`<project>` is the project's name or slug. `--help` prints the full list with
its defaults. Nothing it writes could be mistaken for a real person or
company: identifiers are prefixed `demo-`, names are "Demo Person 0042",
there are no email addresses, and URLs use the reserved `.invalid` domain.

**It is reproducible.** At a fixed `--seed` every person, trait, property
value and the whole sequence of events is identical run to run, so you can
compare a screen before and after a change and know the data did not move
underneath you. The one thing that does move is the anchor — "now" for the
generated history — which defaults to the moment you run the command; pass
`--anchor` to pin it and two runs become byte-for-byte identical.

**It writes to Postgres and ClickHouse directly, not through the ingest
API,** so it needs `LYRAFLOW_POSTGRES_URL` and the `LYRAFLOW_CLICKHOUSE_*`
variables (which are already set inside the container), and it needs
[`migrate`](#upgrading) to have run. That is not a shortcut: every client
timestamp sent to `/v1/batch` is clamped to within 24 hours of arrival, on
purpose, because a wrong device clock would otherwise corrupt every
time-windowed segment (see [Payload fields](#payload-fields)). Backdated
events posted over HTTP therefore all land inside a single day, and ninety
days of history is impossible to create that way. The clamp is not relaxed
and there is no trusted-backdating flag; the seeder simply does not go
through it.

**It only ever inserts.** There is no reset, no wipe and no `--force`: it
cannot delete anything, including its own earlier output. Two consequences
worth knowing before you run it twice:

* Running it again **adds** another cohort. Counts go up; they are not
  replaced.
* Re-running at the **same** seed re-mints the same event ids at new
  instants, so an accidental double-run is findable rather than silent:

  ```sh
  docker compose exec clickhouse clickhouse-client \
    --user "$LYRAFLOW_CLICKHOUSE_USER" --password "$LYRAFLOW_CLICKHOUSE_PASSWORD" \
    --database "$LYRAFLOW_CLICKHOUSE_DB" \
    --query "SELECT event_id, count() AS n FROM events GROUP BY event_id HAVING n > 1"
  ```

  A different `--seed` produces a disjoint population with its own
  identifiers, which is usually what you want for a second helping.

If you want a clean slate, the honest answer is a fresh project: make one
with `create-project` and seed that instead. To remove seeded data outright,
use the ordinary [deletion API](#privacy-deletion-and-export) or drop the
project — this command deliberately owns no destructive path.

**Do not point it at a project holding real traffic.** Nothing will be lost,
but the synthetic people will be mixed in with your own and every count on
every screen will include them.

## Web UI

Open `http://localhost:3000` (or your domain, if you installed with one) and
sign in with the admin account — see [Admin login](#admin-login) for where
that password comes from and how to change it. It is served on the **same
origin and port as ingest** — there is no separate admin host or port to
firewall off separately. Everything the [Admin login](#admin-login) section
says about that origin being reachable from wherever ingest is reachable
applies to the login form too.

**A fresh install, signed in with no project yet, gets a first-run wizard
instead of the normal screen.** Name a project, and the wizard hands back
the install snippet and the project's one-time server key — shown once and
never again, the same discipline Settings uses for every later project's
key, described below — then waits for a real first event to arrive. It
never claims a working install on a timer, only on an event actually
landing, and an arriving event does not dismiss the wizard by itself either:
it flips the last step into a success state and waits for you to click
"Continue to dashboard" — so the key stays on screen until you say you're
done with it. There is also a "Skip to dashboard" for the case where you
cannot instrument the target site right now.

Past the wizard (or immediately, if a project already exists), there are five
screens, reachable from the sidebar:

- **Feed** — a live event feed, split into an **Accepted** tab and a
  **Rejected** tab, over a window you pick — the last hour through the last
  90 days — with an optional event-name filter. The window and the filter are
  held in the URL, so a refresh keeps them and the screen can be shared as a
  link; the page polls every few seconds on the short windows and once a
  minute on the long ones. The chart above the tables counts events per
  bucket over the same window, at the finest resolution that window allows.
  The event filter reaches the chart and the Accepted tab but **not** the
  Rejected one: a payload may have been refused precisely because its event
  name was missing or unparseable, so filtering the rejections by name would
  hide the rows that tab exists for. Rejected events carry the reason they
  were dropped next to each row — `validation_failed`, `too_many_properties`,
  `event_name_cardinality` or `property_key_cardinality` — which is
  otherwise only visible by reading server logs. An unauthenticated or
  over-quota request is refused *before* it reaches a project at all, so it
  is never dead-lettered and never shows up here — the Rejected tab tells
  you about payloads that reached a real project and were still refused,
  not about a bad or missing write key.
- **Settings** — the install snippet for the active project (so losing the
  copy from the wizard is not a trip to the CLI); the project list, where each
  one can be renamed or archived; this month's usage
  (accepted, rejected, throttled, and the quota — reading plainly as
  **Unlimited** rather than a bar or a number when none is set); the
  project's retention and monthly quota, both editable in place; and the
  full project list with a create-project flow of its own, whose server key
  is likewise shown exactly once and never again.

- **Funnels** — create a funnel from an ordered list of events, run it over a
  range you choose, and read the result as one row per step: how many people
  reached it, what share of the entrants that is, and how many dropped between
  it and the step before. Opening a saved funnel runs it once; changing the
  range does **not** re-run it — the chart dims and waits for you, because a
  funnel is a real scan and because numbers from the old range sitting under a
  new one would be a wrong answer stated confidently.

  Two honesty details worth knowing, both of which the screen states without
  being asked. If some of the people who entered did so too recently to have
  had the funnel's full window, it says so and tells you how many — otherwise
  every run over a range shorter than the window quietly under-reports
  conversion. And if a funnel's segment filter has been deleted, the run
  succeeds over **everyone** rather than failing; the screen reports that and
  stops showing the filter as though it applied, because the numbers alone
  look entirely normal.

  Click a step and a Reached/Dropped panel opens beneath the chart — two
  different populations, each counted on its own rather than assumed from the
  chart above (see *Who reached a step, or stopped there* under Funnels below).

- **Retention** — pick a start event, a return event, a condition on either of
  them, a period and how many of them, and run a cohort grid. It does **not** run on render and does not
  re-run when you change the controls: a grid is a real scan, and numbers from
  one definition sitting under the controls of another is a wrong answer
  stated confidently, so the grid clears and waits for you. Cells shade by
  retention, and a period that had not finished when the grid ran shows a dash
  rather than 0% — with a line underneath saying how many did, because a dash
  read as a zero is the one way this chart misleads. The whole definition
  lives in the URL, so a grid is shareable as a link and there is nothing to
  save.

- **Segments** — build a filter tree in the browser: `and`/`or` groups, traits,
  context, lifecycle bounds, and behaviours with their own `where` predicates.
  Preview it before saving — the person count and a bounded page of members,
  taken at one instant — then save, re-run, edit or delete it. Clicking a
  person opens what the preview already knows about them: their latest
  country, city, device, OS and browser, the referrer and campaign they
  arrived through, and the traits `identify()` has set. Attributes with no
  value are left out and counted rather than listed as blanks, and a person
  carrying more traits than a row returns says how many are not shown.

  The same honesty details as Funnels, for the same reasons. A saved segment's
  count is the server's **cache** from its last evaluation, shown with the
  instant it was taken and never passed off as current; a segment that has
  never been evaluated says so rather than rendering as a count of zero. The
  list does not silently re-evaluate everything on every visit, because each
  evaluation is a real ClickHouse scan. And a segment whose stored tree no
  longer parses opens read-only rather than being offered for editing as
  though the builder understood it.

The account menu in the header also has a **Profile** screen, for changing the
admin's email address and password. Both changes require the current password —
a session is enough to read everything this install holds and deliberately not
enough to change what recovers the account — and a password change signs out
every other browser, which is the point of changing it after a leak. There is no
confirmation email, because Lyraflow sends no mail; a new address takes effect
immediately.

**Archiving a project** stops Lyraflow accepting events for it and nothing else.
Its data is untouched, every report still works, retention still applies, and
restoring it is one click. Events sent while it is archived are refused, not
queued, so they do not arrive later. **Renaming never changes the slug** — the
slug is what `lyraflow` commands address a project by, so a rename would
otherwise break scripts silently.

**Deleting a project** destroys it. Every event, person, trait and report, in both
databases, plus the project row itself — and unlike archiving there is no way back
short of a backup. Deleting asks you to type the project's slug, from Settings and
from the CLI alike, because nothing else about the action is reversible.

It runs as a background job rather than a single request: ClickHouse holds a
project's events across partitions in three tables and two more that need
asynchronous mutations, which takes minutes on a large project. Confirming stops
Lyraflow accepting events for the project, then the teardown waits for the last
in-flight events to drain before it starts — about a minute on a default
install, because each project's row is cached in memory for that long and a
teardown that raced it would drop partitions those events were still landing in.
Then it tears ClickHouse down, confirms nothing is left, and only then removes
the project from Postgres — in that order, so a half-finished delete can be
retried rather than leaving data nothing will ever sweep again. Settings shows
the progress; `lyraflow projects deletion get <id>` reports the same thing, and
`lyraflow projects deletion retry <id>` resumes one that gave up.

**Volunteering the limit:** that is the whole UI. People and person profiles
have **no** screens at all yet; reach them the way the rest of this document
shows, over the HTTP API or the CLI.

The funnel screen's per-step people panel is backed by
`POST /v1/funnels/:id/people` (see *Funnels* below) — the same bounded member
list Segments uses, traits and all. It does not open a person profile from
there, because there still isn't one (see above). The CLI has not caught up
to this yet: `lyraflow funnels dropoff` still only walks the dropped
population, so reading who *reached* a step is UI- and API-only for now.

## Tracking more than one site

Two separate websites, a marketing site and the app behind it, staging and
production: each of those is a project, and one install carries all of them.
Run `create-project` once per site.

```sh
docker compose exec lyraflow node packages/cli/dist/index.js create-project "Acme Store"
docker compose exec lyraflow node packages/cli/dist/index.js create-project "Acme Docs"
```

Each call prints its own write key and server key. Names must be unique after
slugification (`Acme Store` → `acme-store`), and running it twice with the
same name is refused with a message saying so rather than a database error.

### The keys are the project selector

**No request to Lyraflow ever names a project.** There is no project id in any
path, no `?project=` parameter, and no `--project` flag on the CLI. The key
you present *is* the selection:

| | |
| --- | --- |
| **Write key** `wk_…` | Picks the project on ingest. The snippet on `acme.example` carries that project's write key; the snippet on `docs.example` carries the other. |
| **Server key** `sk_…` | Picks the project on every read, export and deletion. One `lyraflow stats` call reports on exactly one project — whichever key it authenticated with. |

So switching projects means switching keys, and nothing else:

```sh
LYRAFLOW_SERVER_KEY=$STORE_KEY lyraflow stats --since 24h
LYRAFLOW_SERVER_KEY=$DOCS_KEY  lyraflow stats --since 24h
```

`lyraflow snippet` follows the same rule — it prints the install block for the
project whose server key it authenticated with, so run it once per project and
paste each result on its own site.

### What a project separates, and what it does not

Separation is in the storage layout, not a filter applied at query time. The
events table is partitioned and ordered by project first, and every table in
Postgres — identity bindings, aliases, segments, saved views, ingest counters,
deletion requests — carries a project foreign key. A segment id or person id
belonging to another project answers `404`, never `403`.

| Per project | Shared by the whole install |
| --- | --- |
| Events, people, and identity | The Postgres and ClickHouse containers |
| Segments and saved views | The ingest buffer (see below) |
| `retention_months` — 13 by default | The retention worker's schedule |
| `monthly_event_quota` — unlimited by default | Backups: one script dumps every project together |
| Usage counters, and the quota `429` | `LYRAFLOW_ALLOWED_ORIGINS` (see below) |

Three of those are worth stating plainly rather than leaving to be discovered:

**`LYRAFLOW_ALLOWED_ORIGINS` is one list for the whole install.** It is a
server env var, not a project column — on the Compose stack, a line in `.env`
that the `lyraflow` service's `environment:` block passes through. Unset — the
default — every origin is allowed and a second site needs nothing. But **if
you have set it, every domain you instrument must appear in that one list**
(`https://acme.example,https://docs.example`), because creating a project does
not extend it. The symptom of forgetting is a site whose events never arrive
while its snippet looks perfectly correct: the browser's CORS preflight is
refused before any request reaches ingest, so nothing is rejected, dead-lettered
or counted anywhere you would think to look. Because that silence looks the
same as a variable that never reached the server at all, the boot log states
which of the two you have — see [When the allowlist does not take
effect](#when-the-allowlist-does-not-take-effect).

**The ingest buffer is one buffer, not one per project.** It holds 100,000
rows by default (`LYRAFLOW_BUFFER_MAX_ROWS`), and it is shared. A burst on
your busiest site can push the buffer to its limit and cause events from a
quiet one to be throttled. A per-project quota bounds how much a project may
*accept* in a month; it does not reserve capacity for it in the moment.

**A backup is per install.** `backup.sh` and `restore.sh` operate on both
databases whole. There is no way to back up, restore, or move one project on
its own.

### Identity does not cross projects

This is the consequence most likely to be discovered late, so decide it before
you instrument anything.

Identity bindings and person aliases are keyed by project. **The same
`user_id` in two projects is two unrelated people.** Calling
`identify('user-42')` on both of your sites produces two separate profiles,
with separate event histories, that no query joins and no merge can combine. A
person who signs up on one site and later reads the other is two visitors, and
Lyraflow will never tell you they are the same human — not because the join
fails, but because it is never attempted.

That is the right model when the sites are genuinely separate products. It is
the wrong one if you want to answer "did the docs visit lead to the signup?"

### If you want one journey across both sites

Use **one** project, and put the site on every event as a property:

```js
lyraflow.init({ writeKey: 'wk_...', host: 'https://analytics.example.com' })
lyraflow.track('signup', { site: 'store' })
```

Identity then works across both — one `user_id` is one person, and their
journey spans the sites — and segments filter on `site` like any other
property. What you give up is everything in the "per project" column above:
one retention setting, one quota, one server key that reads both sites, and a
`site` filter you must remember on every query, since forgetting it silently
returns both.

Neither choice can be changed later without re-ingesting, because it decides
how identity was resolved at write time. Separate products: separate projects.
One product across several domains: one project.

### `lyraflow projects`

    lyraflow projects list
    lyraflow projects delete <slug> [--yes] [--queue]
    lyraflow projects deletion get <id>
    lyraflow projects deletion retry <id>

`delete` asks you to type the slug before it does anything. `--yes` skips the
prompt for scripts; without it, a non-interactive stdin refuses rather than
hanging. By default the CLI performs the teardown itself, so it works on an
install whose server is stopped; `--queue` leaves it for the running server.

It also pauses before starting, and says so. Lyraflow caches each project's
row in memory for a minute, so for that long after you confirm, a running
server can still be accepting events for the project out of a cache that has
not heard about the deletion — and a teardown that started immediately would
drop partitions those events are about to land in. The command waits that
window out first. On a default install that is about a minute.

**When a deletion fails.** A teardown that keeps failing stops being retried
after five attempts and reports `failed`, with the reason in `deletion get`.
The project is then in a half-finished state: it accepts no events, it is gone
from every screen but Settings, and whatever survived the teardown is still in
ClickHouse — where retention keeps sweeping it, so it is not invisible.
`deletion retry <id>` puts the request back in the queue and the teardown
starts again from the top, which is safe to repeat: every step of it is
predicated on the project and dropping something already dropped does
nothing.

### What is missing today

- **No cross-project read.** No endpoint aggregates projects, so an "all my
  sites" total does not exist in the API. Getting one means querying
  ClickHouse directly, or calling each project in turn and adding up.
- **One project per page.** The browser SDK keeps a single configuration on
  `window.lyraflow`; calling `init()` again reconfigures it from scratch
  rather than adding a second destination. One page cannot report to two
  projects at once.

## The ingest API

Ingest listens on port 3000. `/v1/track`, `/v1/page`, `/v1/identify` and
`/v1/batch` all authenticate with the write key in the `x-lyraflow-write-key`
header.

### Endpoints

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/track` | A named thing a person did. Requires `event`. |
| `POST /v1/page` | A page or screen view. Always stored as `$page`; an optional `name` becomes the `$page_name` property. |
| `POST /v1/identify` | Attach traits to a known user. Requires `user_id`; stored as `$identify`. |
| `POST /v1/batch` | `{"batch": [ … ]}` — 1 to 500 items, each with an explicit `"type"` of `track`, `page`, or `identify`. |

`/health` (liveness), `/ready` (readiness), and `/metrics` (Prometheus text
format) are also served, and are not authenticated.

### `GET /v1/project`

Server-key authenticated (`x-lyraflow-server-key`), unlike every endpoint
above. Returns `{"name", "slug", "write_key"}` — the project's own identity,
including the write key, which `create-project` otherwise prints only once
and nothing else serves. This is **not** a widening of what the server key
can already do: it is a secret, hashed at rest and unrecoverable, that
authenticates every read path in this API — a caller holding it can already
read every person, event and segment in the project, so handing back a value
that ships unhidden in the browser bundle of every instrumented page changes
nothing about what that caller can reach. `lyraflow snippet` (see
[`packages/cli/README.md`](packages/cli/README.md)) is the intended way to
use this endpoint: it prints a paste-ready install snippet with the write key
already filled in, rather than a caller reading this response by hand.

### `PATCH /v1/project`

Also server-key authenticated. Body is `{"retention_months"}`,
`{"monthly_event_quota"}`, or both — this is what the [Web UI](#web-ui)'s
Settings screen calls, and it is the only API surface documented under
*Retention* and *Quotas* below; there is no longer a raw SQL statement to run
for either. **A field's absence means "leave it alone"; it is not the same as
sending it explicitly.** `monthly_event_quota: null` sets unlimited;
omitting the key entirely changes nothing about the existing quota. Sending
neither field is a `400`. `retention_months` is `1`–`120`, matching the
column's own check constraint; `monthly_event_quota` is a positive integer
or `null` — `0` is rejected rather than accepted and silently misread as a
limit, since `0` is what `isOverQuota` treats as "no limit configured" and
refusing it here is cheaper than that ambiguity reaching ingest. Returns the
row's current `{"retention_months", "monthly_event_quota"}` on `200`, and
invalidates the 60-second project cache the retention worker and the ingest
quota check both read from, so a new limit is in force immediately rather
than up to a minute later.

### `GET /v1/project/usage`

Server-key authenticated. Returns the active project's counters for the
current calendar month — `{"month", "events_accepted", "events_rejected",
"events_throttled", "events_bot", "monthly_event_quota"}` — all zero for a
project with no row yet this month, which is the ordinary state for a
brand-new one. `events_bot` counts events dropped as crawler traffic and is
reported apart from `events_rejected` (malformed input), because a large
rejection count means the integration is broken and a large bot count does
not. This is what the Settings screen's usage card reads.

### `GET /v1/projects` and `POST /v1/projects`

**Session-cookie authenticated, not server-key** — these are instance-scoped
("which projects exist", "create one") rather than project-scoped, so a
server key (which names one project) cannot answer them, and accepting one
would let a single project's credential enumerate every other project on the
install. In practice this means: the CLI's `create-project` and these two
routes are the only ways to create a project, and only an admin signed into
the [Web UI](#web-ui) (or holding its session cookie) can list every project
or create a new one over HTTP. `GET /v1/projects` returns
`{"projects": [...]}`, wrapped rather than a bare array, with each entry
shaped `{"id", "name", "slug", "created_at", "retention_months",
"monthly_event_quota"}` and **no key of either kind** — the one response in
this API that names every project at once, so a key leaking here would leak
the whole install rather than one project. `POST /v1/projects` takes
`{"name"}`, slugifies it the same way `create-project` does, and returns
`{"name", "slug", "write_key", "server_key"}` — the server key shown once,
exactly as `create-project` prints it once, and never served again by
anything.

### `GET /v1/meta`

**What release this install is running**, as `{"version": "0.10.0"}`. The Settings
screen's Install card reads it, which is where an operator finds the number to
quote into a bug report or to compare against the latest release.

**Session-cookie authenticated, like the two routes above**, and instance-scoped
for the same reason — "what version is this" names no project, so a server key
cannot answer it. It is deliberately **not** on `/health`: a version number tells
a caller which published advisories apply to the install, and `/health` answers
anything that can reach the port. Requiring a signed-in admin is the difference
between an operator reading their own version and the internet reading it.

`/v1/meta` rather than `/v1/version` because the path is the expensive half to
change later and the body is not. It carries one field today; a second is a
decision about what an install discloses about itself, not a field appended in
passing.

Sent directly from browser JavaScript (as opposed to a server-side SDK),
### Page views, and the `$` prefix

**Every page view is stored under the event name `$page`**, named or not. A name
becomes the `$page_name` property rather than the event name, so "how many page
views" is one query and `page('signup')` cannot be confused with
`track('signup')`.

It works that way for a storage reason as much as a naming one: `event_name` is
a `LowCardinality(String)` column and the second key of the schema catalogue's
sort order, while page names are unbounded by construction — one per URL. Under
the old behaviour every page name also claimed its own property-key budget
instead of all page views sharing one.

**`$` is reserved for Lyraflow.** A property key you send that begins with `$`
is **dropped**, in both the string and the numeric map — dropped rather than
refused, because ingest degrades rather than failing an otherwise valid event,
and because the write key is public and refusing here would hand a visitor a way
to make a site's events disappear. Everything else about the key is untouched:
`price_$` and `a$b` are ordinary keys and are stored.

Events already stored under a page name stay as they are. This changes what is
written from now on, not history — so a project that used `page(name)` before
this release has its old page views under their old names and its new ones under
`$page`.

`/v1/track`, `/v1/page`, `/v1/identify` and `/v1/batch` are CORS-preflighted
requests. By default Lyraflow answers that preflight for any origin — set
`LYRAFLOW_ALLOWED_ORIGINS` (comma-separated) to restrict it. On the shipped
Compose stack that means a line in `.env`, which the `lyraflow` service's
`environment:` block passes through; anywhere else it is an environment
variable on the server process. **Confirm it took effect rather than assuming
it did:** the server states which mode it is in on every boot, so
`docker compose logs lyraflow | grep 'ingest CORS'` answers it in one line.
Getting `ingest CORS unrestricted` back after setting the variable means the
value never reached the process — see [When the allowlist does not take
effect](#when-the-allowlist-does-not-take-effect).

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
| `name` | `page` only | Page name, up to 128 characters. Stored as the `$page_name` **property**, never as the event name. |
| `properties` | no | Flat object. `track` and `page` only. |
| `traits` | no | Flat object. `identify` only. |
| `timestamp` | no | ISO-8601. Defaults to server time at receipt; see *Retries*. |
| `context` | no | `url`, `path` and `referrer`, up to 2048 characters each; `user_agent`, up to 1024; `library` (`{name, version}`, both required when present, up to 128 characters each); and the five `utm_*` fields, up to 128 each. |

A payload that declares one of Lyraflow's server-side SDKs is never filtered as a
bot. That matters because the HTTP clients those SDKs use announce themselves as
`python-requests`, `okhttp` or `curl/` — indistinguishable from a scraper, and
dropped as one before this field existed. The browser SDK does not send this field;
an absent library is filtered exactly as before.

**A server-side SDK is judged on the visitor agent it forwards.** If a payload
declares a server-side library *and* carries `context.user_agent`, that value is
what the bot filter reads, and what `device_type`, `os` and `browser` are parsed
from. So a backend passing through `Googlebot/2.1` has that crawler filtered
rather than recorded as a person — and a backend passing through a real
visitor's agent stops recording an unknown device. A declared SDK that forwards
nothing is exempt exactly as before.

`context.user_agent` is only consulted for a declared server-side library.
Everything else — every browser payload — is judged and enriched from the
request's own `User-Agent` header, as it always has been.

**Bot filtering is data hygiene, not a security boundary.** The write key ships
inside the browser bundle, so any client can claim to be a server-side SDK — or
simply send a browser's User-Agent, which has always been possible. What the filter
removes is incidental traffic: crawlers, uptime monitors, link-preview fetchers.
None of those declare a library.

Reading a forwarded agent does not widen that. It is consulted only for callers
already exempt, so it can only ever cause **more** filtering, never less: there
is no payload it lets through that could not already get through by declaring a
library and forwarding nothing.

Property and trait values may be strings, numbers, booleans, or null. Numbers
are stored in a numeric column and everything else as text, so `3` and `"3"` are
not interchangeable. Nested objects and arrays are not supported. An event may
carry up to 250 properties.

**A boolean is stored as the text `true` or `false`, and there is no boolean
type.** That is more than a storage detail, because it means `true` and the
string `"true"` are the same value once ingested — indistinguishable, with no
way to tell them apart afterwards. Three consequences worth knowing before you
instrument anything:

- `/v1/schema/properties` reports `string` for such a property, never
  `boolean`, so autocomplete cannot tell a caller the underlying value is
  two-valued.
- **A segment filter must use the string form**: `is_subscribed = "true"`, not
  `is_subscribed = true`.
- `"True"`, `"1"` and `"yes"` are three *different* values in that same column,
  from callers who each reasonably believed they were sending a boolean.
  Nothing rejects, warns, or reports the coercion, so an integration looks
  correct and the divergence only surfaces when someone builds a segment months
  later.

If you send booleans, send them consistently and expect to filter on `"true"`.

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
  discarded. `/metrics` reports the accepted, rejected, throttled, over-quota
  and bot totals, so a `202` that stored nothing is still visible there.
- `401` — missing or unknown write key, **or a project that has been
  archived**, which answers `{"error":"project_archived"}`, **or one being
  deleted**, which answers `{"error":"project_deleted"}`. Both stop collection
  deliberately; the status is `401` rather than `403` because the browser SDK
  treats `401` as final and stops, while any other status is retried
  indefinitely by every bundle already deployed on a page.
- `429` with `{"error":"quota_exceeded"}` — the project has used its monthly
  event quota. **No `retry-after`, deliberately**: unlike a `503`, this does not
  clear on its own shortly. It holds until the month rolls over or an operator
  raises the limit, so retrying is pointless. No project has a quota until an
  operator sets one; see *Quotas* under Operations.
- `503` with `retry-after: 5` — the server is saturated or shutting down. Retry.
- `400` / `413` — malformed JSON, or a body over 1 MiB. Retrying will not help.

`/v1/batch` always answers with counts:
`{"accepted":n,"rejected":n,"throttled":n,"over_quota":n,"bot":n}`. It returns
`503` if the buffer saturates part-way through, with the counts describing how
far it got; retry the whole batch. It never returns `429`: a batch answers
`202` with `over_quota` counting the events refused, because its contract is a
body carrying the tally rather than a wholesale failure over one event. Those
events are not worth retrying either. **Read `over_quota` even when the status
is `202`** — for a batch, it is the only signal that events were refused.
`bot` counts items dropped as bot traffic, the same outcome `/metrics` reports
above. Single-event routes (`/v1/track`, `/v1/page`, `/v1/identify`) are
unchanged: they still answer `{"status":"accepted"}` regardless of outcome and
carry no such count.

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
  lyraflow.init({ host: "https://analytics.example.com", writeKey: "wk_live_…" })
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
and `writeKey` with the `wk_…` key from [Getting started](#1-install) above — the same
one your server-side calls already use. Or skip the substitution entirely:
`lyraflow snippet` (see [`packages/cli/README.md`](packages/cli/README.md))
prints this exact block with your project's own host and write key already
filled in, plus which event names have actually arrived, so you can tell
"installed" from "firing" without opening a browser.

The bundle is served by the app itself at two paths, unauthenticated (a
`<script>` tag has no way to send a header):

| Path | Cache policy |
| --- | --- |
| `GET /lyraflow.js` | `max-age=300` — an upgrade reaches already-cached browsers within five minutes |
| `GET /lyraflow-<version>.js` (e.g. `/lyraflow-0.2.0.js`) | `max-age=31536000, immutable` — these exact bytes never change, for as long as the server runs that version |

Both paths are served gzipped to any client that accepts it, by the app
itself — putting a compressing proxy in front is a valid thing to do, but it
is not something you have to do to avoid shipping three times the bytes.

**Put `/lyraflow.js` in your script tag. The versioned path is cache-busting,
not pinning, and a script tag must not use it.** A server only serves the
versioned path for the version it is currently running, so upgrading makes the
previous one answer `404` — naming the version it does serve, and telling you
this. That failure is quiet in the worst way: browsers holding the old bundle
keep working from cache for up to a year, so data goes on arriving while every
*new* visitor silently collects nothing.

The versioned path exists so an upgrade cannot be served a stale cached bundle,
not so a site can freeze one. There is no way to pin an SDK version against a
server that has moved on; if you need that, pin the *server* to a release tag.

If the sibling package was never built into your image, both paths answer `503`
rather than taking the rest of the server down.

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
  autoPageView: true,           // optional; default true — fires one page() at init, see Single-page apps below
  debug: false,                 // optional; default false — verbose console.debug logging
})
```

```js
lyraflow.track('signup', { plan: 'trial', seats: 3 })
```

```js
lyraflow.page()            // stored as $page, with no $page_name
lyraflow.page('Pricing')   // stored as $page, with $page_name = "Pricing"
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
[The ingest API](#the-ingest-api) for that endpoint's own semantics), on a
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

The CORS preflight restriction described in [The ingest API](#the-ingest-api)
applies here too, since this is exactly what triggers it: the same
`LYRAFLOW_ALLOWED_ORIGINS` env var, and the same limit. It stops someone from
quietly reusing your write key on a different origin without you noticing —
it is **not** a security boundary, because the write key already ships in
page source and any non-browser sender ignores CORS entirely.

### When the allowlist does not take effect

Setting `LYRAFLOW_ALLOWED_ORIGINS` somewhere the server never reads it fails
**silently and in the permissive direction**: nothing errors, the stack comes
up healthy, and every origin is still allowed. There is no outward difference
between that and a working allowlist until somebody tries the thing the
allowlist was meant to stop.

So the server says which mode it booted in, every time:

```sh
docker compose logs lyraflow | grep 'ingest CORS'
```

- `ingest CORS restricted to 2 origin(s) …` — it took effect, and the line
  names the origins it parsed.
- `ingest CORS unrestricted …` — it did not. Every origin is allowed.

The usual cause of the second line is Compose. **`.env` alone is not enough
unless the variable is also named in the `environment:` block of the
`lyraflow` service** — Compose uses `.env` for substitution inside the compose
file and passes the container only the variables that block names. The shipped
`docker-compose.yml` names this one, so a plain `.env` line works on a stock
install; a compose file predating that, or a hand-edited one, does not. Check
what actually reached the container:

```sh
docker compose exec lyraflow env | grep ALLOWED_ORIGINS
```

Empty output there, with the value present in `.env`, is exactly this bug.

The same silence applies to a value that *did* arrive but does not match:
origins are compared exactly. `https://example.com` and
`https://www.example.com` are two different origins, `http://` and `https://`
are two different origins, and a trailing slash or a port that the browser
does not send makes an entry match nothing. A blocked preflight is not
rejected, dead-lettered, or counted anywhere — so if one instrumented site
goes quiet while the others keep reporting, compare its entry against the
`Origin` header the browser actually sends, character for character.

### Single-page apps

The SDK does not patch `history.pushState` or listen for route changes, and
`autoPageView` does not change that: its one automatic `page()` call fires
once, on this hard load, and never again for the life of the tab. A visitor
who navigates client-side through five routes without a full reload produces
exactly one page view unless you call `lyraflow.page()` yourself after each
client-side navigation completes.

## Identity resolution

Lyraflow stitches a device's anonymous activity to the person it belongs to,
and lets you merge two people that turn out to be the same one. Filtering and
segmentation are built on top of it — see [Segments](#segments) below.

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

This is a known cost, not an oversight. A write-side suppression
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
ids already resolve to the same person. **Aliasing is not reversible** —
there is no `unalias`, and merging `A` into `B` and then `B` into
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
      "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "launch",
      "traits": { "plan": "trial", "company": "Acme" },
      "traits_num": { "seats": 12 },
      "trait_total": 3 }
  ],
  "next_cursor": "eyJ...base64url...",
  "window_exhausted": false
}
```

Each member row carries `person_id`, `first_seen`, `last_seen`, and the ten
`context` fields (see *Node types* below) at their **current** value — not the
`first_touch` one, even for the four fields that are only ever recorded as
first-touch (see the caveat below `context` for why `latest` reads the same
value there).

It also carries that person's **traits**, split by type the way they are
stored: strings in `traits`, numbers in `traits_num`. At most 50 of each are
returned, in key order — a per-person map is of arbitrary size, and a hundred
rows of one would be unbounded by construction. `trait_total` is how many that
person actually has, so a truncated map is visible as truncated rather than
read as complete.

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
| `behavior` | an event name (or `*` for any), aggregated as `count`, `sum`, `min`, `max`, or `distinct`, over a `last` / `absolute` / `ever` window, optionally narrowed by `where` (see below) |

##### Operators

There are five families, and **which ones a condition may use depends on what
it is comparing** — a country is never a flag, a `first_seen` is always set.

| family | operators | value | admitted on |
| --- | --- | --- | --- |
| compare | `=` `!=` `>` `>=` `<` `<=` `between` | one, or two for `between` | everything |
| text | `contains` `not_contains` `starts_with` `not_starts_with` `ends_with` `not_ends_with` | one string | traits, properties, context, event columns |
| presence | `is_set` `is_not_set` | **none** | traits, properties, context, event columns |
| boolean | `is_true` `is_false` | **none** | traits and properties |
| relative date | `in_last` `not_in_last` | `{ "n": 7, "unit": "days" }` (`hours` or `days`) | traits, properties, `lifecycle` |

`between` takes exactly two values; the presence and boolean families take
**no `value` key at all**, and sending one is ignored rather than refused.

Four things about these that are easy to get wrong, and that Lyraflow has
picked a side on:

- **Text matching is case-insensitive; `=` is not.** `path contains checkout`
  finds `/Checkout`. Equality was case-sensitive before these operators
  existed and stays that way, because changing it would silently reinterpret
  every segment already saved. The folding is ClickHouse's `lowerUTF8`, which
  handles accented Latin and Greek but **not** Turkish dotted `İ` — so
  `contains istanbul` does not match `İSTANBUL`.
- **`is_set` is not `!= ""`, and that is why it exists.** A property or trait
  that was never sent reads back as the empty string, exactly like one that
  was sent empty. No comparison can separate them; `is_set` can.
- **Negations include people who have nothing there.** `plan not_contains pro`
  matches someone with no `plan` at all, as does `not_in_last`. If you mean
  "has a plan, and it is not pro", combine it with `is_set`.
- **`is_true` / `is_false` match the stored text `"true"` / `"false"`**, which
  is what ingest writes for a JSON boolean. They do not treat `"1"`, `"yes"`
  or a non-empty string as true.

A relative date is resolved when the segment **runs**, not when it is saved,
and a trait or property is read through a best-effort date parse — a value
that is not a date is simply not in the window.

#### `where`: narrowing a behaviour to particular events

A `behavior` — and a funnel step, which uses the same shape — may carry up to
ten `where` predicates. They are ANDed together and applied to each event
BEFORE it is aggregated, so they say *which* events count, not what the person
is like.

A funnel step shares more than that shape with a `behavior` now: it may also
carry a whole `audience` condition tree — the same `FilterNode` grammar this
section documents, gating which *person* may advance past the step rather
than which *event* counts. See *Funnels* above for the distinction and the
per-funnel cap on it.

A predicate names one of two things, and it says which:

```json
{ "kind": "behavior", "event": "$page", "aggregate": "count",
  "operator": ">=", "value": 1, "window": { "kind": "last", "n": 30, "unit": "days" },
  "where": [
    { "property": "plan", "operator": "=", "value": "pro" },
    { "source": "attribute", "attribute": "utm_campaign", "operator": "=", "value": "spring" }
  ] }
```

- **A property predicate** reads a key from the event's own `properties` —
  whatever the caller put there. This is the default: a predicate with no
  `source` is a property predicate, which is why every segment written before
  attributes existed still means exactly what it meant.
- **An attribute predicate** reads a column of the event itself. Set `"source":
  "attribute"` and name one of `path`, `url`, `referrer`, `utm_source`,
  `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `device_type`, `os`,
  `browser`, `country`, `region`, `city`. Any other name is a `400`. Values are
  strings, because every one of those columns is a string.

**Nothing is inferred from the name.** A property genuinely called `path` is
possible — `properties` comes from the caller's own bag and `path` from
`context` — so `{ "property": "path" }` reads the property and
`{ "source": "attribute", "attribute": "path" }` reads the column, whichever
one your events happen to carry.

**A property predicate's VALUE TYPE chooses which map it reads.** Ingest puts
a finite number in `properties_num` and everything else in `properties`, and a
predicate reads one or the other: `{"property": "results", "value": 21}` reads
the numeric map, `{"property": "results", "value": "21"}` reads the string one.
They are different questions, and the wrong one matches nothing rather than
erroring — so send the type you sent at ingest. `GET /v1/schema/properties`
returns a `value_kind` per key if you need to look it up; the web UI reads it
and sends the matching type for you.

**An attribute predicate is not a `context` condition**, and the difference is
the question each answers. A `context` condition is about the PERSON: it
matches whoever was acquired through a campaign, whatever they later did. A
`where` predicate is about the EVENT: it matches people who did *this* thing
*from* that campaign. "Viewed pricing at least once in the last 30 days, from
the spring campaign" is the second, and cannot be written as the first.

**A `lifecycle` bound with no timezone is UTC.** `2026-08-01T10:00` means
10:00 UTC, and a bare `2026-08-01` means midnight UTC. Send an instant with a
`Z` or an offset if you want to be explicit — both are accepted and honoured —
but a value with neither is never read in the server's local zone.

That is worth knowing if you have bounds stored from before this release: they
used to be resolved with the server's own timezone, so the same segment meant
a different instant depending on where the process thought it was, and moving
a deployment between zones silently changed which people it matched. Those
bounds now mean UTC. If your server was not on UTC, such a bound has shifted
by that offset — once, visibly, and the builder shows the instant it now names
when you open the segment.

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

**Every event name is discoverable, including events that carry no properties
at all.** That was not always true, and the limitation is worth recording
because upgrading is what fixes it: both endpoints read from `event_schema`,
which was fed only by an `ARRAY JOIN` over each event's property maps — and an
`ARRAY JOIN` over an empty map produces no rows, so an event with no properties
registered nothing and was invisible to `/v1/schema/events`, not merely absent
from `/v1/schema/properties`.

A third view now writes one row per event whose only job is to register the
name. **Existing events are not backfilled**: a property-less name recorded
before this release appears once the next such event arrives, which for a name
your product still sends is the next time it fires.

`/v1/schema/properties` for an event with no properties correctly returns an
empty list — the name is discoverable, and there is genuinely nothing to filter
on.

```sh
curl -s http://localhost:3000/v1/schema/events?q=import \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
# {"events":[{"event_name":"import_started","last_seen":"2026-08-01T00:00:00.000Z"}]}

curl -s http://localhost:3000/v1/schema/properties?event=import_started \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY"
# {"properties":[{"property_key":"rows","value_kind":"number"},{"property_key":"source","value_kind":"string"}]}
```

| Parameter | Applies to | Meaning |
| --- | --- | --- |
| `q` | both | prefix filter, matched against the event name or property key |
| `event` | properties only | restrict to one event's properties |
| `limit` | both | max rows to return, default 50, capped at 100 |

`limit` above 100 is rejected with `400`, not silently truncated.

Each event carries **`last_seen`**, the latest instant that event name was
recorded, as an ISO-8601 timestamp — enough to rank an autocomplete by recency
rather than alphabetically, which is what stops the list becoming useless once
a project is a year old. There is still **no frequency signal**, because
`event_schema` carries no counts.

**Results are name-ordered, and `limit` is applied after that ordering.** So a
project with more event names than the cap gets the alphabetically first `N`,
and can only re-rank *within* those — `last_seen` does not currently let you
ask for the most recent 50 event names out of 500. Ordering server-side by
recency would, and is the obvious next step; it is not the default today
because it changes which rows every existing caller receives.

Otherwise deliberately thin: prefix vs. fuzzy matching, and ranking by
frequency or name, are questions for whichever builder UI ends up consuming
this — this ships the raw read those can be built on top of, rather than a
guess at one of them.

### What this does not do yet

Every segment above is built and run through the HTTP API directly, in JSON.
There is **no export** of a segment's membership:
the members endpoints are a bounded 1,000-row preview, not a way to pull an
entire population out. There is **no point-in-time membership** — a saved
segment stores its last count and when it was computed, not who was in it at
that moment, so you cannot ask "who matched this segment last Tuesday".
Membership is also not recomputed automatically on any schedule; a saved
segment's snapshot only updates when you explicitly run it. Those are
planned; none of them exist today.

## Funnels

A funnel is an ordered list of steps — "landed, clicked login, registered,
paid" — and one question: how many people got through each one, and where did
the rest stop.

Funnels are **saved objects**. You create one, give it a name, and re-run it
over whatever date range you care about. There is a funnel screen in the
[Web UI](#web-ui) too (see below) — this section documents the full HTTP API
and the CLI, which is what that screen itself is built on.

### Defining one

```sh
curl -X POST https://analytics.example.com/v1/funnels \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "signup",
    "window_seconds": 604800,
    "steps": [
      { "event": "$page", "where": [{ "property": "path", "operator": "=", "value": "/" }] },
      { "event": "login_click" },
      { "event": "signed_up", "where": [{ "property": "method", "operator": "=", "value": "email" }],
        "audience": { "kind": "behavior", "event": "$page", "aggregate": "count", "operator": ">=",
          "value": 3, "window": { "kind": "last", "n": 30, "unit": "days" } } }
    ]
  }'
```

A **step** is one event, plus two independent things you can constrain about
it. `where` narrows **which occurrence** of the event counts — a property of
the event itself, exactly the shape a segment behaviour uses —
`{ property, operator, value }`, with the same operators a segment condition
takes (see [Operators](#operators)) — so you write a predicate the same way in
both places.
Predicates matter more than they look: a page-view funnel is several `$page`
steps that differ only by `path`.

`audience` narrows **which person** may advance past the step — a claim about
them, not about the event. It is a segment `FilterNode` tree verbatim, the
same grammar `POST /v1/segments` takes (see *Node types* below), and it is
optional per step. A person who fails it is not removed from the report — they
are still counted at the step they did reach, just not advanced past this one.
That is the difference from the funnel's own `segment_id`: a person outside
the funnel's segment never appears in the report at all, while a person who
fails a step's `audience` still shows up, one step short. Both exist because
those are different questions — "should this person be in this report at all"
versus "does this person, having reached step 2, look the way step 3 requires
before they can be counted at step 3."

A step's `audience` tree is capped like any segment tree, but there is also a
**funnel-wide** cap: the behavioural conditions across every step's `audience`
in one funnel may total at most 25
(`MAX_FUNNEL_BEHAVIOR_NODES`, `packages/core/src/funnels/validate.ts`). That
covers the embedded audiences only — the tree behind `segment_id` is a
separate segment, capped separately at 25 behavioural nodes of its own when it
was saved — so one run's real worst case is up to 50 behavioural conditions,
not 25. A trait-only audience costs nothing against that cap but still adds
its own subquery, one per step at most — bounded by the eight-step ceiling
above, not by `MAX_FUNNEL_BEHAVIOR_NODES`.

Two steps minimum, eight maximum.

### Optional steps

A step can carry `"optional": true`. Absent means required — which is what
every step was before this, so an existing funnel with no optional steps
reports exactly what it always reported.

```json
"steps": [
  { "event": "$page" },
  { "event": "signed_up" },
  { "event": "subscription_started" },
  { "event": "video_submitted", "optional": true },
  { "event": "subscription_canceled" }
]
```

Someone who skips `video_submitted` still counts at `subscription_canceled` —
an optional step does not disqualify anyone from the steps after it.
**Conversion is measured over the required steps only.**

An optional step branches off the last **required** step before it, not off
whatever step precedes it in the definition — two optional steps back to
back both branch from the same required step, not from each other. Its
`from_previous` is a share of that branch point's population, not of the
step written just above it. Its result carries `optional: true`, a
`skipped` count — the people who reached the branch point and did not do
this step inside the window — and a `continued` count: of the people who
*did* reach this step, how many went on to the next required step through
it. `people` is the leg into the step and `continued` is the leg out of it;
the gap between them is this step's own drop-off. A required step's result
carries none of the three.

**The first and last steps cannot be optional.** Step 1 defines entry — it
is what bounds who enters within the range — and the last step defines
conversion; making either optional leaves both undefined.

The funnel chart in the [Web UI](#web-ui) draws all of this as a flow
diagram, not a stack of bars: the required steps form a spine, an optional
step hangs off it as a branch, and the people counted in `continued` rejoin
the spine at the next required step — a fork that rejoins, the same shape
described above.

**What the widths mean.** Every node and every band is drawn on **one
scale**, set by the number of people who entered. A given thickness means the
same number of people wherever it appears, so bands are comparable to each
other and to the nodes they touch, anywhere on the chart.

Two things follow, and both are the point rather than side effects.

**The space under a node's bands is its drop-off.** A node holding 800 people
whose outgoing bands carry 500 of them leaves 300 people's worth of its edge
empty, and that gap is drawn where the loss happened.

**Bands can run past a node, and that means something too.** Someone who does
an optional step *after* a later step is counted on both legs leaving the step
before it — genuinely on two paths, because the funnel cannot tell which came
first. Where that happens the stack extends past the node's own edge, and the
node's caption names the number: `3 counted twice`. It is the same
`windowFunnel` limit documented above under ordering, seen from the chart.

An earlier version scaled each node's bands to fill its edge exactly. The
geometry always added up, at the cost of both readings above: a width meant
something only against the one node it touched, and a node's edge was always
fully covered — so a funnel that converts everyone drew as a solid rectangle
with no space anywhere in it.

A funnel may have up to `MAX_OPTIONAL_STEPS` (2) optional steps, inside the
same eight-step ceiling as before. Each optional step costs two extra
`windowFunnel` chains, and both copy the SQL text of every condition before
them — one measured shape at three optional steps compiles past ClickHouse's
262,144-byte `max_query_size` and fails outright, which is why the limit is 2
and not 3.

A funnel that compiles past that same limit some other way — enough `where`
predicates or step audiences, even with two or fewer optional steps — is
refused with a `400` before it ever reaches ClickHouse, naming what to
remove: predicates, audiences, or optional steps. That cap bounds the
failure; it does not fix it —
[#200](https://github.com/lyraflow/lyraflow/issues/200) tracks compiling this
down instead of capping it.

**The limit worth knowing before you rely on this:** an optional step counts
any time after the required step before it and inside the window —
*including after a later step*. Someone who cancels and then submits a video
afterward is still counted as having done the optional step.
`windowFunnel` reports a chain length, not the instants it matched at, so
"step 4 happened before step 5" is not a question this can answer without a
different query shape. That is also why the two bands leaving a branch point
on the chart do not have to sum to the branch point's own count: someone who
does the optional step *after* the required step it feeds into is counted on
both legs leaving that branch point — once heading into the optional step,
once heading straight past it on the required chain — the same
order-blindness, seen from the chart instead of from `/dropoff`.

### The three clocks

This is the part worth reading twice, because getting it wrong makes a funnel
quietly report the wrong number.

- **`window_seconds` belongs to the funnel.** It is how long one person gets
  to finish once they have started. Maximum 30 days.
- **`since` and `until` belong to the question**, and are supplied per run,
  never stored. They bound **who enters** the funnel — a person enters by
  matching step 1 inside that range.
- **A step's `audience` window belongs to the person, measured from now.**
  Its `last` window (like a segment's) looks back from the moment the funnel
  runs, not from the run's `since`/`until` and not from when that person
  entered. Run the same funnel over an older range and a step's `audience` is
  still judging people against **today**, not against the range you asked
  about or the day they took step 1 — the Web UI's funnel builder says this
  on screen for the same reason it is said here.

Because those are different things, a run **observes conversions past the end
of the range**: someone who entered an hour before `until` still gets their
full window to finish, so the query reads on to `until + window` (or to now,
whichever comes first). Without that, a funnel would report as failures people
who simply had not finished yet.

That leaves one honest gap, and the response names it rather than hiding it.
Someone who entered ten minutes ago has not had their seven-day window. They
are counted in `entered` — dropping them would misstate the population — and
also reported separately as `partial_window_entrants`, with a warning saying
how many. **They can still convert.** If a recent funnel looks worse than you
expected, that number is the first thing to check.

### Running one

```sh
curl -X POST https://analytics.example.com/v1/funnels/3/run \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "since": "2026-08-01T00:00:00Z", "until": "2026-08-08T00:00:00Z" }'
```

Omit both and you get the last seven days.

For a range relative to now, send `days` instead of a `since`:

```sh
curl -X POST https://analytics.example.com/v1/funnels/3/run \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "days": 90 }'
```

**Prefer `days` over a bare `since` for a relative range.** They are not
equivalent. `since` with no `until` leaves the server to fill in `until` from
its own clock, which is later than yours by however long the request took to
arrive, so the span you get is slightly longer than the one you asked for. A
range may span at most 90 days, so `"days": 90` is accepted and a `since` of
90 days ago is not. `days` cannot be combined with `since` or `until` — a body
carrying both is refused rather than resolved by a precedence rule you would
have to know about.

The response always echoes the range it actually used:

```json
{
  "entered": 1284,
  "converted": 212,
  "conversion_rate": 0.165,
  "steps": [
    { "index": 1, "event": "$page", "people": 1284, "from_previous": 1, "from_start": 1 },
    { "index": 2, "event": "login_click", "people": 507, "from_previous": 0.395, "from_start": 0.395 },
    { "index": 3, "event": "signed_up", "people": 212, "from_previous": 0.418, "from_start": 0.165 }
  ],
  "partial_window_entrants": 96,
  "range": { "since": "2026-08-01T00:00:00.000Z", "until": "2026-08-08T00:00:00.000Z" },
  "as_of": "2026-08-08T09:31:02.000Z",
  "warnings": [ … ]
}
```

A step's `people` is everyone who reached **at least** that step. Both rates
are given because deriving one from the other is a multiplication that is easy
to get subtly wrong.

`POST /v1/funnels/preview` takes the same body plus a full definition and runs
it without saving anything — for trying a funnel out before committing to it.

Every run also updates the funnel's **cached summary** — `last_entered`,
`last_converted`, `last_evaluated_at` and `last_range` — which is what
`GET /v1/funnels` returns so a list of N funnels renders without N scans.

`last_range` is the window those counts came from, as
`{ "since": …, "until": … }`, and it exists because the counts are meaningless
without it: running a funnel over 90 days used to leave the list showing a
90-day rate with nothing to say it was not the seven-day default. **Always
render the rate beside both its range and its timestamp**, never as a bare
number.

It is `null` in two cases, and they are not the same: a funnel that has never
run has `null` counts too, while a funnel summarised before ranges were
recorded has real counts and no record of what they answer. Neither should be
labelled with a guess.

All four are **cleared together** by a `PATCH` that changes `steps`,
`window_seconds` or `segment_id`. A stored range describes the definition it
was computed from just as much as the counts do.

### How a person is counted

- **In order.** Steps must happen in the order listed. Unrelated events in
  between are fine.
- **Best attempt.** Someone who abandoned on Monday and completed on Tuesday
  counts as converted. The window slides to find their best run through, so
  one bad start does not condemn them forever.
- **Once.** A person appears at exactly one step — the furthest they reached.
- **As one person.** Steps taken anonymously and steps taken after logging in
  belong to the same person, provided the device was identified (see *Identity
  resolution*).
- **Not at all, if they asked to be deleted.** The same suppression boundary
  every other read path enforces.

### Who dropped out

```sh
curl -X POST https://analytics.example.com/v1/funnels/3/dropoff \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "step": 2 }'
```

Lists the people who reached step 2 and went no further. Steps are numbered
from 1, matching `index` in the run response. Paged with an opaque cursor, and
bounded the same way the segment members preview is — 100 per page, 1,000
total. It is a preview of a population, not an export of it.

`/dropoff` predates `/people` below and is **retained for compatibility,
unchanged** — its own response shape, its own cursor label, so a caller that
already scripts against it never sees a difference. It is not two ways of
doing one thing: `/people` is the general endpoint, and `/dropoff` is the one
call it happens to always make (`mode: "dropped"`).

On an **optional** step, `/dropoff` is refused with a `400` — skipping a step
means never stopping there, so "stopped exactly here" is not a population an
optional step has. The error points the caller at `/people`, where `reached`
or `skipped` are the two readings that mean something.

### Who reached a step, or stopped there

```sh
curl -X POST https://analytics.example.com/v1/funnels/3/people \
  -H "x-lyraflow-server-key: $LYRAFLOW_SERVER_KEY" \
  -H 'content-type: application/json' \
  -d '{ "step": 2, "mode": "reached" }'
```

`mode` is **required** — there is no default. `reached` (`level >= step`,
everyone who got at least that far) and `dropped` (`level = step`, everyone
who stopped exactly there) differ by a factor of three on a real funnel, and
whichever way a default fell, the other reading is what a caller would get by
accident.

A third mode, `skipped`, exists for **optional steps only** — the people who
reached the required step this one branches off and did not do this step
inside the window, the same count the run response's `skipped` field gives
for that step. Asking for `mode: "dropped"` on an optional step is refused
with a `400` (`code: "mode"`): skipping it means never stopping there, so
that reading is not a population an optional step has. Asking for
`mode: "skipped"` on a required step is refused the same way — nobody can
skip a required step, so the mode means nothing there.

`reached` is the population behind the number on the chart: step N's `people`
in the run response above is exactly this count, at whatever instant the run
was taken. `dropped` is deliberately a different, usually smaller, number —
the same population `/dropoff` lists.

One case looks wrong and is not: at the funnel's **last** step, `dropped` is
not empty. A level means "got no further than this level" (see *How a person
is counted* above), so someone who converted all the way through is *at* the
last step's level too — there is no level past it to place them at instead.
`mode: "dropped"` on the final step therefore returns the same people
`mode: "reached"` does. This is not new behavior particular to `/people` —
`/dropoff` has always answered the final step this way — `/people` just makes
it visible as a "dropped" label sitting next to someone who converted.

The response:

```json
{
  "members": [
    { "person_id": "user-42", "first_seen": "2026-07-01T00:00:00.000Z",
      "last_seen": "2026-08-08T09:20:00.000Z", "entered_at": "2026-08-08T09:12:00.000Z",
      "country": "US", "region": "CA", "city": "San Francisco", "device_type": "desktop",
      "os": "macOS", "browser": "Chrome", "referrer": "https://google.com",
      "utm_source": "google", "utm_medium": "cpc", "utm_campaign": "launch",
      "traits": { "plan": "trial" }, "traits_num": {}, "trait_total": 1 }
  ],
  "person_count": 212,
  "range": { "since": "2026-08-01T00:00:00.000Z", "until": "2026-08-08T00:00:00.000Z" },
  "as_of": "2026-08-08T09:31:02.000Z",
  "next_cursor": "eyJ...base64url...",
  "window_exhausted": false
}
```

`person_count` is its own query, taken at the same `as_of` the page is —
never the run's cached step number, because a run and a `/people` call can
land at different instants, and a stale count printed beside a fresh page is
exactly the kind of mismatch that makes both look wrong. Paged and bounded
the same way `/dropoff` and the segment members preview are: 100 per page,
`window_exhausted: true` once 1,000 rows have been served, and a cursor that
only replays against this route, never `/dropoff` or a segment walk.

There is no CLI command for `/people` yet — see *From the CLI* below. The
funnel screen in the [Web UI](#web-ui) does have it: click a step in a saved
funnel and a Reached/Dropped toggle opens beneath the chart, each option
carrying its own count.

### From the CLI

```sh
lyraflow funnels list
lyraflow funnels run signup --since 7d
lyraflow funnels run signup --since 7d --json
lyraflow funnels preview --file signup.json
lyraflow funnels dropoff signup --step 2
```

Funnels are addressed by name. With `--json`, the step table goes to stdout as
one JSON object per line and everything else — the summary and any warnings —
goes to stderr, so a pipeline stays parseable and a human still sees the
caveats.

### What this does not do yet

There is **no time-to-convert**: you get how many people reached each step,
not how long it took them. There is **no breakdown** — you cannot split a
funnel by campaign, device or country. There is **no strict mode**, where a
later step appearing early breaks the chain. Trends and path analysis are not
here either. All are planned; none exist today. **Retention grids do now
exist** — see below.

A funnel is computed on demand every time you run it, with nothing cached and
nothing precomputed. A wide range over a high-volume event like `$page` is a
large scan, and the response will warn you when it is about to be one.

## Retention

*Of the people who did one thing in a period, how many came back and did
another in the periods after it.* Funnels ask where people stop inside one
flow; this asks whether they return at all.

```sh
curl -s http://localhost:3000/v1/reports/retention \
  -H "X-Lyraflow-Key: sk_..." -H 'Content-Type: application/json' \
  -d '{ "start_event": "signed_up", "return_event": "project_created",
        "granularity": "week", "periods": 8 }'
```

```json
{ "granularity": "week", "periods": 8,
  "cohorts": [
    { "cohort": "2026-06-01", "size": 412, "retained": [180, 96, 71, 64, 58, 55, 51, 49, 47] },
    { "cohort": "2026-06-08", "size": 388, "retained": [166, 88, 66, 60, 55, 51, 48, null, null] }
  ],
  "computed_at": "2026-08-27T09:00:00.000Z", "warnings": [] }
```

`retained[k]` is how many of that cohort did the return event in period *k*.
Period 0 is the cohort's **own** period — when the two events are the same it
is the whole cohort by construction, and when they differ it is usually the
most interesting number in the grid.

**`null` is not zero.** A cell is `null` when that period had not finished
when the grid was computed. This is the single most important thing about
reading one: a retention grid that reported unfinished periods as `0` would
show a collapse in its newest cohorts, in exactly the corner a reader scans
for a trend. `computed_at` says when "not yet" was decided; the same request
run later fills those cells in.

### What you choose

| field | meaning |
| --- | --- |
| `start_event` | what puts somebody in a cohort. `*` means any event, so `*` cohorts people by when you first saw them. |
| `start_where` | which *occurrence* of it counts — the same `where` grammar a funnel step and a segment behaviour take. |
| `return_event` | what counts as coming back. May be the same as `start_event`; `*` means any activity. |
| `return_where` | the same, for the return side, and **independent** of `start_where`. |
| `granularity` | `day`, `week` or `month`. Weeks start **Monday**, and every bucket is UTC. |
| `periods` | how many periods after the cohort's own to measure, up to 26. |
| `since` / `until` | bound who **enters** a cohort. Optional; defaults to the last `periods` periods. |
| `segment_id` | restrict the whole grid to a saved segment's population. |

**The two `where` lists are what make one event name usable.** On a site where
every navigation is a `$page`, "viewed the home page, then came back and
registered" is one event name and two different conditions:

```json
{ "start_event": "$page",
  "start_where":  [{ "source": "attribute", "attribute": "path", "operator": "=", "value": "/" }],
  "return_event": "$page",
  "return_where": [{ "source": "attribute", "attribute": "path", "operator": "=", "value": "/register" }],
  "granularity": "week", "periods": 8 }
```

Predicates on one side are ANDed together, and the two sides never see each
other's. They are the same shape a funnel step's `where` takes, including the
text, presence, boolean and relative-date operators — so a predicate is
written identically in all three places.

**A person belongs to the cohort of their FIRST start event inside the range**
— not their first ever, which would make the range decorative — and to exactly
one cohort per run. Doing the start event again later does not move them or
count them twice.

**`since`/`until` bound entry, not observation.** Measuring period 8 of the
last cohort needs events from eight periods after `until`, and the scan runs
on to fetch them. This is the same entry/observation split funnels make.

Cohorts are **calendar**-anchored, so a row is "the week of 3 June" rather
than "day 0–6 since signup". One consequence is worth knowing: somebody who
starts on a Sunday gets a one-day period 0. Rolling-from-signup retention is a
different report and is not this one.

### Limits, and what this does not do yet

A range wider than **60 cohorts** is refused rather than truncated — a grid
silently missing its oldest rows is a chart with a trend that is not in the
data. `periods` is capped at 26.

There is **no breakdown** — you cannot split a grid by campaign or country —
and **no saved retention reports**: a grid is two event names, a granularity
and a range, so the Web UI keeps it in the URL and the screen is shareable as
a link. Nothing is cached; every run is a real scan.

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
never silently clamped. A malformed, truncated, or hand-built `after` is a
`400`:

```json
{ "error": "invalid_cursor" }
```

`person` follows the same device-window ceiling `GET /v1/persons/:id` does
(see *Identity resolution* above): a person spanning more than 200 device
windows is `400 person_history_too_fragmented` rather than an unbounded
query, with the same shape that read already documents.

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
| `event` | one event name, at most 128 characters |
| `group_by` | only `event_name` is accepted |

`event` narrows the aggregate to a single event name, exactly as it does on
`GET /v1/events`, and works with or without `group_by`. It is applied before
the counts are grouped, so it narrows the scan rather than the result.

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


## Operations

### Serving over HTTPS

Lyraflow speaks plain HTTP and has no TLS of its own. For a local trial that
is fine. For anything else it is not, and not for the reason you would
expect first:

- **The snippet will not load.** It arrives as a `<script src>`. On a page
  served over `https://`, a script tag pointing at `http://` is active mixed
  content, which browsers block outright with no warning and no override.
  Nothing is collected and nothing says why.
- **Your server key crosses the internet in clear.** The write key is public
  by design. The server key — which reads, exports and deletes people — is
  on every read call you make.

So give the installer a hostname that already resolves to the server:

```sh
./install.sh analytics.example.com
```

A fourth container joins the stack. It takes ports 80 and 443, obtains a
certificate from Let's Encrypt on its own, renews it on its own, and forwards
to Lyraflow — which stops being reachable from anywhere but the machine
itself. Nothing else about the install changes, and every example in this
document works against `https://analytics.example.com` in place of
`http://localhost:3000`.

`lyraflow snippet` picks this up automatically: with a hostname configured
this way, `-e LYRAFLOW_HOST=...` can be dropped from the `docker compose exec`
call in [*Put the snippet on your website*](#2-put-the-snippet-on-your-website)
— the command defaults to `https://` plus the domain you gave the installer,
so the one place a wrong scheme silently produces a broken (mixed-content)
snippet no longer needs typing out by hand. Every other command still needs
`--host`/`LYRAFLOW_HOST` set explicitly (see [`packages/cli/README.md`](packages/cli/README.md)).

Leaving the hostname out keeps today's behaviour exactly: three containers,
port 3000, no certificate. That is the right choice if you already run a
reverse proxy — put it in front of port 3000 as you would anything else.

The certificate and the account key live in a Docker volume, so restarts and
upgrades keep them. `docker compose down -v` throws them away along with your
data, and the next start asks for a new certificate — worth knowing before you
reach for `-v` repeatedly, because certificate authorities rate-limit
re-issuing for the same name.

Re-running `./install.sh analytics.example.com` on an install that already
serves that name is fine — it picks up a new image and restarts the stack. It
will not change a domain that is already in `.env`; nothing in the installer
rewrites a value that file already holds.

To go back to a local install, remove **all three** of the settings the
installer added — `LYRAFLOW_DOMAIN`, `COMPOSE_PROFILES` and `LYRAFLOW_PUBLISH`
— leaving the passwords alone, since they are the only copy. Then:

```sh
docker compose --profile tls down
docker compose up -d
```

You are left with the three containers and port 3000 again, and your data
where it was.

Both halves matter, in ways that are easy to get wrong:

- **Remove all three settings, not just the domain.** With
  `COMPOSE_PROFILES=tls` still in `.env`, Caddy is still started — now with no
  domain to serve, so it fails to parse its configuration and restarts
  forever. And with `LYRAFLOW_PUBLISH` still there, the app stays bound to
  loopback, which is not reachable once Caddy is gone.
- **`--profile tls` on the `down`, and no `-v`.** Removing the settings makes
  Compose stop listing the `caddy` service at all, so a plain
  `docker compose down` — even with `--remove-orphans` — walks straight past
  the running container and leaves it holding 80 and 443. Naming the profile
  is what brings it back into view long enough to remove it. `-v` would take
  your database volumes with it.

#### Behind Cloudflare, or any other proxy

If the record is proxied — Cloudflare's orange cloud, or an equivalent — the
automatic certificate may not issue, and whether it does depends on settings
that Lyraflow cannot see. The challenge is an ordinary HTTP request, so a
proxy that passes port 80 through to your server will let it through; one set
to redirect that traffic, or to refuse unencrypted connections to the origin,
will not. The failure is quiet either way — the site simply never starts
serving, and nothing says why.

The dependable answer is not to rely on that question having a good answer.
Give Caddy a certificate directly, and issuance stops involving the proxy at
all. For Cloudflare that means an Origin CA certificate: create one in the
dashboard, save the pair on the server, and add a file to `docker/caddy/tls.d/`:

```
tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key
```

Mount the directory holding them into the `caddy` service, and set
Cloudflare's SSL/TLS mode to **Full (strict)**.

You can instead grey-cloud the record until the automatic certificate issues
and turn the proxy back on. That works, but it is not finished: renewal
happens on its own schedule months later and meets whatever conditions exist
then. A certificate that issued once behind a grey cloud is not evidence the
next one will.

One thing worth being explicit about, because the setting sounds like it
solves the problem and does not: Cloudflare's **Full** mode does not remove
the need for a certificate here. It still requires your server to speak HTTPS
— it only stops checking which certificate you present. The mode that needs
no certificate at all is **Flexible**, and it leaves the leg between
Cloudflare and your server unencrypted, carrying your server key and your
event data. Your visitors would see a padlock that stops being true partway.

### Admin login

One admin account, a session-cookie login (`POST /v1/auth/login`), and the
project-scoped routes it protects — including the [Web UI](#web-ui)'s own
sign-in form, which calls this same endpoint. It matters to what you expose
even if you never open the UI, so it is documented here rather than only in
the section about the screen that uses it.

`./install.sh` generates the admin account the same way it generates the
database passwords: a random one, written into `.env`, and **printed once at
the end of a successful install** — the only time you will see it. Losing it
after that is not a special case; it is the same situation as forgetting any
other password, and the fix is the same one:

```sh
read -rsp 'password: ' P; echo
printf '%s' "$P" | docker compose exec -T lyraflow \
  node packages/cli/dist/index.js set-admin-password admin@localhost
unset P
```

`set-admin-password` takes the password on stdin, never as an argument — an
argument lands in shell history and in `ps` output for every user on the
box. `read -rs` is there for the same reason and is not merely tidier: an
`echo 'a new password' | ...` keeps the argument off `ps` but writes the
credential straight into your shell history, which is most of the problem
back again.

`-T` matters too. `docker compose exec` allocates a TTY by default and then
ignores piped stdin, so without it the password never arrives and the failure
is silent.

**If you are upgrading an install that predates the admin account,** its
`.env` has no `LYRAFLOW_ADMIN_PASSWORD` — the installer only ever writes it
into a brand-new `.env`, and an upgrade keeps the `.env` you already have.
The app still boots; it logs a warning at startup and there is nothing to
sign in with until you run the command above, once.

**Stated plainly, because it is a real trade and not an oversight:** the
admin login is served on the exact same public origin as ingest. There is no
separate port, no separate host, and no network boundary between them — an
install reachable from the internet for `/v1/track` is reachable from the
internet for `/v1/auth/login` too, protected by the password above and
nothing else. That is the price of an install this simple. At minimum, put
it behind [HTTPS](#serving-over-https), and treat the admin password with
the same care as the server key.

### Retention

A background worker drops events older than each project's own
`retention_months` — **13 months by default for a new project**. That default
lives on the `projects` table and applies only going forward: it changed
where a fresh install starts, not what an existing project is already
configured with, so upgrading never quietly shortens anyone's retention.
Change it after creation with `PATCH /v1/project` (see *The ingest API*
above), which the [Web UI](#web-ui)'s Settings screen also calls — both take
the same range, `1`–`120`, enforced again by the column's own check
constraint so a value the API validated can never fail at the database for a
reason the caller wasn't already told.

**Retention is month-granular, not day-granular — a floor, not an exact
promise.** ClickHouse's `events` and `device_index` tables are both
partitioned `(project_id, month)`, and the worker drops whole partitions, not
individual rows. A project on 13 months therefore holds *between 13 and 14
months* of data depending on where in the current month you ask: the oldest
surviving partition is always at least 13 months old, but it is not dropped
until its entire month has aged past the boundary.

**What survives, and why.** Two tables are deliberately outside retention's
reach:

- `person_traits` — the latest known value for each trait a person has ever
  had (`identify()`'s payload), partitioned by project only, with no time
  dimension to expire against. A person past retention keeps their traits and
  their identity links (`identity_bindings`, in Postgres, is untouched by
  this worker entirely) — but **not retrievably**. `GET /v1/persons/:id` and
  `GET /v1/persons/:id/export` (see *Privacy: deletion and export* above)
  both decide whether a person exists at all from the same query, an event
  count, and answer `404 person_not_found` when it is zero — identically to
  an id that was never recorded. Once retention has dropped every partition
  holding this person's events, that count is zero, so **both routes 404**,
  not a profile with `traits` and no `event` lines. The traits and identity
  links are still there, physically, in `person_traits` and
  `identity_bindings`; nothing in this API can read them back out once every
  event is gone. If you are answering a data-subject access request for
  someone past retention, the honest answer this API can give is "no record
  found" — state that plainly rather than reading the 404 as proof the
  person was never recorded.
- `event_schema` — the distinct event and property names Lyraflow has ever
  seen, used for autocomplete (see *Autocomplete: event and property names*
  under *Segments* above). It is not partitioned by time at all, so an event
  name can keep showing up as a suggestion long after every event that used
  it has aged out and been dropped — autocomplete can offer a name that now
  returns nothing.

**A person past retention also leaves the segment base population.** Every
segment's base population is built from `device_index` (`base.last_seen`, in
particular, is derived from it — see *Segments* above), so once a person's
last remaining `device_index` partition is dropped, they no longer appear in
any segment count or member list — not because they were deleted, but because
the aggregate row retention just removed was the only thing that put them
there.

Two environment variables control the worker, and a third decides whether its
work leaves any record:

| Variable | Default | Meaning |
| --- | --- | --- |
| `LYRAFLOW_RETENTION_INTERVAL_MS` | `3600000` (1 hour) | How often the worker looks for expired partitions to drop. Dropping a partition is a metadata operation, and retention is measured in months, so a missed hour costs nothing. Must be a whole number of milliseconds of at least `1`: `0` and negative values fail to boot rather than being silently clamped by `setInterval` into a sweep that runs continuously. |
| `LYRAFLOW_RETENTION_ENABLED` | `true` | Set to `false` to turn the worker off entirely. Only the lowercase literals `true`/`false` are accepted — `FALSE`, `0`, or any other spelling fails to boot with an error rather than being silently read as `true`, since silently coercing an unrecognised "off" spelling back to "on" would keep deleting data an operator believed they had disabled. |
| `LYRAFLOW_LOG_LEVEL` | `info` | Not a retention setting, but it governs retention's only audit trail. Every partition dropped is written as one `info` line — `retention dropped partition`, naming the project, table and partition month — and once a partition is gone that line is the only record it ever existed. Run the server at `warn` or above and the drops still happen, with nothing but the counter below to say that anything did. |

Both retention variables, like every other setting the server reads, must go
in the `environment:` block of the `lyraflow` service in
`docker-compose.yml` — Compose passes only what that block lists, and a
variable added to `.env` alone is used for substitution inside the compose
file and never reaches the server.

**Disabling it means retention is nobody's job unless you make it
somebody's.** `LYRAFLOW_RETENTION_ENABLED=false` is a legitimate choice for an
operator who prunes ClickHouse some other way, but Lyraflow will not do it for
you, silently or otherwise, once it is off — the server logs a line at
startup saying so, precisely so that choice is visible in the boot log rather
than merely absent. **A disabled worker also reports `0` on both metrics
below, forever** — it never runs, so `lyraflow_retention_last_run_timestamp_seconds`
never leaves `0` and `lyraflow_retention_partitions_dropped_total` never
leaves `0` either. If you disable retention deliberately, disable or exclude
the alert on the first metric too, or it will fire permanently for a state
you chose on purpose.

Two `/metrics` series exist to alert on:

- `lyraflow_retention_last_run_timestamp_seconds` — the Unix timestamp of the
  worker's last completed run; `0` before the first one. **This is the metric
  to alert on, and the thing to watch is it going stale, not its value.** A
  worker that has silently stopped — crashed, wedged, never started — looks
  exactly like one that is healthy and simply has nothing left to expire:
  neither shows up as an error anywhere else. A timestamp that stops moving
  is the only signal that tells the two apart, and by the time it is noticed
  the wrong way, the failure it exists to prevent (partitions never dropped,
  disk quietly filling) has already been arriving, unannounced, since the
  worker stopped. **This timestamp still advances even on a run where every
  single project's drop failed** — the worker moves on to the next project
  and reports each failure through its own error log rather than aborting
  the run, so a completed run (this metric's whole definition) is not the
  same claim as "something was actually dropped". If you need to know that
  drops are succeeding, not merely that the worker is alive, watch the error
  log and the counter below together with this timestamp, not this
  timestamp alone.
- `lyraflow_retention_partitions_dropped_total` — a counter of partitions
  actually dropped since process start. A dry run or a run that found
  nothing expired does not advance it.

**A project deleted from Postgres is never pruned again.** The worker builds
its list of projects to sweep from the Postgres `projects` table, so a
project row that no longer exists takes its ClickHouse data out of
retention's reach entirely: those `events` and `device_index` partitions stay
on disk indefinitely, and neither metric above can report it — the counter
cannot move for a project the worker cannot see. There is no API for deleting
a project today; if you remove a row by hand, drop that project's partitions
in ClickHouse yourself at the same time.

### Quotas

**A quota is off by default, and no project has one until you set it.** The
`projects.monthly_event_quota` column is nullable, `NULL` means unlimited, and
`NULL` is what every project carries — both a new one and every existing one,
which the upgrade rewrote on purpose rather than starting to enforce a limit
nobody had opted into. Set one with `PATCH /v1/project` (see *The ingest API*
above) — the same route the [Web UI](#web-ui)'s Settings screen calls — or
direct SQL if you would rather:

```sql
-- 5,000,000 accepted events per calendar month for one project.
UPDATE projects SET monthly_event_quota = 5000000 WHERE slug = 'acme';

-- Back to unlimited.
UPDATE projects SET monthly_event_quota = NULL WHERE slug = 'acme';
```

The value must be positive (a check constraint enforces it, and the API
rejects `0` and negative values the same way); send `null` over the API or
`NULL` over SQL, never `0`, to mean unlimited. The month is the **UTC
calendar month**, so the budget resets at `00:00 UTC` on the 1st, not on a
rolling 30-day window and not in the server's local timezone.

**Understand what you are turning on before you turn it on.** The write key
ships in your browser bundle and is readable by anyone who visits an
instrumented page. With no quota, the worst that key buys an abuser is your
storage and your bandwidth. With a quota, it also buys them an **off switch
for your own analytics**: valid events count, so a few minutes of scripted
traffic can spend the month's budget, after which your real events are refused
until the 1st — by design, since that is what a quota means. Nothing here
distinguishes a customer's browser from a script; both hold the same key.

So a quota protects a bill, not a service, and it does so by trading
availability for cost. Set one where an unbounded bill is the greater risk —
and size it well above any month you would actually want, since a quota that
is merely generous still ends in a month of silence once it is spent. If you
need protection against abuse rather than against cost, that belongs in front
of the ingest (a rate limit at your proxy or CDN, per IP), which the quota
does not attempt and cannot replace.

**A change takes up to a minute to take effect.** Each server process caches
the project row — quota included — for 60 seconds against the write key it
arrived with, so events can still be refused for about that long after you
raise a limit, and for about that long after you lower one they will still be
accepted. Nothing needs restarting; wait it out.

**Only *accepted* events count toward a quota.** Malformed events, events
refused by the cardinality limits, bot traffic, and events dropped when the
buffer saturates all leave it untouched. That is deliberate and it is a
security property, not a convenience: if rejected traffic consumed the budget,
anyone holding the write key — which ships in the browser bundle — could
exhaust a project's month with payloads that are never stored as events, and
silence its real analytics until the 1st.

Malformed events are not free of *storage*, though: each one writes a row to
`events_dead_letter`, kept for 30 days by that table's own TTL and bounded by
nothing else. The row's detail and payload are capped at 1000 and 8000
**characters**, which is not the same as bytes — a payload of non-Latin text
weighs about three times its character count in UTF-8, so budget for roughly
24 KB per row rather than 9 KB. A flood of nonsense therefore costs disk
whatever the quota says. What it cannot do is consume the budget.

**Enforcement is a bound with known slack, not an exact cliff.** Each server
process keeps its recent counts in memory, folds them into Postgres every 10
seconds, and caches the persisted total for 5 seconds, so the figure the check
acts on can trail reality by roughly those two intervals of that project's own
traffic — about 15 seconds' worth. A project can therefore overshoot its quota
before refusals begin: against a quota of 10, 15 events being accepted is
normal and expected, not a bug. Neither interval is configurable. Running
several server processes widens the same window by roughly a factor of the
process count, because each holds its own pending tally and its own cache.
Set a quota you can afford to exceed by a few seconds of peak traffic.

The slack is bounded by that project's own **rate** over those seconds, and
not by how many requests arrive at once: a burst of simultaneous requests is
decided one at a time, each seeing the one before it. So the number to plan
against is a project's peak events per second, not its peak concurrency.

Once a project is over, `/v1/track`, `/v1/identify` and `/v1/page` answer
`429 {"error":"quota_exceeded"}` with no `retry-after`, and `/v1/batch` answers
`202` with the refused events counted in `over_quota` (see *Responses*).

**The browser SDK learns about the quota from the `202` body, never from a
status code.** It posts only to `/v1/batch`, so the `429` above is not a
response it can receive at all. When a batch comes back with `over_quota`
above zero, the SDK drops those events — a quota refusal does not clear on its
own, so holding them would only wedge the queue behind events the server will
refuse all month — and warns on the console naming the quota, which is the
only signal a developer gets. A `429` reaching the SDK from anywhere else is
treated as an ordinary rate limit: the batch is kept and retried with backoff.

**A refusal is recorded in two places, and they answer different questions.**
`lyraflow_ingest_events_total{outcome="over_quota"}` on `/metrics` counts
individual events refused **since process start**, across every project — it
carries no project label and it resets on restart, so it tells you that
refusals are happening, not who they belong to. That makes it the thing to
alert on. The durable record is `ingest_counters.events_over_quota` in
Postgres, one row per project per month, which each server process folds its
tally into every 10 seconds; query that to find out which project ran out and
by how much. Neither is `events_dead_letter`: over-quota events are
deliberately kept out of it, because that table records data that could not be
parsed, and filling it with valid events refused by policy would bury the
bad-data signal it exists to carry.

**To be warned *before* the cliff, alert on
`lyraflow_ingest_quota_used_ratio`.** It is a gauge, labelled by
`project_id`, carrying this month's accepted events as a fraction of that
project's quota:

```
lyraflow_ingest_quota_used_ratio{project_id="7"} 0.83
```

The threshold is yours to pick — 0.8, 0.95, both — which is why this is a
ratio rather than a built-in warning level. The counter above tells you that
events have **already been lost**; this one tells you they are about to be.

Three things about it are worth knowing rather than discovering:

- **Only projects that have a quota appear.** `null` is unlimited and is the
  default, and a ratio against unlimited is not a number. A deployment that
  has never set a quota emits the `HELP` and `TYPE` lines and no series, and
  pays nothing for them.
- **A project appears only once it has sent an event this month**, because
  the figure comes from the ingest path's own cache rather than from a query
  — a scrape costs no database read, on an endpoint that is unauthenticated
  and scraped on a schedule the server does not control. A project that has
  gone quiet has no series until it sends again.
- **It can exceed 1.0.** A batch is admitted or refused as a whole, so a
  project can finish one slightly past its limit. That is not clamped, because
  crossing the line is the transition worth being able to see afterwards.

For the month's durable totals, read `ingest_counters`; for one project's
current consumption on demand, `lyraflow usage` or `GET /v1/project/usage`.

**If Postgres is unreachable, the quota is not enforced from persisted state.**
The usage read falls back to the last known figure for the current month, or
to zero, leaving only the process's own in-memory tally counting against the
limit — a database blip must not turn into a project-wide refusal of events
that were well inside their budget. The server logs `quota usage read failed`
once per project per cache TTL while that lasts, which is the only signal that
enforcement has degraded.

### Backup and restore

Two scripts sit beside `install.sh`. `backup.sh` is the one you schedule;
`restore.sh` is the one you run once, under pressure, and it is the only thing
in this repository that deletes any of your data.

#### Taking a backup

```sh
./backup.sh /var/backups/lyraflow
```

It stops **only** the app container, waits for its grace period so the ingest
buffer drains, backs up ClickHouse and Postgres with nothing writing, restarts
the app, and writes:

```
/var/backups/lyraflow/2026-08-10T041500Z/
    clickhouse.zip     the ClickHouse database
    postgres.dump      pg_dump custom format
    MANIFEST           versions, per-table row counts, SHA-256 of each file
```

**Ingest is refused while it runs, and so are queries.** Events are delayed
rather than lost: the browser SDK queues in `localStorage` and retries. What
you get for that pause is a guarantee that fits in one sentence — *the backup
is a point-in-time image of both stores with no writes in flight.*

How long that pause is depends on how much data you hold. On a small
deployment it is **about eight seconds** (8.3s, 8.6s and 8.3s on three
consecutive runs of the stack this repository ships); most of it is the app's
shutdown drain rather than the copying, so it grows with your data but not
from a standing start. Measure your own before you decide what time of night
to run it.

A nightly cron entry:

```
17 4 * * *  cd /srv/lyraflow && ./backup.sh /var/backups/lyraflow >>/var/log/lyraflow-backup.log 2>&1 || docker compose ps
```

The trailing `|| docker compose ps` is not decoration. `backup.sh` restarts the
app from an exit trap on every path it can control, but a `SIGKILL` — an OOM
kill, a `docker kill`, a hard `systemctl stop` — runs no trap at all and leaves
the app stopped. The `ps` puts the state in your log where you will see it.

If you pipe the script anywhere, test `PIPESTATUS`, not `$?`.

**Rotation, off-site copies and encryption are yours to choose.** `find -mtime`,
`restic` and `rclone` all do these better than we would, and Lyraflow
deliberately does none of them.

#### The backup file is a credential

Beyond your personal data and your projects' **write keys in plaintext**, the
archive contains your **Postgres password**. Lyraflow's identity dictionaries
live inside the ClickHouse database, and their definitions embed the credential
they use to read Postgres — so three files inside `clickhouse.zip` carry it.

`backup.sh` writes everything `0600` inside a `0700` directory. Treat a backup
directory exactly as you would treat the database itself, and think about that
before you sync it to a bucket.

**What a restore cannot give you back is a server key.** Only its hash is
stored, by design. If you have lost yours, no backup recovers it and the remedy
is a new project.

#### Restoring

```sh
./restore.sh /var/backups/lyraflow/2026-08-10T041500Z
```

You will be asked to type the backup's timestamp. There is no `--force`.

Three things are checked **before anything is destroyed**: the artefacts match
their checksums, the backup is not newer than the image you are running, and
you confirmed. Any of them refusing leaves your running system untouched — not
even stopped.

Then the ClickHouse database is dropped and refilled, and the Postgres `public`
schema is dropped and refilled. **Everything written since the backup is gone.**

**Both stores are always restored together, and there is no flag to do one.**
`suppressed_persons` — the record that a person exercised their right to
erasure — lives in Postgres, while the events it hides live in ClickHouse. A
Postgres older than its ClickHouse partner brings deleted people back into
every query. ClickHouse is restored first so that an interrupted restore fails
on the safe side.

**If a restore is interrupted part-way, the app is deliberately left stopped.**
The script tells you which store is in which state and asks you to run it again
with the same backup, which is safe and idempotent. It does not restart the app
for you, because a Lyraflow serving a half-restored database can be answering
queries with no suppression rows at all — a down site is loud, and that is not.

Two smaller things worth knowing. Restoring a backup older than a project's
`retention_months` brings back events the policy has already expired; the next
retention sweep drops them again, harmlessly. And `restore.sh` drops and
recreates the `public` schema, which assumes the role Lyraflow connects with
owns it — true of the stack this repository ships, and not necessarily true of
a managed Postgres or a deployment where the application role is deliberately
not an owner. The restore now checks this **before** it destroys anything and
refuses with an explanation if the role cannot drop the schema, rather than
failing partway through. To check for yourself:

```sql
SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'public';
```


### Behind a CDN: recording the visitor's IP

Caddy will not read a forwarded header from a peer it has not been told to
trust, and that refusal is the right default — any client can send
`X-Forwarded-For`, so believing it unconditionally would let a visitor choose
their own apparent address.

So behind Cloudflare or any other intermediary, the address Lyraflow sees is
the intermediary's. Name the ranges you actually sit behind by dropping a file
into `docker/caddy/proxy.d/`:

```
trusted_proxies static 173.245.48.0/20 103.21.244.0/22
```

Those directives land inside the `reverse_proxy` block, which is why they go in
`proxy.d/` rather than `tls.d/` — `trusted_proxies` is a sub-directive of the
proxy, not of the site.

The ranges are your CDN's published egress list and they change; Cloudflare
publishes theirs at <https://www.cloudflare.com/ips/>. A stale list fails
quietly rather than loudly: an unlisted range is simply untrusted, and visitors
arriving through it record the CDN's address instead of their own.

**Do not use `0.0.0.0/0`.** Trusting everyone is the same as having no check at
all — it lets any client claim any IP by setting a header.

This has no visible effect today: GeoIP returns an empty country, region and
city for every event, so nothing currently reads the client address. It matters
from the moment that changes.

## Upgrading

**Take a backup first.** Migrations run automatically on boot and some of them
cannot be undone, so this is the one step worth never skipping:

```sh
./backup.sh /var/backups/lyraflow
```

Then:

```sh
docker compose pull || docker compose build
docker compose down
docker compose up -d
```

The `|| docker compose build` covers the period before the first image is
published; once it is, the pull succeeds and the build never runs.

The restart itself loses nothing. Accepted events are flushed before shutdown,
migrations run on boot, and the ClickHouse identity dictionaries are rebuilt
from Postgres every time rather than migrated, so they are never left stale.

**If the new version will not start**, check the logs for a schema-version
error. Downgrading the image below the schema in your database is refused
deliberately — the remedy is to put the newer image back, or restore the backup
you took above.

### Upgrading to the release that added retention

Retention prunes old events, and the first version to enforce it acts on
whatever `retention_months` each project already had. That column has existed
since the first migration and nothing ever applied it, so the value being
enforced may be one nobody has looked at in a long time. Check before you
upgrade:

```sh
docker compose exec postgres psql -U lyraflow -d lyraflow \
  -c 'SELECT id, slug, retention_months FROM projects ORDER BY id'
```

Upgrading changes none of those values — the 13-month default applies only to
projects created afterwards. If you would rather it did not start yet, add

```yaml
      LYRAFLOW_RETENTION_ENABLED: "false"
```

to the `environment:` block of the `lyraflow` service in `docker-compose.yml`,
before starting the new version. It has to go there and not in `.env`: Compose
uses `.env` for substitution inside the compose file and passes the server only
the variables that block names, so retention would run anyway. Nothing is
dropped for age until you turn it back on.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We'd love your help once the foundation is in place.
