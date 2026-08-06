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

Design phase. **No runnable code yet** — this repo holds the foundation only (license,
community files, docs skeleton, issue/PR templates). Tech stack is deliberately undecided,
so the scaffolding is language-neutral: no `package.json`, no framework, no CI.

## License and its consequences

Fair-code, under the Sustainable Use License (`LICENSE.md`). Two rules that follow:

1. **Never describe Lyraflow as "open source."** SUL is not OSI-approved. The correct terms
   are "fair-code" and "source-available." This applies to the README, docs, marketing copy,
   commit messages, and anything else written about the project.
2. **A CLA must be in place before merging any external PR.** Without it we lose the right
   to relicense contributed code. This is a launch blocker for accepting contributions.

## Layout

```
packages/   # product packages (workspace — nothing real yet)
docs/       # public product documentation
.github/    # issue + PR templates
```

## Conventions

- Write for an outside reader who has no context on the project. Assume a stranger is
  reading every file.
- Documentation here is user- and contributor-facing. Design rationale and decision
  records live in the private repo, not here.
