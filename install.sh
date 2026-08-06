#!/usr/bin/env sh
set -eu

if [ -f .env ]; then
  echo ".env already exists — leaving it alone."
else
  echo "Generating .env with fresh passwords..."
  # umask before the redirect, not chmod after: chmod-after leaves a window
  # where .env is created with the default (often world-readable) mode and
  # briefly holds real passwords before permissions are tightened.
  ( umask 077
    {
      printf 'POSTGRES_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
      printf 'CLICKHOUSE_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    } > .env
  )
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

docker compose up -d

echo
echo "Lyraflow is starting. Waiting for it to become ready..."
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS http://localhost:3000/ready >/dev/null 2>&1; then
    echo "Ready. Create your first project:"
    echo "  docker compose exec lyraflow node packages/cli/dist/index.js create-project \"My App\""
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "Timed out waiting for readiness. Check: docker compose logs lyraflow" >&2
exit 1
