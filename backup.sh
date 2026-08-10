#!/usr/bin/env bash
# Take a consistent backup of both Lyraflow data stores.
#
# bash rather than sh (install.sh uses sh) for two reasons: `set -o pipefail`,
# without which a failed dump piped into a compressor still exits 0 and writes
# a perfectly valid archive of nothing; and traps, which are how this script
# guarantees it never leaves the app stopped. Targets bash 3.2, so no
# associative arrays and no mapfile -- an operator restoring on a Mac at 2am
# is not going to upgrade their shell first.
#
# Runs plain `docker compose` with no -f, so COMPOSE_FILE and
# COMPOSE_PROJECT_NAME work the way an operator (and the round-trip test)
# expects.
set -euo pipefail

# TREAT EVERY FILE THIS SCRIPT WRITES AS A CREDENTIAL.
#
# The ClickHouse archive contains the three identity dictionaries, and a
# dictionary's on-disk DDL embeds the Postgres password it uses to read
# identity_bindings, person_aliases and suppressed_persons. `SHOW CREATE
# DICTIONARY` masks it as PASSWORD '[HIDDEN]', which is why this went unnoticed
# for so long, but the metadata inside the archive is unmasked. Three of the
# archive's entries carry it; nothing else in the backup is sensitive, and
# stripping them is not an option because the archive is a ClickHouse-managed
# zip that RESTORE has to read back intact.
#
# So the answer is file permissions. umask before anything is created, not
# chmod after: install.sh's .env comment has the reasoning -- a chmod afterwards
# leaves a window in which the file already exists, already holds the secret,
# and still has the default mode. Everything below is created by a redirect or
# by mkdir under this umask, which is also why the archive is copied out with
# `exec … cat >` rather than `docker compose cp` (see copy_ch_artefact_to).
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

usage() {
  cat >&2 <<'EOF'
Usage: ./backup.sh <destination-directory>

Stops the Lyraflow app container for about a minute, backs up ClickHouse and
Postgres, and starts it again. Ingest is refused while it runs; the browser
SDK queues and retries, so events are delayed rather than lost.

Writes <destination>/<timestamp>/{clickhouse.zip,postgres.dump,MANIFEST},
owner-readable only. The archive contains database credentials -- keep the
destination directory private and encrypt it before copying it off the host.
EOF
}

DEST="${1:-}"
case "$DEST" in
  -h | --help)
    usage
    exit 0
    ;;
esac
if [ -z "$DEST" ]; then
  usage
  exit 2
fi

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
OUT="$DEST/$STAMP"
CH_FILE="lyraflow-$STAMP.zip"

cleanup() {
  remove_in_container_artefact
  start_app_if_stopped
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Validation first, and all of it, because everything after the quiesce is
# downtime. Discovering a typo in the destination after the app is down turns
# a mistake into an outage.
# --------------------------------------------------------------------------

have_sha256 ||
  fail "validation" \
    "No SHA-256 tool found (looked for sha256sum, shasum and openssl)." \
    "The manifest records a checksum per artefact so restore.sh can refuse a" \
    "truncated one; without a hasher there is nothing to record."

# All three services, not just the app. The consistency claim rests on THIS
# script being the one that stopped the writer: an app that is already down for
# some other reason is not a quiesced system, it is an unknown one, and the
# manifest would still say mode=quiesced. ClickHouse and Postgres are checked
# for the duller reason that finding them missing after the quiesce would be
# pure downtime.
for service in "$APP_SERVICE" "$CH_SERVICE" "$PG_SERVICE"; do
  service_running "$service" ||
    fail "validation" \
      "The '$service' service is not running; there is nothing to back up consistently." \
      "Start the stack first: docker compose up -d"
done

# Last, so a failure above leaves nothing behind on disk.
if [ -e "$OUT" ]; then
  fail "destination" \
    "The destination directory already exists: $OUT" \
    "Another backup started in the same second, or a previous run left it behind." \
    "Move it aside and try again."
fi

mkdir -p "$OUT" 2>/dev/null ||
  fail "destination" \
    "Could not create the destination directory: $OUT" \
    "Check that the path exists, is a directory, and is writable."

[ -w "$OUT" ] ||
  fail "destination" \
    "The destination directory is not writable: $OUT"

# --------------------------------------------------------------------------
# Quiesce. Both stores are backed up with the writer stopped so the two
# artefacts describe the same instant -- an identity binding in the Postgres
# dump always has its events in the ClickHouse archive. BACKUP itself works
# fine with the app running; the quiesce buys cross-store consistency, not
# ClickHouse's cooperation.
# --------------------------------------------------------------------------

echo "Stopping the app so the ingest buffer drains (about 30 seconds)..."
docker compose stop "$APP_SERVICE" >/dev/null
APP_STOPPED=1

wait_until_stopped "$APP_SERVICE" 60 ||
  fail "quiesce" \
    "The app did not stop within 60s; refusing to back up mid-write."

echo "Backing up ClickHouse..."
ch_query "BACKUP DATABASE $CH_DATABASE TO Disk('backups', '$CH_FILE')" >/dev/null ||
  fail "ClickHouse" \
    "BACKUP DATABASE $CH_DATABASE failed; the ClickHouse error is above." \
    "If it is BACKUP_ALREADY_EXISTS, an artefact of the same name is already on" \
    "the backups disk -- from a run that died before it could clean up, or from" \
    "a second backup started in the same second."

copy_ch_artefact_to "$OUT/clickhouse.zip" ||
  fail "ClickHouse" \
    "Could not copy the archive out of the container to $OUT/clickhouse.zip."

echo "Backing up Postgres..."
pg_dump_to "$OUT/postgres.dump" ||
  fail "Postgres" \
    "pg_dump failed; its error is above."

echo "Writing the manifest..."
write_manifest "$OUT" ||
  fail "manifest" \
    "Could not write $OUT/MANIFEST." \
    "The two artefacts were written but are not described, so restore.sh will" \
    "refuse them. Delete $OUT and run the backup again."

remove_in_container_artefact
start_app_if_stopped

echo "Backup written to $OUT"
