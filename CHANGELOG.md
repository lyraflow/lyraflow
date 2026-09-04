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

### Added

- **Accent palettes.** The Profile screen has an Appearance card with seven
  accents: copper, the default, and cobalt, moss, plum, slate, wine and amber.
  Each is the copper ramp with its hue swapped and its lightness held, measured
  for contrast in both modes (`brand/contrast-report.txt`). The choice is kept
  in the browser and changes the accent only. A stored theme or palette is now
  applied before first paint, so an explicit dark choice no longer flashes light
  on load.
- **`brand/tokens.css` is generated.** The copper ramp's tokens are now named
  `--lf-accent-*`; the `--lf-copper-*` names are gone. Anything outside this
  repo that read them by name needs the rename.

### Fixed

- **A saved report could be added to a dashboard more than once** (**#246**). Nothing
  refused the second tile: the layout schema checked the count and the
  shape of each tile, not that a report appeared once, and the edit
  screen's picker listed every saved report whether or not it was already
  on the dashboard. Now the server refuses a layout naming the same report
  twice with the field-level `400` the other layout rules use, `tiles.<i>`
  pointing at the second copy — keyed by kind *and* id, since a trend and
  a funnel can share an id. The picker still lists a report that is
  already on the dashboard, disabled and saying so, for the reason it
  lists a stale one: a row that disappears from the menu reads as "you
  have no such report". When every saved report is on the dashboard it
  says that instead of offering a menu of nothing.

## 0.13.0 — 2026-09-04

### Added

- **Dashboards** (**#241**): a named, ordered grid of tiles, each one a
  saved trend, a saved retention report or a funnel, half or full width,
  with one range picker for the whole page. `/dashboards` lists them,
  `/dashboards/new` takes a name and nothing else, and `/dashboards/:id`
  is one screen with a view mode and an edit mode. **A star marks one
  dashboard per project as home**, and `/`, the sidebar's Dashboards
  entry and the Lyraflow mark all open it — the feed when nothing is
  starred. Opening a tile opens its report over the dashboard's range; a
  funnel takes that range when it is one the funnels screen itself
  offers.

  **The range lives in the URL and is never stored.** A dashboard holds
  the questions, not the window they were asked over — the same decision
  a saved trend and a saved retention report already carry, and the
  reason a dashboard link reproduces the sender's view. Under the default
  `auto` range the tiles do not share a window at all: each report keeps
  its own screen's default, and the screen says so in a line under the
  picker rather than letting "one range for every tile" stand as a claim
  the default breaks.

  **A tile whose report was deleted stays on the layout and says so.**
  There is no foreign key from a tile to its report, for the reason a
  segment reference carries none: `CASCADE` would reshape a dashboard as
  a side effect of deleting a report, and `SET NULL` cannot apply to an
  element of a JSON array. So the read path looks each report up and the
  tile reports its own absence, rather than the layout changing under
  someone who did not edit it.

  Three limits, all stated on screen rather than discovered: **at most
  twelve tiles**, enforced as a CHECK as well as in validation; **at most
  three runs in flight per dashboard**, through a small FIFO queue,
  because twelve concurrent retention queries against a small ClickHouse
  is the shape that has killed a test stack before; and **a tile whose
  stored definition would exceed a server ceiling under the current range
  warns instead of running** — the same ceiling that report's own screen
  refuses to send past, so the 6- and 12-month presets say which limit
  they hit rather than collecting a 400.

  Five routes — `GET`/`POST /v1/dashboards` and
  `GET`/`PATCH`/`DELETE /v1/dashboards/:id` — behind the same
  session-or-server-key authenticator, and the same error shapes, that
  trends and retention already use. **The detail read resolves every tile
  server-side** and embeds the report in its own wire shape, or
  `report: null` once it has been deleted, so the client makes only the
  run call per tile. A write refuses a tile naming a report that does not
  exist in this project. There is no run endpoint: a tile runs by the
  call its report's own screen already makes. Migration
  `023_dashboards.sql` adds one table (`SCHEMA_VERSION` 22 → 23) and is
  additive.

- **A write key can be rotated** (**#34**). A write key is public by
  construction — it ships inside every instrumented page and is readable
  in devtools — so it will eventually be pasted into a repository, a
  screenshot or a CI log, and until now the only remedy was a new project
  and the loss of its history. `POST /v1/project/rotate-write-key`
  replaces it and returns the new one, with an optional `grace_hours`
  from `0` to `720` (default `24`) during which the key being replaced
  keeps working, so pages still serving the old snippet keep collecting
  while their caches turn over. `0` is a hard swap, and there is only
  ever one previous key: rotating again inside the grace retires the
  older one immediately. `lyraflow snippet --rotate` rotates and then
  prints the snippet carrying the new key, and the Settings screen's
  install card does the same from the UI.

  **A retired key can be accepted for up to a minute past its expiry**,
  by a server that looked it up just before — Lyraflow caches each key's
  project for that long. It is written down rather than engineered away:
  it is the same window `lyraflow projects delete` already waits out.
  After the grace, a page carrying the old key gets `401
  invalid_write_key` and the browser SDK stops for the life of that page,
  which is that SDK's own rule for `401` rather than a choice made here.
  The **server** key is not rotatable: it is hashed at rest, and that
  remains a new project. Migration `022_write_key_rotation.sql` adds two
  nullable columns to `projects` (`SCHEMA_VERSION` 21 → 22).

- **`reset-admin-login`**, an alias for `set-admin-password` whose name
  says what the command does. It has always replaced *both* the admin's
  email and their password, and revoked every session while doing it —
  but the old name says "password", so an operator who has forgotten
  which address they signed up under would read that section and conclude
  the command could not help them. It could. `set-admin-password` stays,
  because the first-run screen and older docs print it, and `--json`
  output still reports `command: "set-admin-password"` under either
  spelling.

- **A person's rejected payloads travel with their privacy export**
  (**#77**), as a fourth NDJSON line type between the events and the
  terminator: `{"type":"rejection","received_at","reason","detail",
  "payload","match"}`, with the terminator now
  `{"type":"end","events":N,"rejections":M}`. A rejected payload has no
  identity — it is the raw text that failed to parse — and the purge has
  found a person's rejections by searching that text for their ids in
  quoted form since it was written, while the export never read the table
  at all. So a subject-access response said "everything Lyraflow has
  recorded about one person" while payloads naming them sat in
  `events_dead_letter` for up to 30 days.

  **The match is now one predicate in one module, used by both paths**,
  with a test that fails if the literal reappears anywhere else, so
  deletion and export cannot drift into different ideas of whose data
  this is. It is a heuristic over unparsed text, so an export can include
  a payload mentioning this person's id inside someone else's data; every
  rejection line carries `match: "quoted-id-substring"` so a reader can
  weigh it. Including them was the choice because the purge already
  erases them — an export answering "nothing else" while the purge would
  delete more is the worse of the two failures.

### Changed

- **Schema version 23**, over two additive migrations:
  `022_write_key_rotation.sql` and `023_dashboards.sql`. No existing row
  loses data, and both apply automatically at app start.

- **Ingest escapes control characters in event names and property keys**
  (**#35**). Both were validated for length and nothing else, and the
  write key is public, so a visitor to an instrumented site could choose
  those bytes — "a stranger picked this identifier" was the ordinary case
  rather than the exotic one. Newline, CR, NUL, DEL and a C1 CSI were all
  accepted, and #33 fixed the same exposure at the CLI alone: its own
  review showed a forged event name rewriting the install snippet's
  bundle URL in the operator's terminal and erasing its own table row, at
  exit code 0. Escaping at write time is one decision instead of sixteen
  — seven server modules and nine UI components read `event_name` back
  out today, and every future export or integration inherits the same
  exposure.

  `\xNN` rather than a dropped byte: it is inert, since every character
  of the replacement is printable ASCII, and it is legible, where
  dropping silently collides `sign`+newline+`up` with `signup`. **Names
  and keys only, never values** — an identifier is chosen by whoever
  instruments the site and no legitimate one contains a control
  character, while a value is customer data where a newline can be
  content. The one real cost is documented: a stored name containing a
  control character no longer matches the bytes that were sent, which is
  what would otherwise confuse someone reconciling against their own
  logs.

- **A stale saved report's badge carries warning weight in the list**
  (**#213**). It was the low-contrast grey this design system uses for
  metadata, sitting next to the "Updated …" timestamp and reading as more
  of the same rather than as a warning that the report cannot be
  reproduced as it was saved. The detail screen states the problem once
  the report is open; the list is where an operator decides which report
  to open, which is the one place understating it costs something. A
  deliberate exception rather than a change to the system, and Funnels is
  untouched: its "Segment filter" badge is genuine metadata, and it
  already expresses staleness as text rather than as a badge.

- **The retention grid says it continues to the right** (**#215**). The
  wrapper has always scrolled rather than taking the page sideways, and
  that part worked; what was missing was any sign of it. At 390px the
  table was cut off mid-column with no fade, no shadow and no scrollbar
  until the reader happened to drag, so a grid that continues looked like
  one that had been truncated — a broken report rather than more data. A
  right-edge gradient now renders only while there is content still to
  the right, measured rather than inferred from the period count, because
  whether it overflows depends on the viewport and not on the data.

- **A stale report's Run instruction no longer points anywhere**
  (**#214**). It read "Run below to see what these controls ask for now",
  and Run is not below it — the button ends the controls and the message
  renders underneath that row, so both screens pointed down at nothing.
  The instruction itself is right and stays: running a stale report is a
  legitimate thing to do, which is why Run remains enabled there while
  Save does not.

### Fixed

- **A stale saved report reached by its own link could be overwritten**
  (**#221**). Both builders block Save when a stored `where` can no
  longer be parsed, so pressing it cannot write the narrowed definition
  over the stored one — but the guard was set while seeding the URL from
  the stored definition, which happens only on the first visit. Seeding
  writes the surviving definition into the URL, so a reload or a second
  opening of that same link arrives with the definition already set, the
  screen treats the URL as the operator's own, and the branch holding the
  guard never ran. The banner still appeared: the screen said the report
  was stale and permitted the overwrite in the same breath, by the path
  an operator is more likely to take. The decision is now computed where
  it belongs — off the fetched report, depending on neither the URL nor
  the on-screen params — so it runs identically on both visits.

- **A long funnel or segment name no longer carries Edit and Delete off
  the screen** (**#218**). Both detail headers are one flex row, and
  neither heading could shrink below its widest child — an
  operator-supplied name, often a single unbroken token. Measured at
  390px: 733px of content in a 390px viewport, with both controls outside
  the visible area, so a funnel with a long name could not be edited or
  deleted from that screen on a phone. #218 named only funnels, because
  that was the screen being rendered when it was found; segments had the
  identical row and the identical defect, and fixing one would have left
  the other broken in exactly the way the issue describes.

- **Project ids that ClickHouse still holds rows for are no longer handed
  out** (**#201**). Postgres owns project ids and ClickHouse holds
  everything keyed by them, and only one of the two is reset by the
  `DROP SCHEMA` three suites run deliberately to prove a migration
  replays from nothing. The drop takes the sequence with it, the next
  project created anywhere in the run is handed an id another suite's
  ClickHouse rows already answer to, and its project-scoped queries
  silently include them — measured, not inferred: the sequence read 34
  before one such file and 2 after it. The sequence is now raised past
  the high-water mark of the five tables that store rows under a project
  id, as a one-way ratchet. **Raising it rather than purging ClickHouse
  is the point:** purging restores the same invariant by deleting rows
  out from under whichever suites are mid-flight, while declining to
  reuse a number cannot damage anyone's data.

- **The trends caption keeps its second sentence while a point is
  hovered**, so the panels below stop jumping. The readout sits in each
  panel's own corner, which means "hover a point to read its value" stays
  true whether or not anything is hovered; dropping it on hover shortened
  the paragraph, shifted every panel below it on a narrow tile, and
  shifted them back on mouse-leave.

### What it still cannot do

Dashboards cannot be shared or made public, do not refresh on their own,
hold only the three saved-report kinds, and have no drag-and-drop and no
CLI commands. A funnel still takes no breakdown and a retention grid no
split. Journeys and path analysis remain ahead. There is no alerting, no
scheduled export and no digest — nothing in Lyraflow sends anything
anywhere, so every report is one someone opened.

## 0.12.0 — 2026-08-29

### Added

- **A person profile screen**, at `/people?id=…` (**#208**): a person's
  stitched identity — canonical id, every id ever bound to it, split into
  user ids and device ids, first seen, last seen, event count — their
  traits, their latest context read from their newest event, and their full
  event timeline, newest first, paged backwards a page at a time and
  anchored to their own last-seen rather than the last 24 hours. Reached
  from a segment member row, a funnel step's people panel, the feed's
  person cell, a sidebar entry, and the two controls on the screen itself:
  a lookup box for an id you already have, and the trait search below for
  when you have none.

  Two privacy actions sit on the profile. Export buffers the subject-access
  response in the browser and triggers a save; past 50,000 events it shows
  the equivalent `lyraflow persons export` command instead of a button that
  would start a download doomed to hang. Delete is the same two-step,
  typed-id-confirm pattern project deletion already uses, then polls to
  completion.

  `GET /v1/persons/:id` gains `traits`, `traits_num`, `trait_total`,
  `devices` and `traits_withheld` to back it — the same trait shape a
  segment member row already carries. **`traits_withheld: true` does not
  mean this person has no traits**: it means a deletion boundary exists for
  them, and a trait carries no timestamp to split at one, so this read
  agrees with the export's own refusal rather than returning empty maps
  that would read as "never had a trait."

  `GET /v1/events` gains `before`, the backwards half of its keyset walk
  and mutually exclusive with `after`, and every response now carries
  `prev_cursor` alongside `next_cursor` — the page's own oldest and newest
  rows, in every response, regardless of which direction produced the page,
  which stays ordered oldest-first either way.

- **Finding someone without an id in hand**, on the same `/people` screen
  (**#208**): one condition on one named trait, built exactly as a
  segment's trait condition is and offering the same five operator
  families — compare, text (contains, starts with, ends with, and their
  negations), presence, true or false, relative date — run through the
  segment engine that already answers one, listing everyone who matches
  with their traits and a link to each profile, paged the way a segment's
  member list is. It suggests trait names from the event schema and only
  scans for a trait's *values* once a value box is focused, so opening the
  screen costs nothing. The condition lives in the URL, so a search that
  matched nobody is still a link that says so after a reload. One
  condition is the shape of the search, not a claim that the matching is
  exact: it will not combine several conditions — that is what a segment
  is for — look for a value across every trait at once, since you name the
  trait, or list everyone without naming a condition at all.

- **Member rows say whether the person was ever identified.** `POST
  /v1/segments/preview`, `POST /v1/segments/:id/preview` and `POST
  /v1/funnels/:id/people` each carry `identified` on every row: `true` when
  at least one of that person's events carried a real `user_id`, `false`
  when their `person_id` is an `anonymous_id` the device fallback produced.
  The two are indistinguishable as strings, and the difference is what
  decides whether there is a profile behind the row — `GET /v1/persons/:id`
  answers `404 person_not_found` for the unidentified one
  ([#18](https://github.com/lyraflow/lyraflow/issues/18)). `POST
  /v1/funnels/:id/dropoff` does not carry it: that route keeps its own row
  shape, retained unchanged for compatibility.

- **A person icon marks the rows that open a profile**, in the feed's
  accepted table and in every member list. Every row still links, because
  hiding the link would contradict the feed the operator just came from;
  the icon says which of those links lands on a profile rather than on the
  page explaining that a "nothing to show" means one of four things.

- **Trends and retention grids can be saved and reopened**, the same way a
  funnel already could. `GET`/`POST /v1/trends` and `GET`/`PATCH`/`DELETE
  /v1/trends/:id` store a name, an event, an interval, a breakdown and a
  filter; the same four verbs on `/v1/retention-reports` store a name, the
  two events, their conditions, a granularity, a period count and an
  optional segment. Neither adds a `/run` endpoint — a saved trend is
  answered by the same `GET /v1/events/stats` call the ad hoc chart already
  used, and a saved retention report by the same `POST
  /v1/reports/retention`, with the stored fields filled in. Both screens
  gain a list view and a Save control, matching Funnels and Segments.

  **A saved trend's filter is a `where` list**, the same predicate grammar a
  segment behaviour, a funnel step and a retention side already use —
  `$page where path = /register` instead of every `$page`. It travels as a
  `where` query parameter on `GET /v1/events/stats` (a JSON array, ANDed,
  capped at 10 predicates, independent of `event`) and is compiled inside
  the same inner scan as the event-name filter, so narrowing it cuts the
  scan rather than throwing rows away after the fact. Migration
  `021_trend_predicates.sql` adds `event_where` and `definition_version` to
  `trend_reports` (`SCHEMA_VERSION` 20 → 21) — the column is `event_where`
  because `where` is a reserved word in Postgres, but the run parameter, the
  request/response bodies and the UI all call it `where`.

  **The range is deliberately not part of what's saved.** A trend or a
  retention report stores the question, not the window it was asked over,
  so reopening one runs it over whatever range the screen currently has,
  never the one it was created with. Reopening a retention report into a
  range and granularity that would together exceed 60 cohorts disables Run
  and computes nothing — the same ceiling and warning an ad hoc grid is
  already held to. A stale report — a saved trend or retention report whose
  stored filters no longer parse — skips its automatic run too, but leaves
  Run enabled, so the operator can still run the degraded version rather
  than being locked out of it. **Save is a different matter.** A saved
  trend whose stored filter could not be fully reproduced on load also
  disables Save, because pressing it would overwrite the stored predicates
  with the narrower (possibly empty) list the screen could actually
  rebuild — the block only lifts once the operator edits the filter
  themselves, which is what turns a subsequent Save into a write they
  actually asked for.

### Changed

- **Schema version 21.** Migration `021_trend_predicates.sql` adds
  `event_where` (JSON, defaulted to `[]` for existing rows) and
  `definition_version` to `trend_reports`. Additive: no existing row loses
  data. Upgrading applies it automatically at app start.

- **`/trends` and `/retention` are now the saved-report lists**; the
  builders moved to `/trends/new` and `/retention/new`. A bookmark or shared
  link built before this task — naming an event, a granularity, a `where`
  clause and so on — still opens the exact chart or grid it used to: it is
  redirected to the `…/new` builder with its search string carried across
  unchanged. A bare `/trends` or `/retention` — no definition in the query
  string — opens the list.

- **The sidebar's active destination now carries a background fill**, not
  only a darker label (**#220**). Every entry is the same weight, so the
  screen you were on differed from the other six by one colour step on one
  axis. The fill is the same one an entry takes on hover, which keeps the
  sidebar to two greys rather than inventing a third — with the consequence,
  stated because it is real, that hovering an inactive entry makes it look
  selected while the pointer is on it.

### Fixed

- **A superseded property lookup no longer answers for the query that
  replaced it** (**#212**). Typing quickly in a segment's property field
  could leave the list showing results for an earlier keystroke: a slower
  request that started first could resolve last and overwrite the newer
  answer. The result is now discarded unless it belongs to the query still
  on screen.

## 0.11.0 — 2026-08-28

### Added

- **A date range on the Trends and Retention screens.** Both held their whole
  definition in the URL and ran on demand, and neither had a range control:
  each fell back to a window the server scales to the resolution. That is a
  good default and a bad only option — a project whose data stopped a week ago
  draws an empty chart with nothing on screen explaining why.

  Presets plus a two-date range, shared by both screens, held in the URL like
  everything else. The default is still "let the server choose", so the tuned
  per-resolution windows stay the default rather than being replaced by a
  fixed span.

  **Each screen refuses a combination the server would refuse, before
  sending it.** 30 days at one-minute resolution is 43,200 buckets against a
  ceiling of 1000; a year of daily cohorts is 365 against a ceiling of 60.
  Both are what somebody builds by accident when span and resolution are two
  independent choices, and being told which limit was hit beats a 400.

- **Trends: an event over time, split by a property or a column** (**#72**,
  the trends half). `GET /v1/events/stats` — the endpoint the Feed's chart
  already used — gains `group_by=attribute:<column>` and
  `group_by=property:<key>` alongside the `event_name` it always took, plus a
  `1w` interval. A **Trends** screen draws it.

  Extended rather than given its own route, so the bucket cap, the `event_id`
  deduplication and the deletion boundary are the ones that route already
  enforced rather than a second set to keep in agreement. `group_by=event_name`
  still returns the `event_name` field the CLI's snippet command reads.

  **Events with no value there are a `(not set)` series, not dropped rows**,
  so a split always adds up to the same total the ungrouped request returns
  and can be checked against the Feed. A property is read from **both**
  property bags, so a numeric property splits by its value instead of
  collapsing into one empty series.

  **At most ten series, with the rest summed into a labelled `(other)` and
  counted** in `folded_series`. Ranked by total over the window rather than by
  any single bucket, so a series does not appear and disappear as the window
  moves. A breakdown past 20,000 bucket/series rows is **refused** with
  `too_many_series` rather than truncated.

  **Weeks start Monday, in UTC** — the same anchoring a retention cohort uses,
  measured against ClickHouse rather than assumed, so a weekly trend and a
  weekly cohort row cannot disagree about where a week begins.

  **Every point carries a dot, and hovering one reads out its bucket and its
  value in every panel at once** — shared rather than per-panel, which is the
  payoff of small multiples: the pointer picks a moment and each series says
  what it was doing then. Dots are drawn as zero-length round-capped strokes
  rather than as `<circle>`s, because the panel scales its width freely and a
  circle under that transform renders as a wide ellipse.

  The screen draws a split as **small multiples on one shared scale** rather
  than overlaid coloured lines. Lyraflow's palette is a single copper ramp,
  built and documented for *ordinal* data like funnel stages; a breakdown's
  values are categorical, so a lightness ramp over them would spend the only
  channel there is on a rank the data does not have. A categorical palette is
  a brand-tooling change with its own contrast script, not something a
  component invents.


- **Retention grids** (**#72**, the retention half of the v0.2 reporting
  line). `POST /v1/reports/retention` and a **Retention** screen: of the
  people who did one thing in a period, how many came back and did another in
  the periods after it. Both events are chosen — `signed_up` then
  `project_created` is the question neither same-event retention nor pure
  acquisition retention can ask — and `*` on either side means "any event", so
  first-seen cohorts and any-activity returns are the same report rather than
  two.

  **An unfinished period is `null`, never `0`.** A cell is only measured once
  its period has closed, and the grid shows a dash with a count of how many
  cells are waiting. A retention grid that reported unfinished periods as zero
  would show a collapse in its newest cohorts, in exactly the corner a reader
  scans for a trend; that is the standard way this chart lies and it is the
  decision the report's honesty rests on.

  Cohorts are calendar-anchored in UTC, weeks start Monday, and a person
  belongs to the cohort of their **first** start event inside the range and to
  exactly one cohort per run. `since`/`until` bound who *enters*; the scan
  runs on past `until` for as long as the last cohort needs to be measured,
  the same entry/observation split funnels make. Person resolution, `event_id`
  deduplication, the deletion boundary and an optional `segment_id` are all
  the ones the funnel engine already uses.

  **"Add predicate" added nothing** in the first build of this, and the
  control was not at fault: the editor adds a blank row, `property` is
  `z.string().min(1)`, and validating each element against the full schema on
  the way back out of the URL threw the new row away before it could render.
  The read is now structural — is this shaped like a predicate the editor can
  render — and finishedness is a separate question the screen reports, because
  a half-built condition must block the run rather than be dropped from it:
  dropping it would quietly measure a wider population than was built.

  **Each side takes a `where` list**, the same grammar a funnel step and a
  segment behaviour use, and the two are independent. Without it the report
  could not ask its most ordinary question: on a site where every navigation
  is a `$page`, "viewed the home page, then came back and registered" is one
  event name and two different conditions, so a grid without predicates
  answered a different question with total confidence.

  **Cell shading is relative to the strongest cell in that grid**, on a
  square-root curve, and the screen says so. Shading against an absolute 100%
  was linear and worked only for grids whose numbers were already large: a
  report narrowed with `where` predicates peaks around 51% with most cells
  under 15%, which rendered as a table with no colour at all. Colours therefore
  compare within one grid and never between two — the percentages, printed in
  every cell, are what compare.

  **No stored retention reports, deliberately.** A grid is two event names, a
  granularity and a range — small enough to live in the URL, which is how the
  screen is shareable as a link without a store, a migration or a second set
  of CRUD routes. No `SCHEMA_VERSION` change.


- **Predicates can ask more than "is it equal to".** Segment conditions and
  funnel-step `where` clauses offered seven operators — equality and ordering
  — on every one of the four condition kinds. Four families join them
  (**#193**): **text** (`contains`, `starts_with`, `ends_with` and their
  negations), **presence** (`is_set` / `is_not_set`), **boolean** (`is_true` /
  `is_false`) and **relative dates** (`in_last` / `not_in_last`, taking
  `{ n, unit }` in the same vocabulary a behaviour's window already uses).
  `url starts_with https://` was the question that could not be written.

  **Which families a condition may use depends on what it compares**, and the
  schema enforces it rather than the editor merely hiding options: a context
  field or an event column takes no `is_true` (never a flag) and no `in_last`
  (never a date); a `lifecycle` bound takes no `is_set` (always set) and no
  `contains`; a behavioural `count` takes comparisons only. The builder's
  operator list narrows to match, so a control cannot offer an operator the
  server would refuse.

  **`is_set` was not merely unspelled — it was unaskable.** A ClickHouse
  `Map` returns the value type's default for a missing key, so a property that
  was never sent and one sent as `""` read back identically and no comparison
  could separate them. It compiles through `mapContains` on a map and an
  emptiness test on a column, which are genuinely different questions.

  Text matching folds both sides with `lowerUTF8`, so `path contains checkout`
  finds `/Checkout`; `=` stays case-sensitive, because changing it would
  reinterpret every saved segment. Negations include people who have nothing
  in that slot at all — the same reading `!=` has always had here — and
  `is_set` is how you exclude them.

  **`AST_VERSION` stays at 1 and no funnel definition is rewritten.** Every
  previously valid tree parses to exactly the same object, which is pinned by
  a test rather than asserted in a comment: the new families are additional
  members of a clause union, and the operators already in use match the member
  they always did.


- **The installed version, on the Settings screen.** A new Install card
  reports what release the server is running, with a link to that version's
  release notes. The number comes from `GET /v1/meta` rather than being
  compiled into the dashboard bundle: the two agree in a real install, since
  one image builds both from one commit, but the question being asked is
  "what is running", and only the server can answer that. The route is
  **session-authenticated and deliberately not on `/health`** — a version
  number tells a caller which published advisories apply to the install, and
  `/health` answers anything that can reach the port. The release-notes link
  carries `rel="noreferrer noopener"`, so an install's own hostname does not
  travel to GitHub in a referrer. The version also appears as small dimmed
  text at the foot of the sidebar, on every screen — hidden below `sm`,
  where that sidebar reflows into a top bar that already scrolls at 390px.
  Beside it is a **changelog link, which points at `CHANGELOG.md` on `main`
  rather than at this version's tag.** The Install card's "Release notes" link
  already answers "what shipped in the version I am running"; from inside a
  running install the useful question is the opposite one — what has shipped
  since — and the file is newest-first, so it opens on exactly that. It also
  cannot 404, which a tag link can before a release object exists.

- **A link to the repository in the dashboard header**, beside the theme
  toggle — the label "Star on GitHub" at `sm` and wider, the star icon
  alone below it. **It carries no star count, and that is the decision
  rather than an omission:** the two ways to show one both make the
  dashboard reach a third party without being asked — GitHub's
  `buttons.github.io` widget, and a browser fetch of `api.github.com`.
  Either sends the IP of everyone who opens Lyraflow to GitHub, and
  neither works in an install with no egress. The link is marked
  `rel="noreferrer noopener"` for the same reason: without `noreferrer`
  the outbound request carries this page's URL, which on a self-hosted
  install is the operator's own hostname.

## 0.10.0 — 2026-08-27

### Added

- **A funnel step can be optional.** A step marked `"optional": true` may be
  skipped without disqualifying anyone from the steps after it —
  **conversion is now measured over the required steps alone**, so a funnel
  with no optional steps reports exactly what it always reported. An
  optional step branches off the last required step before it: its result
  carries `optional: true`, a `skipped` count — the people who reached
  that required step and did not do this one inside the window — and a
  `continued` count, the people who did do it and went on to the next
  required step through it; a required step's result carries none of the
  three. The first and last steps of a funnel still cannot be optional,
  since they define entry and conversion, and a funnel may carry at most
  `MAX_OPTIONAL_STEPS` (2) of them inside the existing eight-step ceiling —
  measured, not preferred: one measured shape at three optional steps
  compiles past ClickHouse's 262,144-byte `max_query_size` and fails
  outright. `POST /v1/funnels/:id/people` accepts a third `mode`,
  `"skipped"`, for optional steps only; it and `/dropoff` refuse
  `mode: "dropped"` on an optional step and `mode: "skipped"` on a required
  one, each with a `400` (`code: "mode"`). `definition_version` moves to 3
  for this — a build reading a definition a newer build wrote now refuses
  it with a `400` naming the version, on both read and write, rather than
  silently dropping the field it does not understand and reporting a
  smaller `converted`. **A saved funnel with three optional steps is now
  refused at save time** under this cap; nobody has one yet, but a caller
  scripting against the old limit will see a `400` where it used to see a
  `201`. One that was saved before this release cannot be RENAMED either:
  `PATCH /v1/funnels/:id` cap-checks the definition the patch would produce,
  so a name-only patch to such a funnel returns the same `400`. Listing and
  reading it still work — one bad row does not break the list page.
- **A compiled funnel that is too large to run is refused before it reaches
  ClickHouse.** Past `MAX_COMPILED_QUERY_BYTES`, every route that compiles a
  funnel returns a `400` naming what to remove — `where` predicates, step
  audiences, or optional steps — instead of the request reaching ClickHouse
  and failing there with a bare syntax error. `POST /v1/funnels` and
  `PATCH /v1/funnels/:id` compile the definition and discard the SQL for
  exactly this reason, so a funnel that could never run is refused at save
  time rather than saved with a `201` and then failing on every `/run`,
  `/dropoff` and `/people` it is ever asked for. The cap bounds the failure;
  it does not fix it
  ([#200](https://github.com/lyraflow/lyraflow/issues/200)).

- **The feed reads over a window you choose.** A range control (last hour,
  24 hours, 7, 30 or 90 days) and an event-name filter drive the chart, the
  accepted table and the rejections together. Before this each of the three
  picked its own window and none of them said which: the events table sent
  no `since` and inherited the server's 24-hour default, the rejections
  asked for 24 hours explicitly, and the chart above them was fixed at sixty
  minutes — so the chart and the table under it disagreed by a factor of
  twenty-four. The range and the filter live in the URL, so a refresh keeps
  them and the screen can be sent to someone else as a link. The poll rate
  follows the range: three seconds for the live windows, a minute for the
  historical ones. The rejected tab takes the window but **not** the event
  filter, deliberately — a rejection may have been refused *because* its
  event name is missing or unparseable, so filtering by name would hide
  exactly the rows that tab exists for.
- **`GET /v1/events/stats` accepts `event`.** One event name, narrowing the
  aggregate the same way `event` already narrowed `GET /v1/events` — same
  128-character ceiling, same semantics, and independent of `group_by`.
  Added because the two are read together: the feed draws this aggregate
  directly above the table `/v1/events` fills, and a filter that reached
  only one of them would leave a chart counting everything above a table
  showing one event.

### Changed

- **The funnel chart is a flow diagram, not a stack of bars.** The required
  steps form a spine, an optional step hangs off it as a branch, and the
  people who continued through it rejoin the spine at the next required
  step. **Every band and every node is drawn at its own count through one
  scale for the whole plot**, so any two widths on the chart are comparable
  and a band does not taper. The count and rate printed on a band are the
  true values, never scaled.
- **A funnel's drop-off is drawn.** The people who reached a step and went
  no further leave it as a ribbon that fades out, labelled with their count,
  rather than being left as empty space under the bands for the reader to
  infer. A ribbon always leaves away from the flow — downward from a
  required step, upward from a branch — so it never crosses the paths that
  continue.
- **The feed's chart names what it measured.** Its resolution follows the
  chosen range, its caption and its hover readout say which unit they are
  in, and three marks under the plot name the window's start, middle and
  end. Bar heights are on a **square-root scale**, stated on the chart: on a
  ninety-day window peaking near 1,900 events in a day against a baseline
  near 5, a linear scale floors the baseline at one pixel and eighty-five
  days of real traffic draw as a flat line. Zero is still zero and order is
  preserved, but a bar is no longer proportional to its count.
- **A funnel's partial-window warning says the window in words** — "the full
  7-day window" rather than "the full 604800-second window".

### Fixed

- **The feed's empty state no longer claims the project has no events.** It
  said "No events yet" from a query that had only ever looked at one day, so
  a project whose last event was a week old was told it had none. It names
  the window it looked at, and the filter when one is set.
- **The feed's chart no longer crashes on a long window.** It assumed
  minute resolution whatever the range, so a ninety-day window built 129,600
  buckets and the screen failed outright rather than drawing anything. Only
  reachable once the range became a choice, in this release.

## 0.9.0 — 2026-08-22

### Added

- **`POST /v1/funnels/:id/people` lists who reached a step, not only who
  dropped there.** Its required `mode` — `reached` (`level >= step`, the
  population behind the chart's own number) or `dropped` (`level = step`,
  the same list `/dropoff` already gave) — has no default: the two differ by
  a factor of three on a real funnel, and whichever way a default fell, the
  other reading is what a caller would get by accident. At a funnel's last
  step, `dropped` is not empty — someone who converted has nowhere further to
  be counted at, so they are returned there too, exactly as `/dropoff` has
  always answered that step. `/dropoff` itself is unchanged, kept for
  compatibility. The funnel screen picks this up too: click a step and a
  Reached/Dropped panel opens beneath the chart, reusing the same bounded
  member list Segments already shows.
- **A funnel step can gate who advances past it, not just which event
  counts.** A step's new `audience` is a segment filter tree — the same
  `FilterNode` grammar `POST /v1/segments` takes — checked against the person
  at that step, distinct from `where`, which still narrows which occurrence
  of the event counts. A person who fails a step's `audience` is not removed
  from the report the way the funnel's own `segment_id` would remove them;
  they are counted at the step they did reach and no further. The window
  inside a step's `audience` is anchored to **now**, exactly as a segment's
  is — over an older date range that judges a person against today, not
  against their own entry into the funnel, and the funnel builder states
  this on screen. Behavioural conditions across every step's `audience` in
  one funnel are capped at 25 in total
  (`MAX_FUNNEL_BEHAVIOR_NODES`), on top of the existing per-tree cap.
- **Projects can be deleted, from Settings and from the CLI.** Deleting destroys
  every event, person and report a project holds, in both databases, and asks you
  to type the project's slug first. It runs as a background job: ingest stops
  immediately, ClickHouse is torn down, the result is verified, and only then is
  the project removed from Postgres — the order that makes a half-finished delete
  retryable instead of leaving orphaned partitions
  ([#39](https://github.com/lyraflow/lyraflow/issues/39)). `lyraflow projects list`
  and `lyraflow projects delete <slug>` are the CLI half
  ([#60](https://github.com/lyraflow/lyraflow/issues/60) in part).

### Changed

- **A funnel result reads as a flow rather than a stack of bars.** One bar
  per stage left the reader to subtract; a tapering ribbon between two stages
  draws the loss where it happened, and carries that step's conversion rate
  on it. Beneath the chart, a sentence names the biggest leak — the step
  losing the largest share of the one before it — because "this funnel is
  slow to convert" is not actionable and "Checkout loses 55% of the previous
  step" is. Stage colour is one hue in monotone lightness steps rather than a
  set of distinct hues: funnel stages have an order that changes the meaning
  if you swap them, and a hue ordering does not survive colour-blindness. The
  ramp spans seven steps, not eight, because that is the widest span of the
  copper ramp whose palest member still clears 2:1 on each mode's surface —
  measured, not chosen. Below the `md` breakpoint the previous stacked bars
  render instead: eight steps across 390px is 48px each, which holds neither
  an event name nor a count nor a percentage.
- **The funnel builder gives each step a card of its own.** A step's event,
  its `where` predicates and its audience previously sat at the same visual
  level as the next step's, so where one step ended was answered by reading
  rather than by an edge. Past four steps, a stored funnel opens with its
  finished steps collapsed to a one-line summary; anything unfinished stays
  open, because a collapsed row would hide the one field standing between an
  operator and a saveable funnel. Collapse is decided when the form loads and
  never changes because you typed — a step folding shut the moment it became
  valid would move the form under the cursor mid-edit.

## 0.8.0

A release about being able to see and operate what is already there. Event rows
and person rows open to show everything they carry, a segment condition can
filter on the attributes an event actually has rather than only its custom
properties, and projects and the admin account can be managed from the browser
instead of from `psql` and the CLI.

Three of the entries below are fixes, and they share a shape worth naming: each
was a screen or a query that was **not wrong so much as quietly incomplete** —
a chart drawing zeros as though they were ones, a switcher forgetting which
project you chose, and a segment condition on a numeric property that saved,
ran, and matched nobody. None of them errored. All of them answered.

### Added

- **Clicking an event in the Feed shows everything that arrived with it** — the
  full timestamp and id, the URL, path and referrer, the campaign it came
  through, the device, OS and browser, and every custom property, with the
  string and numeric maps merged back into the one bag you sent. Attributes the
  event did not carry are left out and counted rather than listed as blanks.

  This needed the UI's own event type widened: `GET /v1/events` was already
  sending `utm_*`, `os`, `browser`, `country`, `region` and `city`, and the
  browser was discarding them.

- **The Feed's events-per-minute chart is readable.** It fills the width of its
  card instead of a fixed 6px per minute, hovering a bar names its value and
  minute, and the tallest bucket in the window is labelled — bars are only
  shaped relative to each other, so one event in a silent hour drew exactly the
  chart a thousand would.

- **A segment behaviour's `where` can filter on the event's own attributes**,
  not just its custom properties: `path`, `url`, `referrer`, the five `utm_*`
  fields, `device_type`, `os`, `browser`, `country`, `region` and `city`. Set
  `"source": "attribute"` on a predicate and name one of them. "Viewed pricing
  at least once in the last 30 days, from the spring campaign" was not
  expressible before — a predicate on `utm_campaign` was well-formed, saved
  without complaint, and read an empty property slot, so it answered zero.

  **A `context` condition is not the same thing** and is not replaced by this.
  It matches whoever was ACQUIRED through a campaign, whatever they later did;
  a `where` predicate matches people who did *this* thing *from* it.

  **Nothing about existing segments changes.** A predicate with no `source` is
  a property predicate, exactly as before, and `ast_version` is still `1` — no
  migration, and no stored tree means anything different than it did. A
  property genuinely named `path` keeps working; nothing is inferred from a
  name.

  Funnel steps take the same predicate, because they use the same shape.

  In the web UI, the Where row's field now lists Attributes above Properties
  in one picker, so the name you saw in the feed is where you look for it.

- **A segment's member preview returns each person's traits**, and the web UI
  expands a person row to show them beside that person's context — country,
  city, device, OS, browser, referrer and campaign, which the response already
  carried and no screen had ever shown.

  **Traits are capped at 50 keys per person**, with the person's real trait
  count returned alongside, so a capped row says what it held back rather than
  reading as the whole set. They cost no extra query: the trait join is one
  every compiled segment already performs, because predicates read it.

  `referrer`, `utm_source`, `utm_medium` and `utm_campaign` are shown as
  **first touch**, because that is what they are: those four are recorded once,
  at acquisition, and asking for them at `latest` scope returns the
  first-touch value.

- **Projects can be renamed and archived from Settings.** Archiving stops
  Lyraflow accepting events for a project and changes nothing else: the data is
  intact, every report keeps working, retention keeps applying, and restoring is
  one click. Ingest for an archived project answers `401` with
  `{"error":"project_archived"}` — `401` specifically, because the browser SDK
  treats it as final and retries anything else forever.

  **A rename never changes the slug**, which is what `lyraflow` commands address
  a project by.

  There is still no delete: clearing a project's data means dropping ClickHouse
  partitions for some tables and running asynchronous mutations for others, in
  an order that cannot orphan data. Archiving is the reversible answer until that
  exists.

- **A Profile screen**, from the account menu, for changing the admin's email
  address and password. Both require the current password, and both are
  rate-limited exactly as the login form is. **Changing the password signs out
  every other browser** and keeps the one that made the change. There is no
  confirmation email — Lyraflow sends no mail — so a new address takes effect
  immediately.

### Changed

- **The theme control is two states, not three.** It shows one icon and flips
  between light and dark, instead of cycling through a "system" state you had to
  pass through. Following the operating system is still the default and still
  what a first visit gets: nothing is stored until the control is clicked, and
  an OS change with no stored choice is still followed live.

### Fixed

- **A minute with no events was drawn as a small bar.** The Feed's chart applied
  its minimum bar height before consulting the count, so an hour of silence
  rendered as a dotted line of small values — the same false reading the chart's
  zero-fill exists to prevent, one layer further down. An empty minute now draws
  nothing above the baseline.

- **The project switcher forgot your choice on every reload.** It opened on
  whichever project the server listed first, every time, so any project but the
  first was unusable for anything that outlived one page load. The choice is
  remembered per browser now, and validated against the project list before it
  is used — a remembered project that no longer exists falls back rather than
  scoping every request on every screen to something the server refuses.

- **A segment condition on a numeric property matched nobody when it was
  written in the web UI.** Every control in the builder yields text, and a
  predicate reads `properties` or `properties_num` depending on whether its
  value is a JSON string or a JSON number — so `results = 21`, typed in the
  builder, asked the string map for a number and got a confident zero. The
  same held for a numeric trait. The builder now reads each property's
  recorded kind from `GET /v1/schema/properties` and sends the matching type.

  **Segments saved before this fix keep the value they were saved with.**
  Opening one in the builder converts it as soon as the schema answers, and
  saving persists the corrected value; nothing is rewritten in place until
  then.

  Where the kind cannot be established — a property the project has never
  recorded, or one it has recorded both as text and as a number — the
  condition stays text, as it always was, and the row now says so instead of
  leaving a zero to be interpreted.

## 0.7.0

Two changes alter what stored data MEANS, and both are called out first because
upgrading applies them whether or not you read this.

### Changed

- **A page view is stored as `$page`, with the page name as a property.**
  `page('Pricing')` used to store `Pricing` as the *event name*, so a page view
  stopped being a page view and became its own event type — there was no "all
  page views" query, `page('signup')` and `track('signup')` were
  indistinguishable once stored, and every page name claimed a slot in a
  `LowCardinality` column and a property-key budget of its own. The name now
  lands in the `$page_name` property.

  **Events already stored under a page name stay as they are.** This changes
  ingest, not history: a project that used `page(name)` before this release has
  its old page views under their old names and its new ones under `$page`.

  `$` is now reserved for Lyraflow. A property key you send beginning with `$`
  is dropped — in both the string and the numeric map, since routing is per
  value and a guard on one map would move the collision into the other rather
  than prevent it. `price_$` and `a$b` are ordinary keys and are untouched.

- **A `lifecycle` bound with no timezone is UTC.** It used to be resolved with
  the server's own timezone, so the same stored segment meant a different
  instant depending on where the process thought it was — and moving a
  deployment between zones, or a container picking up a different `TZ`, changed
  which people it matched with no error and no visible change to the
  definition.

  **If your server was not on UTC, such a bound has shifted by that offset.**
  Once, visibly: the builder shows the instant it now names when you open the
  segment. Bounds that carry a `Z` or an explicit offset are unaffected, and
  always were.

### Added

- **`lyraflow_ingest_quota_used_ratio`**, a gauge per quota-carrying project.
  Quota enforcement answers `429` once a project passes its limit, and the only
  existing signal counted events *already lost*. Alert on this below 1.0 — at
  1.0 events are already being refused. A scrape costs no database read; it
  reads the ingest path's own cache.

- **Every event name is discoverable, including events with no properties.**
  The schema catalogue was fed only by unrolling each event's property maps, and
  unrolling an empty map produces nothing — so a property-less event name was
  invisible to `/v1/schema/events`, not merely absent from the property list.
  Existing events are not backfilled: such a name appears when the next one
  arrives.

- **A funnel's cached summary records the range it ran over.** The list showed a
  rate next to a timestamp with nothing to say which window produced it, so a
  funnel last run over 90 days displayed a 90-day rate under a screen whose
  default is seven. `last_range` is on the wire and the screen renders it — or
  says `range unknown` for a summary written before this release, rather than
  labelling it with a guess.

- **`lyraflow usage`**, reporting what a project has consumed this month.

- **A `trusted_proxies` extension point for Caddy.** Behind a CDN the address
  Caddy observes is the intermediary's; this is where you tell it which peers to
  believe. No visible effect until GeoIP exists, and the README says so.

### Fixed

- **A contended `/v1/alias` returned `503` instead of retrying.** A
  serialization failure is Postgres asking the client to re-run the
  transaction; nothing did, so a retryable conflict was reported as an outage.
  Now retried, whole and bounded, with jitter.

- **The CLI no longer crashes against an older server** that omits a field it
  expects. It casts responses rather than validating them, so a field the
  server does not send arrived as `undefined` and a command that should have
  printed a table died with a stack trace.

- **`restore.sh` asks whether it can drop the schema before destroying
  anything**, instead of failing halfway through with ClickHouse already
  replaced.

- **Person deletion sweeps property keys only the erased person ever sent.**

- **The login rate limiter's namespace map is bounded.**

### Documented

- **A minimum Docker Compose version: v2.21.0.** `install.sh` passes a Go
  template to `docker compose ps --format`, which older versions reject
  outright. Everything else these scripts use is older. The floor is derived
  from the flags in use and checked against the README by a test, so it cannot
  quietly go stale.

## 0.6.0 — 2026-08-19

### Added

- **A server-side SDK can say what it is, and stops being mistaken for a bot.**
  The ingest payload takes an optional `context.library` — `{ name, version }`,
  both required when present — and a payload declaring one of Lyraflow's
  server-side SDKs is never filtered as a crawler.

  This is not cosmetic. `isBot()` matches the HTTP `User-Agent`, and the
  clients those SDKs use announce themselves as `python-requests`, `okhttp` or
  `curl/` — all of which are bot tokens. A PHP or Python integration was
  therefore discarded entirely on its first request, answered `202`, with no
  dead-letter row and a counter it shared with malformed data. The field is the
  convention Segment, PostHog and Amplitude already use, so it also survives
  proxies and serverless platforms that rewrite the transport header.

  **Stated plainly, because it is the honest limit:** bot filtering is data
  hygiene, not a security boundary. The write key ships inside the browser
  bundle, so any client can claim to be a server-side SDK — or simply send a
  browser's `User-Agent`, which has always been possible. What the filter
  removes is incidental traffic: crawlers, uptime monitors, link-preview
  fetchers. None of those declare a library.

- **Bot drops are visible instead of anonymous.** They had shared the
  `rejected` counter with validation failures and limit rejections, so an
  operator could see events were refused but not that they were refused *as
  bots* — "is my integration broken, or is that just crawler traffic" had no
  answer in the data. There is now a `bot` count in the batch response, a `bot`
  outcome on `/metrics`, a Bot tile on Settings → Usage, and a column behind
  all three.

- **The browser SDK warns when a batch comes back dropped as bot traffic.**
  Headless Chrome's user agent contains `headless`, so a Playwright or
  Lighthouse CI run against an instrumented site is filtered — correctly, but
  silently. The SDK now says so in the console, naming bot traffic rather than
  bad data.

### Fixed

- **A create that landed after you moved on could yank you off the form you
  were editing.** The segment builder guards every async continuation of a save
  against the form it was issued for; the navigation after a successful create
  was deliberately exempt, so it would still acknowledge the create. That
  exemption was unconditional, and an operator who left the create route for a
  different segment while the save was in flight was dragged to the list,
  discarding whatever they had typed. The acknowledgement is kept for the case
  it exists for; only the case that does harm is suppressed.

- **A segment save that half-applied would not say which half.** Renames and
  definition changes are sent as two requests on purpose, because a body
  carrying a tree resets the cached count. If one failed the screen said only
  "try again". It now says which landed — and, when neither did, says so, which
  is a claim it previously could not safely make.

- **The member preview can say exactly how many people it showed.** A walk that
  ended on a full page at the window limit could not tell "exactly this many"
  from "many more". The response's own count settles it.

- **Opening a large segment no longer issues a burst of identical lookups.**
  Sibling conditions asking for the same catalogue list now share one in-flight
  request. Nothing is retained once it settles, so no cached answer can go
  stale.

- **The installer's port check asks what is holding the port**, rather than
  trusting that a matching domain in `.env` means the listener is ours. An
  install whose port 80 was held by an unrelated web server used to skip the
  check, write `.env`, and then fail at `docker compose up` with a bind error.

### Changed

- **Schema version 15.** One migration, additive: a counter column for bot
  drops. Existing rows get `0` — the drops that already happened were never
  distinguished, and inventing a number for them would be worse than an honest
  zero.

- **`POST /v1/batch` responses carry a fifth count, `bot`.** Additive; a client
  ignoring it is unaffected. The single-event routes are unchanged and still
  answer `{"status":"accepted"}` whatever happened, because a tracking endpoint
  that reports failure breaks the site it is measuring.

### Known limitations

- **`context.user_agent` is accepted, documented, and read nowhere.** A
  server-side SDK forwarding the real visitor's user agent in the payload has
  it ignored: enrichment reads the transport header, so those events record an
  unknown device and browser. More importantly, once a server-side library is
  declared there is no route by which crawler traffic is filtered at all — a
  backend honestly forwarding `Googlebot/2.1` would have that crawler stored as
  a person. Nothing produces such traffic yet, since no server-side SDK ships,
  but it wants deciding before one does.

- **A purge does not remove property keys only the erased person ever sent.**
  Unchanged from 0.5.0. Event *names* left with nothing behind them are swept;
  a property key hanging off an event other people still send is not.

- **`GET /v1/schema/events` is name-ordered, and `limit` applies after that
  ordering.** Unchanged from 0.5.0, so `last_seen` re-ranks only within the
  first page.

- **Events carrying no properties are invisible to both schema endpoints.**
  Unchanged from 0.5.0.

- **A lifecycle bound without a timezone is resolved in the server's
  timezone.** Unchanged from 0.5.0 and still awaiting a decision about the
  bounds already stored.

- **Step and behavioural criteria filter event *properties* only.** Unchanged
  from 0.5.0.

## 0.5.0 — 2026-08-18

### Added

- **`GET /v1/schema/events` carries `last_seen`** — the latest instant each
  event name was recorded, as an ISO-8601 timestamp. Enough to rank an
  autocomplete by recency rather than alphabetically, which is what stops the
  list becoming useless once a project has a year of history. There is still no
  frequency signal; `event_schema` carries no counts.

### Fixed

- **The first screen a new install shows told you to run a command that does not
  exist.** With no admin password set, the sign-in screen said to run `lyraflow
  set-admin-password <email>`. On the install path the README recommends, there
  is no `lyraflow` binary on the host at all — `install.sh` brings up
  containers — so following the instruction exactly gave `command not found`.
  It now prints the invocation that works, reads the password from the terminal
  rather than from an argument or the shell history, and names the non-Docker
  form for installs that do have the binary.

- **A deletion left the erased person's event names in the autocomplete
  forever.** After `DELETE /v1/persons/:id` the person's events were gone, but
  `GET /v1/schema/events` kept offering the names of events only they had ever
  sent. An event name can identify on its own — a name a single customer fired
  once, or one that describes what was viewed — so this was a residue of the
  person's data surviving an erasure that reported success, as well as an
  autocomplete offering names that could never match anything. A purge now
  removes event names it has left with no events behind them. Names anyone else
  still sends are untouched. See *Known limitations* for the property-key half,
  which is not yet swept.

- **The funnel builder kept the previous funnel on screen, and saveable, when a
  load failed.** Named as a known limitation in 0.4.0 and left unreproduced
  there; all three of its cases reproduce. Switching project while
  editing a funnel absent from the new project, moving between two funnels where
  the second fails to load, and going from an edit route to the create route all
  left one funnel's definition under another funnel's address — and a save then
  wrote it against whichever funnel the address named. The editor now clears
  itself whenever its address changes, and refuses to save until a load for the
  funnel actually on screen has succeeded.

- **A second stack built from the same checkout silently replaced the first
  one's image.** Running a second Compose project from one checkout — the
  natural way to get an isolated stack for a manual test — gave it its own
  containers, volumes and ports, but not its own image name, so its build
  retagged the shared one. Nothing failed at the time; the running container
  kept serving what it had started from. It surfaced on the next ordinary
  `docker compose up -d`, as a stack running code nobody deployed. The image
  name is now `LYRAFLOW_IMAGE`, defaulting to exactly what it was before.

### Changed

- **Schema version 14.** One migration, additive: a case-insensitive unique
  index on the admin account's email. Sign-in already compared addresses
  case-insensitively while the constraint was case-sensitive, so two accounts
  differing only in case could in principle coexist and sign-in would resolve to
  an unspecified one of them. Nothing in the product could create that state —
  it needed hand-written SQL — and it is now impossible rather than merely
  unreached. **An install that somehow already holds two such rows will see the
  migration refuse rather than pick a winner**, which is deliberate: which of two
  admin accounts is the real one is not a question a migration should answer.

### Known limitations

- **A purge does not remove property keys only the erased person ever sent.**
  Event *names* left with nothing behind them are now swept, but a property key
  hanging off an event other people still send is not — if only the erased
  person sent `patient_id` on a `checkout` everyone fires, that key survives in
  `GET /v1/schema/properties`. Answering it means re-unrolling every surviving
  event's property maps for the whole project on every deletion, which is a
  materially different cost, so it is tracked rather than done quietly. Trait
  keys are unaffected: those are read from the person's own rows, which a purge
  deletes outright.

- **`GET /v1/schema/events` is name-ordered, and `limit` applies after that
  ordering.** So a project with more event names than the cap gets the
  alphabetically first ones, and `last_seen` only lets you re-rank within those
  — it does not yet let you ask for the most recently seen 50 names out of 500.
  Ordering by recency server-side would change which rows every existing caller
  receives, so it is a decision rather than a field addition.

- **Events carrying no properties are invisible to both schema endpoints.** They
  are fed by views that unroll each event's property map, so an event with an
  empty map produces no rows and never appears — not merely in the property
  list, but in the event-name list too.

- **A lifecycle bound without a timezone is resolved in the server's timezone**,
  so the same stored segment can mean a different instant on a differently
  configured deployment. Unchanged from 0.4.0: bounds written before that
  release carry no timezone, and converting them on read would silently change
  which people those segments match, so this needs a decision about existing
  data rather than a patch. A bound that is a bare date with no time renders as
  an empty field for the same reason.

- **Step and behavioural criteria filter event *properties* only.** Unchanged
  from 0.4.0. Fields recorded on the event itself — page path, URL, referrer,
  device and geography — are not reachable this way; the interface says so where
  you type it and points at the segment condition that does match them.

- **Saving a segment rename and a definition change together can half-apply.**
  Unchanged from 0.4.0. The two are sent separately on purpose, because sending
  the definition resets the cached count. If one fails the screen says so
  without saying which. Pressing Save again re-sends only what still differs.

- **Opening a large segment for editing asks the schema catalogue once per
  suggestion field**, with no sharing between fields wanting the same list.
  Unchanged from 0.4.0; cheap reads, but they scale with the size of the tree.

## 0.4.0 — 2026-08-18

### Added

- **Segments: a visual builder for the people a query describes.** Nested
  boolean groups to the full depth the query language allows, with four kinds of
  condition — who someone is (a trait set by `identify()`), what they did (an
  event, counted or aggregated, inside a window, optionally narrowed by event
  properties), where they came from (campaign, referrer, device, geography), and
  where they are in their lifecycle. Conditions can be negated individually.

  Counts are live where that is affordable and explicit where it is not: a tree
  the engine can answer cheaply re-counts itself as you edit, while one carrying
  an expensive condition waits for you to press Run and says, against the
  condition responsible, why it is expensive. The three limits the server
  enforces — total conditions, nesting depth, behavioural conditions — disable
  the controls that would exceed them and name the limit, rather than letting a
  save fail after the work is done.

  A saved segment can be previewed as a list of the people it matches. That list
  pages, and it distinguishes "that is everyone" from "this preview stops here"
  — they are different facts, and conflating them makes a segment look smaller
  than it is.

- **Funnel steps take their own criteria.** A step is no longer just an event
  name: it can be narrowed by that event's properties, so *page views of the
  changelog* is a step rather than *all page views*. The query engine already
  supported this; only the builder could not express it, and a funnel authored
  elsewhere would render with its criteria visible but locked. The list and
  detail screens now show what each step is narrowed by, so two funnels that
  differ only in their criteria are no longer indistinguishable.

- **Suggestion fields show their options the moment you focus them.** Event
  names, event properties and trait names are all read from what a project has
  actually recorded. Previously they waited for you to type, which is no help if
  you do not already know how the name begins. They remain free text — a
  definition may legitimately be written before the data that fills it — so the
  list suggests and never restricts.

- **`lyraflow seed-demo <project>` fills a project with reproducible demo
  data.** 400 synthetic people and 5,000 events over 90 days by default, with a
  signup-to-purchase funnel that has real drop-off, identify traits (string,
  numeric and boolean), first-touch UTM campaigns, purchase amounts, and
  visitors who browsed anonymously before signing up — so the segments, funnels
  and feed screens have something to show on a fresh install. `--persons`,
  `--events`, `--days`, `--seed` and `--anchor`; `--help` for the rest. At a
  fixed seed the data is identical run to run, so a screen can be compared
  before and after a change.

  Two things to know, both documented in the README's *Demo data* section and
  in `--help`. It writes to Postgres and ClickHouse **directly** rather than
  through the ingest API: `/v1/batch` clamps every client timestamp to within
  24 hours of arrival — deliberately, so a wrong device clock cannot corrupt a
  time-windowed segment — which makes ninety days of backdated history
  impossible to create over HTTP. That clamp is unchanged and there is no
  trusted-backdating flag. And it is **additive only**: it has no reset, no
  wipe and no `--force`, so it cannot delete anything, including its own
  earlier output. Running it again adds another cohort rather than replacing
  one.

### Fixed

- **A funnel step's criteria displayed with a blank operator.** The web
  interface declared its own copy of the predicate type and spelled the operator
  field differently from the rest of the system, so the value read as undefined.
  Nothing failed loudly: each declaration was coherent on its own terms, so
  there was no disagreement for the compiler to see. The type is now shared
  rather than duplicated.

- **An absolute date range on a behavioural condition could never be saved.**
  The date control writes a local wall-clock value with no timezone, and the
  query language requires an unambiguous instant, so every such window was
  rejected. Times are now stored as UTC, displayed in your own timezone, and the
  screen says which timezone you are looking at.

- **A saved segment could show a lifecycle condition with no date in it.** The
  control did not convert the stored instant for display, so it rendered empty
  while the condition itself was intact — a segment that matches on a date,
  showing no date.

- **Adding a condition and saving immediately was rejected by the server.** An
  unfilled condition is not a valid stored one, and nothing stopped you saving
  it. The builder now holds an unfinished condition quite happily, refuses to
  save while one exists, and says on the condition itself what is missing.

- **Editing a segment, then switching project, could write the first project's
  definition into the second.** The editor kept the previous segment's state
  when a load failed, and the save used whichever segment the address then named.

- **A segment whose top-level condition was not a group showed no cost warning**,
  while still saying it carried one.

### Changed

- **Comparison operators read as words.** `>=` is *at least*, `!=` is *is not*,
  and an unbounded window is *at any time* rather than *ever*. A behavioural
  condition reads as a sentence — *purchase at least 3 times in the last 90 days
  where currency is USD*. The stored form is unchanged, and the CLI keeps the
  symbols, which are the right register there.

- **`@lyraflow/sdk-browser`'s `autoPageView` now defaults to `true`.** A
  pasted install snippet with nothing else written now sends one page view on
  load, instead of recording nothing until the site calls `lyraflow.page()`
  itself. Opting out is `autoPageView: false`. A site that already calls
  `lyraflow.page()` on its own will now send two page views per hard load —
  remove that call, or set `autoPageView: false`, whichever is less work. The
  automatic call still fires only once per hard load and never on a
  client-side route change; see the README's *Single-page apps* section.

### Known limitations

- **Step and behavioural criteria filter event *properties* only.** Fields
  recorded on the event itself — page path, URL, referrer, and the device and
  geography fields — are not reachable this way, so a criterion naming one is
  accepted and matches nothing. The interface now says so where you type it, and
  points at the segment condition that does match those fields. Making them
  filterable directly is not done.

- **A lifecycle bound without a timezone is resolved in the server's timezone**,
  so the same stored segment can mean a different instant on a differently
  configured deployment. Bounds written before this release carry no timezone,
  and converting them on read would silently change which people those segments
  match — so this needs a decision about existing data rather than a patch, and
  is tracked rather than quietly fixed. A bound that is a bare date with no time
  renders as an empty field for the same reason.

- **Opening a large segment for editing asks the schema catalogue once per
  suggestion field**, with no sharing between fields that want the same list.
  These are cheap reads, but they scale with the size of the tree.

- **Saving a rename and a definition change together can half-apply.** The two
  are sent separately, on purpose, because sending the definition resets the
  cached count. If one fails the screen says so without saying which, and no
  longer claims that nothing was saved. Pressing Save again re-sends only what
  still differs.

- **The funnel builder keeps the previous funnel on screen when a load fails**,
  which is the shape that caused the cross-project overwrite fixed above in the
  segment builder. It has not been reproduced there and is not known to be
  exploitable in the same way.

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
