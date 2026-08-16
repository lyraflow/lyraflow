#!/usr/bin/env sh
set -eu

# Domain resolution, in order: positional argument, then the environment, then
# an interactive prompt. The prompt is skipped when stdin is not a terminal so
# that scripted and CI installs proceed in local mode rather than hanging on a
# read that will never be answered.
DOMAIN="${1:-${LYRAFLOW_DOMAIN:-}}"
if [ -z "$DOMAIN" ] && [ -t 0 ]; then
  printf 'Domain for this install, e.g. analytics.example.com\n'
  printf '(leave blank for a local trial on port 3000): '
  read -r DOMAIN || DOMAIN=''
fi

# What the .env governing this install already says. Read before anything is
# written, so it describes the stack that is running right now rather than the
# one this run is about to configure. Two later decisions depend on it.
CONFIGURED_DOMAIN=''
if [ -f .env ]; then
  CONFIGURED_DOMAIN="$(sed -n 's/^LYRAFLOW_DOMAIN=//p' .env | tr -d '\r' | head -n 1)"
fi

# Fail before writing anything if the ports Caddy needs are taken. The failure
# mode otherwise is a container that will not start, reported several steps
# later and attributed to the wrong thing. Best-effort: `ss` is Linux-only, and
# no check at all is better than refusing to install on a machine that lacks it.
#
# Skipped when .env already names this same domain, because then the listener
# on 80 is this install's own Caddy and refusing is wrong: `./install.sh
# <domain>` is the only command the README gives for enabling TLS, and re-running
# it -- to pick up a new image, or after editing tls.d -- must not be an error.
# A *different* domain still checks, and so does a first install: those are the
# case the guard was written for, some other service already holding the port.
if [ -n "$DOMAIN" ] && [ "$DOMAIN" != "$CONFIGURED_DOMAIN" ] && command -v ss >/dev/null 2>&1; then
  for port in 80 443; do
    if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
      echo "Port $port is already in use, and serving $DOMAIN needs it." >&2
      echo "Stop whatever holds it, or leave the domain blank to install on port 3000 only." >&2
      exit 1
    fi
  done
fi

if [ -f .env ]; then
  echo ".env already exists — leaving its existing values alone."
else
  echo "Generating .env with fresh passwords..."
  # umask before the redirect, not chmod after: chmod-after leaves a window
  # where .env is created with the default (often world-readable) mode and
  # briefly holds real passwords before permissions are tightened.
  ( umask 077
    {
      printf 'POSTGRES_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
      printf 'CLICKHOUSE_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
      printf 'LYRAFLOW_ADMIN_EMAIL=%s\n' "admin@localhost"
      printf 'LYRAFLOW_ADMIN_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    } > .env
  )
fi

# Append only what is absent. Never rewrite a value that is already there:
# this file holds the only copy of the database passwords, and an install
# re-run must not be able to strand a stack from its own data.
if [ -n "$DOMAIN" ]; then
  add_setting() {
    if grep -q "^$1=" .env 2>/dev/null; then
      echo "  $1 is already set in .env — keeping it."
    else
      printf '%s=%s\n' "$1" "$2" >> .env
    fi
  }
  echo "Configuring TLS for $DOMAIN..."
  add_setting LYRAFLOW_DOMAIN "$DOMAIN"
  # In .env rather than exported: Compose reads COMPOSE_PROFILES from this
  # file on every later command, so `docker compose down` stops Caddy too. As
  # a shell export it would apply to this run only, and the next `down` would
  # leave Caddy holding 443 while the following `up` failed for reasons
  # nothing on screen would explain.
  add_setting COMPOSE_PROFILES tls
  # Caddy is the only way in; the app does not need a public port. Loopback
  # rather than no publication at all, so `curl` on the box still answers the
  # question "is this Caddy's problem or the app's?".
  add_setting LYRAFLOW_PUBLISH 127.0.0.1:3000:3000
fi

# Postgres and ClickHouse always exist upstream, so pull them normally — their
# progress output is worth seeing on a slow connection.
docker compose pull clickhouse postgres

# The Lyraflow image may not be published yet (or not for this architecture),
# and `set -e` would abort the install on a failed pull. Attempt it quietly:
# a registry "denied" here is the expected case before the first release, and
# the daemon prints ~25 lines of retries that look alarming for something that
# is about to work fine. Fall back to building from this checkout. The moment
# the image is published, the pull succeeds and the build is skipped.
echo "Fetching the Lyraflow image..."
if docker compose pull lyraflow >/dev/null 2>&1; then
  echo "Pulled the published image."
else
  echo "No published image yet — building from this checkout instead."
  echo "(Expected before the first release. The first build takes a few minutes.)"
  docker compose build lyraflow
fi

# `--wait` blocks on the healthchecks the compose file already declares, which
# is the same question the old hand-rolled curl loop asked and works in both
# modes -- in domain mode there is no host port on 3000 to poll.
echo
echo "Starting Lyraflow..."
if ! docker compose up -d --wait; then
  echo >&2
  echo "Startup failed: a container did not become healthy in time." >&2
  # Caddy depends on Lyraflow's own healthcheck passing before it even
  # starts, so this is never wrong-looking: if Caddy is the one that broke,
  # its status here is neither empty nor "(healthy)"; if something else
  # broke, Caddy either never started (empty status) or is fine (healthy),
  # and this stays quiet instead of pointing at the wrong log.
  CADDY_STATUS="$(docker compose ps caddy --format '{{.Status}}' 2>/dev/null)" || CADDY_STATUS=''
  case "$CADDY_STATUS" in
    '' | *'(healthy)') ;;
    *)
      echo "Caddy: $CADDY_STATUS" >&2
      echo "Its recent log -- a typo in a file under docker/caddy/tls.d/ is" >&2
      echo "the usual cause:" >&2
      docker compose logs --tail=20 caddy >&2 || true
      echo >&2
      ;;
  esac
  echo "Full logs:" >&2
  echo "  docker compose logs" >&2
  exit 1
fi

# The domain the running stack actually serves, which is what every URL printed
# below has to be built from. .env wins over this invocation because add_setting
# above never overwrites it: on an existing TLS install, `./install.sh` with no
# argument at all must still say https://<that domain>. Deriving from "$DOMAIN"
# printed http://localhost:3000 there, and a snippet built from it is blocked as
# mixed content on the very page it was meant for.
EFFECTIVE_DOMAIN="${CONFIGURED_DOMAIN:-$DOMAIN}"

if [ -n "$EFFECTIVE_DOMAIN" ]; then
  HOST="https://$EFFECTIVE_DOMAIN"
  echo
  echo "Checking $HOST/ready ..."
  # A warning, never a failure. DNS propagation, firewall rules and a
  # certificate that has not been issued yet are all outside this script's
  # control, and all of them resolve on their own within minutes. Exiting
  # non-zero here would leave a correct install looking broken.
  if curl -fsS --max-time 10 "$HOST/ready" >/dev/null 2>&1; then
    echo "Answering over HTTPS."
  else
    echo "Not answering yet. The containers are up. Usually that is DNS or a"
    echo "certificate still being issued, and it clears on its own within"
    echo "minutes. It can also be a Caddy configuration error -- a file added"
    echo "under docker/caddy/tls.d/ is the usual source. The logs say which:"
    echo "  docker compose logs -f caddy"
  fi
else
  HOST="http://localhost:3000"
fi

# Read back rather than assumed: on an install whose .env predates the admin
# account, these are both empty, and that is the one case worth saying
# something different for -- printing a blank password would look like a bug,
# not like the upgrade note it actually is. Only ever read here, never
# written: this script writes LYRAFLOW_ADMIN_PASSWORD exactly once, above,
# and printing it is the only way an operator who never opens .env finds out
# it exists at all.
ADMIN_EMAIL="$(sed -n 's/^LYRAFLOW_ADMIN_EMAIL=//p' .env | tr -d '\r' | head -n 1)"
ADMIN_PASSWORD="$(sed -n 's/^LYRAFLOW_ADMIN_PASSWORD=//p' .env | tr -d '\r' | head -n 1)"

echo
echo "Lyraflow is running. Create your first project:"
echo "  docker compose exec lyraflow node packages/cli/dist/index.js create-project \"My App\""
echo
echo "Then get your snippet:"
echo "  docker compose exec -e LYRAFLOW_HOST=$HOST \\"
echo "    -e LYRAFLOW_SERVER_KEY=sk_... \\"
echo "    lyraflow node packages/cli/dist/index.js snippet"
echo
if [ -n "$ADMIN_PASSWORD" ]; then
  echo "Admin login, at $HOST:"
  echo "  email:    $ADMIN_EMAIL"
  echo "  password: $ADMIN_PASSWORD"
  echo "This is printed once. Change it with:"
  echo "  docker compose exec lyraflow node packages/cli/dist/index.js set-admin-password $ADMIN_EMAIL"
else
  echo "This install predates the admin account, so .env has no"
  echo "LYRAFLOW_ADMIN_PASSWORD and there is nothing to log in with yet. Set one:"
  echo "  echo 'your-new-password' | docker compose exec -T lyraflow \\"
  echo "    node packages/cli/dist/index.js set-admin-password admin@localhost"
fi
