# Working in this repository

## ⚠️ This is a public repository

Treat everything in this repo as **published to the world, permanently**. It is the public
Lyraflow product repo and will be open to the internet.

That applies to *all* of it, not just source files:

- File contents, commit messages, branch names, tags, code comments, TODOs
- Issues, PR descriptions, docs, examples, test fixtures, seed data
- Git history — a bad commit is not fixed by a later commit that removes the file

Never commit here:

- Secrets of any kind: API keys, tokens, passwords, private keys, connection strings
- Real customer, user, or prospect data — use obviously fake data in examples and fixtures
- Internal business material: revenue, pricing strategy, roadmap rationale, competitor
  analysis, partner/vendor names, marketing plans, hiring notes
- Personal information: home addresses, phone numbers, private email addresses
- Private infrastructure detail: internal hostnames, IPs, server layouts, admin URLs
- References to any private/internal repository or its contents

Business-side material belongs in the private companion repo, which this repo never
mentions by name or path.

**When in doubt, ask before committing.** Writing to a local file is cheap to undo;
pushing to a public repo is not.

## What Lyraflow is

Self-hosted, end-to-end customer journey intelligence and analytics. Customers run it on
their own infrastructure; their data stays theirs.

## Current status

**v0.1 — ingest, identity, and segmentation.** The HTTP ingest path is real and running:
you can self-host the stack, create a project, and send it events. Identity resolution
exists: `/v1/identify` binds an anonymous device to a known person, `/v1/alias` merges two
known people (server-key only, not reversible), and `GET /v1/persons/:id` reads one
person's stitched profile — resolved zero-lag straight from Postgres, bypassing
ClickHouse's identity dictionaries, and time-split so a device shared between two people
attributes each event to whoever held it at that moment.

Segmentation ships too. A nested filter tree compiles into one ClickHouse query behind
`POST /v1/segments/preview`, which returns a count and optionally a bounded page of
matching people. Segments can be saved, listed, updated and re-run, and
`/v1/schema/events` and `/v1/schema/properties` expose what a project has recorded, for
autocomplete.

Privacy ships too: `DELETE /v1/persons/:id` and `GET /v1/persons/:id/export` cover
deletion and subject-access export for the same subject `GET /v1/persons/:id` describes,
an in-process purge worker erases the underlying rows, and every read path — segment
counts and members, the person read, the export itself — is filtered against the
suppression boundary the moment a deletion is accepted.

Three operational features have landed since, and each one enforces a column the schema
had promised and nothing honoured. **Retention** prunes events past each project's own
`retention_months`, 13 by default. **Quotas** enforce `monthly_event_quota`, opt-in, with
`429 quota_exceeded` and deliberately no `retry-after`. **Backup and restore** are two
scripts beside `install.sh`: `backup.sh` quiesces the app so both stores are captured with
no writes in flight, `restore.sh` verifies checksums, image version and a typed
confirmation before anything is destroyed, and restores ClickHouse before Postgres so an
interrupted restore cannot resurrect a deleted person.

There is still **no UI** and no reporting layer — funnels, cohorts and retention reports
are v0.2. `README.md` documents the whole public surface; keep it accurate when the API
changes, because it is the only thing standing between a new self-hoster and a working
install. It has drifted twice; both times a shipped endpoint went undocumented because the
task that added it had no documentation step.

## Stack and layout

A pnpm workspace of TypeScript packages, Node 22, ESM throughout. TypeScript is `strict`
with `noUncheckedIndexedAccess`; avoid `any`, and justify it inline on the rare occasion
it is unavoidable. Biome handles both lint and format. Vitest runs the tests. Two data
stores: **ClickHouse** for events, **Postgres** for projects, keys, counters, and the
single shared migration ledger.

```
packages/core/    # pure domain logic: payload schemas (zod), property routing,
                  # timestamp clamping, user-agent and bot classification.
                  # Owns SCHEMA_VERSION. No I/O.
packages/db/      # Postgres + ClickHouse clients, and the migrator. Migrations
                  # live in packages/db/migrations/{postgres,clickhouse} as one
                  # shared version sequence.
packages/server/  # the Fastify ingest service: /v1/track|identify|page|batch,
                  # auth, the batching buffer, cardinality limits, health,
                  # metrics, graceful drain, plus identity resolution
                  # (bindings, aliases, the ClickHouse dictionaries,
                  # /v1/alias, GET /v1/persons/:id).
packages/cli/     # `lyraflow migrate | create-project | healthcheck`.
docs/             # public product documentation
.github/          # CI, issue + PR templates
```

Top-level: `Dockerfile` and `docker-compose.yml` for the self-hosted stack, `install.sh`
for the one-command install, `docker-compose.test.yml` for the test databases, and
`test/restart-durability.test.ts` — a container-driven test that proves no accepted event
is lost across a restart, and that identity bindings made before the restart still resolve
correctly afterwards.

## Running the tests

```sh
pnpm install
docker compose -f docker-compose.test.yml up -d --wait   # Postgres + ClickHouse
pnpm build        # required before the first `pnpm test` — see below
pnpm test         # unit and integration tests
pnpm lint         # biome check
pnpm typecheck    # tsc -b
```

**Build before the first test run, and after adding a migration.** Several tests import
from `@lyraflow/core` by package name, which resolves to its *built* output — and `dist/`
is not committed. On a fresh clone `pnpm test` therefore fails to resolve the import at
all.

The subtler case is a stale build. `schema-version.test.ts` compares the built
`SCHEMA_VERSION` against the migration files on disk; adding a migration changes the files
immediately, but the constant only changes when something emits. The failure reads
"expected 5 to be 6", which looks like a broken test rather than a build that has not been
re-run.

`pnpm typecheck` (`tsc -b`) also emits, which used to make it sufficient on its own. **It is
not any more.** The browser SDK's shipped artefact is an esbuild bundle produced by that
package's own build script, and `tsc` never runs it — so `bundle-size.test.ts`,
`snippet.test.ts` and the SDK route tests all fail on a missing `dist/lyraflow.js` unless
`pnpm build` has run. CI therefore runs lint, typecheck, **build**, then test.

The lesson generalises: a package whose output is not produced by `tsc` cannot rely on
`typecheck` to stand in for a build, and the failure surfaces only where that output is
read.

Most tests talk to those real containers rather than mocking the databases. Two suites
under `test/` are deliberately excluded from `pnpm test` — they build an image, start the
full stack, and take minutes:

```sh
pnpm build
pnpm vitest run --config vitest.durability.config.ts   # restart durability, ~40s
pnpm vitest run --config vitest.backup.config.ts       # backup and restore, ~15min
```

They have separate configs and separate CI jobs because the backup suites take a quarter
of an hour between them — they take real backups, destroy both Docker volumes and restore.
**The durability config selects `test/*.test.ts` and subtracts the backup files rather than
listing what it wants**, so a new `test/*.test.ts` is picked up automatically. Listing the
wanted files in each config reads tidier and loses coverage silently, because a new suite
would belong to neither job.

Both start their own stack from `docker-compose.ci.yml`, which binds the same host ports as
the dev and test stacks (3000 and 8123). **Stop both of those first**, or you get "port is
already allocated" — an environment clash that reads like a broken test. And bring the test
stack back up before the next `pnpm test`, which needs it. Do not run the two configs
concurrently on one machine either: both call `down -v` and would destroy each other's
stack. In CI they are separate runners, which is why they can share the compose file.

**Run one suite at a time — including two ordinary `pnpm test` runs.** Two terminals, or a
background run beside a foreground one, produce dozens of failures spread across unrelated
server test files; one instance produced 75. The cause is not the code under test: every
live-database suite runs its own migrations and clears its own fixtures against **one**
shared Postgres and ClickHouse, so each run keeps deleting rows the other is mid-way
through asserting on. `vitest.config.ts` sets `fileParallelism: false`, which orders files
*within* a run — nothing coordinates two separate runs.

Worth knowing before you start debugging, because the symptom is indistinguishable from a
real regression and has been misdiagnosed as one: two earlier branches reported
"intermittent cross-file database flakiness" that was never reproduced or explained. **A
mass failure across files you did not touch is a second test run until proven otherwise.**

## Writing tests here

A test counts only once it has been shown to fail against the broken implementation. That
rule is easy to satisfy badly, so:

- **Mutate the narrowest unit, and the exact line the test claims to protect.** Reverting a
  wrapper proves the wrapper runs, not that the logic inside it does anything.
- **Mutate compound conditions one clause at a time.** Deleting a whole `if (a || b)`
  proves nothing about `b`. Several conditions in this codebase were provably untested
  while looking covered, because every mutation flipped the entire guard.
- **Ask whether there is a second, easier way for the test to pass.** Real examples caught
  here: an assertion that the compiled SQL contained `person_id` (present in *every*
  query, so the whole feature could be replaced by a literal); an assertion made against
  the test file's own fixture object, which could not fail for any implementation; and an
  ordering test that passed because one fixture name sorted first both alphabetically and
  chronologically.
- **A mutation that breaks everything proves nothing** about the specific test you are
  checking. If your mutation fails unrelated tests too, narrow it.

### Tests share live databases

Most tests talk to one Postgres and one ClickHouse, and Vitest runs files sequentially and
`it` blocks in declaration order.

- **Clean up at the top of `beforeAll`, not only in `afterAll` or a `finally`.** A file
  that tidies up on the way out is still dirty if a previous run crashed, and cleanup that
  deletes from `events` will not remove rows a materialised view already propagated into
  `device_index` or `person_traits`.
- **A green full suite does not prove per-file hygiene.** Later files drop and re-migrate
  the shared tables, which papers over leaked fixtures. If you change a test's fixtures,
  run that file **standalone, three times**, and confirm it passes every time. A real bug
  survived review here because it was verified with a full-suite run.

### Fixture timestamps must be relative

The ingest path clamps any client timestamp older than 24 hours to `now − 24h`. A fixture
pinned to an absolute date therefore **expires on a wall-clock schedule**: the suite was
green one morning and red the same afternoon, with no code change, because the fixtures
had aged past the clamp. Anchor fixtures to `Date.now()` and derive offsets from it.

## Non-negotiables in this codebase

These are defects the branch was repeatedly bitten by. Do not add another instance:

- A promise a caller may fire-and-forget must never reject.
- `p.catch()` cannot absorb a synchronous throw. Use `try { await … } catch`.
- A test must be shown to fail against the broken implementation before it counts.
- Flush the logger before `process.exit()` — or prefer `process.exitCode` and let the
  process end on its own.
- Anything reachable from the public ingest port must be bounded. It is authenticated by
  a key that is public by design, so an unauthenticated caller can reach it. The same
  applies to server-key routes: page sizes, window ceilings, cache entries, and result
  limits all need a bound, not a convention.
- **Every migration bumps `SCHEMA_VERSION`** in `packages/core/src/index.ts` and the
  expectation in `version.test.ts`. `schema-version.test.ts` ties the constant to the
  highest migration on disk and exists because forgetting costs an operator a crash loop
  on their *second* boot, long after the mistake.
- **Migrations are additive, and an applied one is never amended.** `migrate()` skips any
  version already in `schema_migrations`, so editing a shipped file cannot reach the
  deployments that ran it — it changes only fresh installs, which is the worst of both.
  If an earlier migration created something wrong, fix it forward in a new one.
- **Aggregate by `event_id`.** `events` is `ReplacingMergeTree` ordered by a key that
  includes `timestamp`, so a retried delivery that omitted `timestamp` is stored as a
  permanent second row. Any count that does not deduplicate over-counts retries.
- **`project_id` is injected by the compiler from the authenticated key, never sourced
  from a request**, and the suppression filter is injected the same way. There is no AST
  node or request field that can express or remove either — that is what makes them
  guarantees rather than conventions, and it must stay true on every new route and in
  every new query path.
- **Every value reaching SQL is a bound parameter.** Identifiers that cannot be
  parameters — column names, aggregate function names — come from a fixed compile-time
  allowlist, never from request data.

## License and its consequences

Fair-code, under the Sustainable Use License (`LICENSE.md`). Two rules that follow:

1. **Never describe Lyraflow as "open source."** SUL is not OSI-approved. The correct terms
   are "fair-code" and "source-available." This applies to the README, docs, marketing copy,
   commit messages, and anything else written about the project.
2. **A CLA must be in place before merging any external PR.** Without it we lose the right
   to relicense contributed code. This is a launch blocker for accepting contributions.

## Shell scripts

`install.sh`, `backup.sh`, `restore.sh` and the `backup-lib.sh` they share run on the
operator's host, not in a container, so they target **bash 3.2** — the version macOS still
ships. No associative arrays, no `mapfile`. They call plain `docker compose` with no `-f`,
which is what lets `COMPOSE_FILE` point them at a test stack; a script you have to edit to
test is not the script you shipped.

**`shellcheck` is pinned in `devDependencies` and CI runs `pnpm exec shellcheck`.** Not the
runner's preinstalled binary: the two are different versions and they disagree, which once
produced a lint that passed on a developer machine and failed in CI on a rule the local
version had dropped. A lint you cannot reproduce locally cannot be fixed, only guessed at.

## Conventions

- Write for an outside reader who has no context on the project. Assume a stranger is
  reading every file.
- Documentation here is user- and contributor-facing. Design rationale and decision
  records live in the private repo, not here.
- **Lyraflow has a visual identity. Do not invent one.** It is in `brand/`, and the rules
  are in `BRANDING.md` — read that before adding a README header, favicon, social card or
  docs theme. The two that are invisible until they are expensive: there is **no single
  brand hex** (the accent is a different value per mode, because no one copper clears AA
  on both paper and ink), and contrast is **measured** in `brand/contrast-report.txt`,
  never estimated. Do not add a sixth star to the mark.
- **`brand/` is generated output. Do not hand-edit it.** The generator is not in this
  repo, and a rebuild overwrites every file there. Changes have to go upstream — say so
  rather than patching an asset.

## Cutting a release

**A pushed tag is not a release.** GitHub's Releases page lists *release objects*, and
pushing a tag creates none — the tag simply exists, invisible on that page, while the
previous release still reads as Latest. That is the step most easily forgotten, and it
is silent: nothing fails, nothing warns, and the project looks unreleased to anyone who
goes looking. v0.3.0 sat tagged and unlisted until someone checked the page.

The whole sequence, in order:

1. **Branch `chore/release-X.Y.Z`.**

2. **Bump the version in nine places.** Six manifests — `packages/{cli,core,db,sdk-browser,server,ui}/package.json` — and three constants that are compiled into shipped output:
   - `packages/sdk-browser/src/index.ts` → `export const VERSION`
   - `packages/cli/src/api/output.ts` → `export const CLI_VERSION`
   - `packages/server/src/version.ts` → `export const SERVER_VERSION`

   Each of the three has a test asserting it equals its own package's manifest, so
   forgetting one fails the suite rather than shipping quietly. `SERVER_VERSION` is the
   one an operator actually reads: `GET /v1/meta` serves it to the Settings screen's
   Install card, where it is quoted into bug reports and used to decide whether to
   upgrade. A stale number there is worse than none, because it is believed.

   `CHANGELOG.md` opens by promising every package carries the same version. That has
   been false twice: `packages/ui` was scaffolded at `1.0.0` and missed by two
   consecutive release bumps, because a `sed` for the previous version number cannot
   match a package that was never on it. **Grep for the new version afterwards and count
   nine**, rather than grepping for the old one and assuming.

   `SCHEMA_VERSION` in `packages/core/src/index.ts` is **not** part of this. It tracks
   migrations, bumps when one is added, and is unrelated to the release number.

3. **Write the `CHANGELOG.md` entry.** Added / Fixed / Changed, plus what the release
   still cannot do. The known-limitations section is not optional and not a courtesy: a
   release note that lists only what works is the kind of overclaiming this project's
   voice exists to avoid, and the limits are what stop someone filing a bug against a
   documented gap.

4. **Open the PR and wait for CI to finish.** Every job, not just `test`. Do not merge on
   a local green run — the local stack contends for memory with anything else running and
   produces spurious file-level failures that CI, on isolated runners, does not.

5. **Merge.**

6. **Tag the merge commit, annotated, never lightweight:**

   ```sh
   git fetch origin
   git tag -a vX.Y.Z <merge-commit> -F <message-file>
   git push origin vX.Y.Z
   ```

   Tag the commit explicitly rather than `HEAD` — you may be on another branch, and this
   avoids disturbing a worktree mid-task. The message carries what shipped, the schema
   version and whether the migration is additive, the limits, and the standing line that
   **a release is this tag and the source at it** — no container image is published, so
   upgrading means pulling the tag and rebuilding.

7. **Create the GitHub release** — the step in the heading above:

   ```sh
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — <name>" --notes-file <file>
   ```

   `--verify-tag` refuses to invent a tag that does not exist, which is what you want:
   the tag is the artefact, the release object points at it. The body is **not** the
   changelog entry and not the tag message — it is the most user-facing text the project
   publishes, and it earns examples. Read the previous release before writing one.

8. **Confirm it is Latest:** `gh release list`. If the new release is not marked, the
   page still advertises the old version.

**Version numbers are cheap; a wrong one is not.** If a bump ships without its tag, the
manifests claim a release that `git tag` cannot name. That happened to `0.2.1`, and the
fix is to record it in the changelog rather than tag it afterwards — a tag created later
names a moment nobody could have fetched.
