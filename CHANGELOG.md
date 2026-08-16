# Changelog

Lyraflow is versioned as one product: every package in the monorepo carries the
same version, and a release tags the whole repo.

**0.1.0 was never tagged.** The project ran unversioned through its first
milestone, so this file starts at 0.2.0 rather than inventing a history it does
not have. `0.1.0` in the manifests before this release meant "pre-release", not a
release anyone could name.

There is no published container image yet. `docker-compose.yml` names
`ghcr.io/lyraflow/lyraflow:0`, and `install.sh` runs `docker compose pull ||
docker compose build`, so today every install builds from its own checkout. A
release is therefore a git tag and the source at that tag — upgrading means
pulling the tag and rebuilding, not pulling an image.

**0.2.1 was never tagged either.** Its version bump and changelog entry shipped
in the repository, but no `v0.2.1` tag was ever created — so the release below
exists in the manifests and in this file and nowhere in `git tag`. It is recorded
here as it happened rather than tagged retroactively, for the same reason 0.1.0
is: a tag created after the fact names a moment nobody could have fetched. Its
one fix is contained in 0.3.0.

## Unreleased

### Changed

- **`@lyraflow/sdk-browser`'s `autoPageView` now defaults to `true`.** A
  pasted install snippet with nothing else written now sends one page view on
  load, instead of recording nothing until the site calls `lyraflow.page()`
  itself. Opting out is `autoPageView: false`. A site that already calls
  `lyraflow.page()` on its own will now send two page views per hard load —
  remove that call, or set `autoPageView: false`, whichever is less work. The
  automatic call still fires only once per hard load and never on a
  client-side route change; see the README's *Single-page apps* section.

## 0.3.0 — 2026-08-16

Lyraflow gets a web interface. Everything before this release was reachable only
over HTTP or through the CLI.

**Schema version 13** (`013_admin_sessions.sql`, additive). Upgrading runs one
migration and needs no downtime.

### Added

**An admin interface at `/`, served by the same process on the same port.** One
container, one port, one certificate; the installer is unchanged. Four screens:

- **Login**, backed by a session cookie that is a second credential inside the
  existing authenticator rather than a parallel auth system. Sessions are hashed
  at rest, slide on use, and expire absolutely at 90 days.
- **First-run wizard** — create a project, copy the snippet, watch the first
  event arrive. It hands over the server key, which exists nowhere else: only its
  SHA-256 is stored, so leaving that screen without copying it means creating
  another project.
- **Live feed** — accepted events and rejections in two tabs, with the reason
  each rejection was dropped. That reason was previously visible only by reading
  server logs.
- **Settings** — the install snippet, this month's usage against quota, editable
  retention and quota, and the project list. These were reachable only by raw SQL.
- **Funnels** — create a funnel from an ordered list of events, run it over a
  range, and read one row per step: how many reached it, what share of entrants
  that is, and how many dropped since the step before.

**Two honesty surfaces on the funnels screen**, because a funnel can return
plausible numbers that answer a different question than the one asked:

- A run over a range shorter than the funnel's own window under-reports
  conversion, because people who entered near the end have not had their full
  window to finish. The screen says so, and says how many.
- If a funnel's segment filter has been deleted, the run succeeds over
  **everyone** rather than failing. The screen reports that and stops presenting
  the filter as applied.

### Fixed

- Renaming a funnel no longer discards its cached run summary. The stored
  definition is compared against the incoming one, so only a real change resets
  it (#92)
- The funnel detail screen shows a segment filter by name rather than by id (#94)
- The feed no longer claims "no events yet" and "showing the last data received"
  at the same time — states that cleared the rows and then asserted things no
  poll had established. Its tab badges now distinguish a confirmed zero from an
  unconfirmed one (#82)
- `parseSegmentId` accepted an unbounded id, so an oversized value reached
  Postgres as a bigint bind and returned `503` — an input error wearing an
  outage's clothes, on four segment routes. Every route id now shares one shape
  check (#78)

### Known limitations, stated rather than implied

**Segments, people and person profiles have no screens.** Reach them over the
HTTP API or the CLI, as before.

**The CLI remains strictly more capable for funnels.** A funnel step can carry
conditions on that event's own properties; the builder does not author those, and
a funnel that has them opens read-only rather than silently dropping them on
save. The per-step list of *which* people dropped is API- and CLI-only, since
there is no person profile to open one from.

**A pasted snippet still records nothing until the site calls `lyraflow.page()`**
([#52](https://github.com/lyraflow/lyraflow/issues/52)). This is the next thing
being fixed, and it undercuts the wizard: an install that is correct and one that
is waiting for more code look identical.

## 0.2.1 — 2026-08-14

### Fixed

**The versioned browser-bundle path was documented as something it is not.** Both
the README and the route's own docstring described `/lyraflow-<version>.js` as
serving "this exact version, forever". It does not: a server only registers that
path for the version it is running, so upgrading makes the previous one `404` —
and the README's example was `/lyraflow-0.1.0.js`, which 0.2.0 turned into a dead
link inside the documentation recommending it.

The guarantee that is true, and what justifies a year of `immutable`, is that
*these exact bytes never change*. The path is cache-busting, not pinning, and a
`<script>` tag must use the bare `/lyraflow.js`. A site that pinned the versioned
path would keep working from cache while every new visitor silently collected
nothing.

The `404` behaviour is unchanged and deliberate — serving the current bundle
under another version's URL is what the single literal route exists to prevent —
but it now names the version the server does serve and what to use instead,
carries `no-store` so it cannot outlive the upgrade that fixes it, and does not
echo the caller-supplied version back into the body.

No change to the bundle itself, to ingest, or to any query path. (#74, #75)

## 0.2.0 — 2026-08-14

### Added

**Funnels.** Ordered conversion over the events already stored: how many people
got through each step of a journey, and where the rest stopped.

- A funnel is a saved, named object — `POST /v1/funnels`, `GET /v1/funnels`,
  `GET`/`PATCH`/`DELETE /v1/funnels/:id` — re-run over whatever range you ask
  for, with the range supplied per run rather than stored.
- `POST /v1/funnels/:id/run` and `POST /v1/funnels/preview` return per-step
  person counts with both step-to-step and from-start conversion rates.
- `POST /v1/funnels/:id/dropoff` lists the people who reached a given step and
  went no further, keyset-paged behind a signed cursor.
- A step is one event, optionally constrained by predicates on that event's own
  properties, using the same `{ property, operator, value }` shape a segment
  behaviour already uses.
- A funnel's population can be restricted to a saved segment.
- `lyraflow funnels list | run <name> | preview --file | dropoff <name> --step N`,
  addressed by name, with `--json` keeping stdout a pure record stream and
  warnings on stderr.

Semantics worth knowing before reading a number, all documented in the README:

- Steps must occur in order; unrelated events in between do not break the chain.
- A person is counted once, at the furthest step they reached, and the window
  slides to find their **best attempt** — abandoning on Monday and completing on
  Tuesday counts as converted.
- The **range bounds entry, not observation**: someone entering an hour before
  the range ends still gets their full window to finish, so the query reads on
  past `until`.
- Anyone who entered too recently to have had their whole window is counted in
  `entered` and reported separately as `partial_window_entrants`, with a warning
  naming the number. They can still convert.
- Deleted people are excluded, and duplicate deliveries counted once, through the
  same derivations every other read path uses.

Caps: 8 steps, a 30-day conversion window, a 90-day range, and a drop-off page
bounded like the segment members preview. All are checked when a funnel is
created, not on first run.

### Changed

- **Schema version 12.** Migration `012_funnels.sql` adds the `funnels` table. It
  is additive: no existing table is altered and no data is rewritten. Upgrading
  applies it automatically at app start.
- `compileSegment` gained a person-set output mode, so another engine can embed a
  segment's population as a subquery rather than reassembling equivalent SQL.
- The signed keyset cursor used by the segment members walk moved to a shared
  module and is now used by the funnel drop-off as well, under its own label so
  a cursor minted for one cannot be replayed against the other.

### Not in this release

No time-to-convert per step, no breakdown by dimension, no strict-order mode, and
no retention grids or trends — see issues #69, #70, #71 and #72. Funnel results
are computed on demand every time, with nothing cached or precomputed.
