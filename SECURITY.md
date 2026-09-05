# Security policy

## Reporting a vulnerability

**Email `hello@lyraflow.app` with `security` in the subject line. Please do not
open a public issue.**

Filing a vulnerability in a public tracker publishes it to everyone running
Lyraflow before there is anything for them to upgrade to. Lyraflow is
self-hosted, so those people cannot be patched centrally — they each have to
pull a new image, and until they do, the report is a set of instructions for
attacking them.

Include, as far as you have it:

- the version — the Settings screen's Install card shows it, and it is what
  [`GET /v1/meta`](README.md#get-v1meta) returns;
- what you did, in enough detail to reproduce;
- what happened, and what you expected;
- what an attacker gets out of it.

A proof of concept is welcome and is not required. A clear description of the
flaw is more useful than a working exploit.

## What to expect

Lyraflow is built by one person. That shapes everything below, and saying so is
more useful than a policy nobody is behind:

- **You will get a reply.** Usually within a few days.
- **There is no bug bounty**, and no payment of any kind.
- **There is no formal disclosure timetable.** Inventing "90 days" here would be
  a number with nothing behind it. What you will get instead is an honest
  estimate once the report has been read, and an update when the fix ships.
- **You will be credited in the release notes if you want to be**, under whatever
  name you give, and not at all if you would rather not.

Please give a reasonable window before publishing. If you have a deadline, say
so in the first message rather than at the end of it.

## Supported versions

| Version | Supported |
| --- | --- |
| the latest release | yes |
| anything older | no |

Lyraflow is `v0.x` and every release so far has been a minor version — there
have been no patch releases and **there are no backports**. A security fix ships
in the next release, and upgrading to it is the remedy. See
[Upgrading](README.md#upgrading); it is `docker compose pull` and a restart, and
migrations run on boot.

If that is a problem for your deployment, say so in the report. It is a real
constraint of a project this size rather than a preference, but knowing it is
biting someone is worth hearing.

## In scope

The server, the web UI, the CLI, the browser SDK, `install.sh`, `backup.sh` and
`restore.sh`, the published Docker images, and the workflows in `.github/`.

## Out of scope, because they are documented behaviour

These are real limits, they are written down with the reasoning attached, and
they are not vulnerabilities. Reporting one costs you time and tells us nothing
we have not already published:

- **The ingest write key ships in browser source, by design.** It is a
  publishable credential. The CORS origin allowlist and the bot filter narrow
  what reaches your data, and neither is access control — the README says so at
  [Sending events from a browser](README.md#sending-events-from-a-browser) and
  again under bot filtering.
- **A shared dashboard link is the whole credential.** No password, no expiry,
  no view count. It names one dashboard, every query is built from what is
  stored on the server, and revoking it makes the next request a 404. See
  [Sharing a dashboard](README.md#sharing-a-dashboard).
- **No page sends a frame header**, so a shared dashboard can be framed by
  another site. That gap is stated in the same section rather than solved.
- **There is no rate limit on ingest.** Per-project monthly quotas bound the
  cost of a key that leaks; rate limiting belongs at your proxy or CDN, which
  [Operations](README.md#operations) says explicitly.
- **Anything about how you deployed it.** Your reverse proxy, your TLS
  configuration, your host, your firewall, your database passwords. Lyraflow is
  software you run; the deployment is yours. A bug in the bundled Caddy
  configuration or in `install.sh` *is* in scope — a bug in the proxy you put in
  front of it is not.
- **Scanner output with no demonstrated impact.** A header grade, a TLS cipher
  list or a dependency CVE that nothing in Lyraflow reaches is not a report yet.
  Show what it does here.

If you think one of these is worse than the documentation claims, that is exactly
the report to send. "This is documented" is an explanation, not a dismissal.

## Not a vulnerability?

Ordinary bugs, missing features and unclear documentation go in the
[issue tracker](../../issues), in public, where the answer helps the next person
who hits it. See [CONTRIBUTING.md](CONTRIBUTING.md).
