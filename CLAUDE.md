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

**v0.1 — the ingest foundation.** The HTTP ingest path is real and running: you can
self-host the stack, create a project, and send it events. There is **no UI and no query
API yet** — events land in ClickHouse and are read with a ClickHouse client until the
query layer ships. Identity resolution, deletion/GDPR tooling, and the dashboard are later
plans.

`README.md` documents the endpoints and payload shape; keep it accurate when the API
changes, because it is the only thing standing between a new self-hoster and a working
install.

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
                  # metrics, graceful drain.
packages/cli/     # `lyraflow migrate | create-project | healthcheck`.
docs/             # public product documentation
.github/          # CI, issue + PR templates
```

Top-level: `Dockerfile` and `docker-compose.yml` for the self-hosted stack, `install.sh`
for the one-command install, `docker-compose.test.yml` for the test databases, and
`test/restart-durability.test.ts` — a container-driven test that proves no accepted event
is lost across a restart.

## Running the tests

```sh
pnpm install
docker compose -f docker-compose.test.yml up -d --wait   # Postgres + ClickHouse
pnpm test         # unit and integration tests
pnpm lint         # biome check
pnpm typecheck    # tsc -b
```

Most tests talk to those real containers rather than mocking the databases. The durability
test is deliberately excluded from `pnpm test` — it builds an image and starts the full
stack, and takes minutes:

```sh
pnpm build && pnpm vitest run --config vitest.durability.config.ts
```

## Non-negotiables in this codebase

These are defects the branch was repeatedly bitten by. Do not add another instance:

- A promise a caller may fire-and-forget must never reject.
- `p.catch()` cannot absorb a synchronous throw. Use `try { await … } catch`.
- A test must be shown to fail against the broken implementation before it counts.
- Flush the logger before `process.exit()` — or prefer `process.exitCode` and let the
  process end on its own.
- Anything reachable from the public ingest port must be bounded. It is authenticated by
  a key that is public by design, so an unauthenticated caller can reach it.

## License and its consequences

Fair-code, under the Sustainable Use License (`LICENSE.md`). Two rules that follow:

1. **Never describe Lyraflow as "open source."** SUL is not OSI-approved. The correct terms
   are "fair-code" and "source-available." This applies to the README, docs, marketing copy,
   commit messages, and anything else written about the project.
2. **A CLA must be in place before merging any external PR.** Without it we lose the right
   to relicense contributed code. This is a launch blocker for accepting contributions.

## Conventions

- Write for an outside reader who has no context on the project. Assume a stranger is
  reading every file.
- Documentation here is user- and contributor-facing. Design rationale and decision
  records live in the private repo, not here.
