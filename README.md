# Lyraflow

**Self-hosted, end-to-end customer journey intelligence and analytics.**

Lyraflow helps you understand the full path your customers take — from first touch to conversion, retention, and beyond — on infrastructure you control. Your customer data stays yours.

> ⚠️ **Early days.** Lyraflow currently ships the ingest spine — you can self-host it, send events, and query them, but there is no UI yet (filtering, journeys, dashboards). Watch the repo to follow along.

## Why Lyraflow?

- **Self-hosted first.** Run it on your own servers. No data leaves your infrastructure.
- **End-to-end journeys.** Not just page views — the entire customer lifecycle across touchpoints.
- **Source-available.** Distributed [fair-code](https://faircode.io) under the [Sustainable Use License](LICENSE.md): free to use, self-host, and modify for internal business purposes.

## License

Lyraflow is [fair-code](https://faircode.io) distributed under the [Sustainable Use License](LICENSE.md).

- Source is always visible
- Free to self-host and use for internal business purposes
- Extensible and modifiable

Note: this is a source-available license, not an [OSI-approved open source](https://opensource.org/osd) license. The practical difference: you may not offer Lyraflow as a paid hosted service to third parties.

## Repository layout

```
packages/   # product packages (workspace)
docs/       # product documentation
```

## Running Lyraflow

Requires Docker and Docker Compose.

```sh
git clone https://github.com/lyraflow/lyraflow.git
cd lyraflow
./install.sh
```

The script generates passwords into `.env`, starts the stack, and waits for
readiness. Then create a project and get your write key:

```sh
docker compose exec lyraflow node packages/cli/dist/index.js create-project "My App"
```

### Upgrading

```sh
docker compose pull
docker compose down
docker compose up -d
```

Migrations run automatically on boot, and accepted events are flushed before
shutdown, so no events are lost across an upgrade.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We'd love your help once the foundation is in place.
