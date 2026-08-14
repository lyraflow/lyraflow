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
