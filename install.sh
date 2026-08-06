#!/usr/bin/env sh
set -eu

if [ -f .env ]; then
  echo ".env already exists — leaving it alone."
else
  echo "Generating .env with fresh passwords..."
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
    printf 'CLICKHOUSE_PASSWORD=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  } > .env
  chmod 600 .env
fi

docker compose pull
docker compose up -d

echo
echo "Lyraflow is starting. Waiting for it to become ready..."
i=0
while [ "$i" -lt 60 ]; do
  if curl -fsS http://localhost:3000/ready >/dev/null 2>&1; then
    echo "Ready. Open http://localhost:3000 to create your first project."
    exit 0
  fi
  i=$((i + 1))
  sleep 2
done

echo "Timed out waiting for readiness. Check: docker compose logs lyraflow" >&2
exit 1
