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

# The published image may not exist yet (or not for this architecture), and
# `set -e` would abort the whole install on a failed pull. Fall back to
# building from this checkout so a fresh clone works today; the moment the
# image is published, the pull succeeds and the build is skipped.
if ! docker compose pull; then
  echo
  echo "Could not pull the published image — building it from this checkout instead."
  echo "(This is expected before the first release; it takes a few minutes.)"
  docker compose build
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
