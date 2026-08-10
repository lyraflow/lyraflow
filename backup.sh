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
# and still has the default mode.
#
# This has to be a top-level statement, not a call, and it has to come before
# the first `mkdir` and the first redirect. A `harden_file_mode() { umask 077; }`
# defined here and called later satisfies a reading of "the umask comes first"
# while `mkdir "$OUT"` has already run unprotected.
#
# Every file below is created by exactly one function, `artefact_write` in
# backup-lib.sh, which is a single `cat > "$1"` under this umask. See its
# comment for why one chokepoint replaced a list of banned spellings.
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
OUT_CREATED=0
BACKUP_COMPLETE=0

# THE RESTART COMES FIRST, and nothing above it may be able to abort this
# function.
#
# Three review rounds found three different ways for the app to be left stopped,
# all of them in this path, and the third was that `remove_incomplete_output`
# ended in a bare `rm -rf "$OUT"`: on a destination that had gone read-only --
# which is what ext4 does on an I/O error -- `set -e` aborted the trap before
# the restart, with no retry, no exit-1 diagnostic and not even the "app is
# stopped" text. Constructed and observed, exit code 1 with the container
# `Exited (0)` and "Starting the app again..." never printed.
#
# Fixing them one at a time was losing. The invariant now is structural: the
# restart is the first statement, so no tidy-up can pre-empt it; and every
# tidy-up is individually incapable of returning non-zero anyway, so neither the
# ordering nor the error handling is load-bearing on its own. Anything added to
# this function must go BELOW the restart and must not be able to fail.
cleanup() {
  local restart_ok=1
  # The RETRY. start_app_if_stopped leaves APP_STOPPED set when it fails, so a
  # restart that failed on the happy path is attempted once more here -- which
  # is what recovers the case where a deferred Ctrl-C lands on the restart and
  # nothing else. It is a no-op when the app is already back.
  start_app_if_stopped || restart_ok=0

  remove_in_container_artefact || true
  remove_incomplete_output || true

  # If the app is still not back, this script must NOT report success. Exiting
  # from the EXIT trap overrides a zero status (verified), which is the only
  # way to turn "the backup worked but the site is dark" into something a cron
  # wrapper testing $? can see.
  if [ "$restart_ok" = "0" ]; then
    echo "" >&2
    echo "ERROR: the app is stopped and this script could not start it." >&2
    echo "  Run: docker compose start $APP_SERVICE" >&2
    echo "Any backup reported above is complete and valid -- the problem is the app," >&2
    echo "which is down and will stay down until someone starts it." >&2
    exit 1
  fi
}
trap cleanup EXIT

# --------------------------------------------------------------------------
# Validation first, and all of it, because everything after the quiesce is
# downtime. Discovering a typo in the destination after the app is down turns
# a mistake into an outage.
# --------------------------------------------------------------------------

# All three services, not just the app. The consistency claim rests on THIS
# script being the one that stopped the writer: an app that is already down for
# some other reason is not a quiesced system, it is an unknown one, and the
# manifest would still say mode=quiesced. ClickHouse and Postgres are checked
# for the duller reason that finding them missing after the quiesce would be
# pure downtime.
#
# FIRST of the checks, because everything below talks to one of these
# containers and would otherwise report a confusing second-order symptom. With
# the stack down, the Postgres probe below reports "could not run the
# row-count query ... needs query_to_xml", which sends an operator hunting for
# a libxml problem they do not have.
for service in "$APP_SERVICE" "$CH_SERVICE" "$PG_SERVICE"; do
  service_running "$service" ||
    fail "validation" \
      "The '$service' service is not running; there is nothing to back up consistently." \
      "Start the stack first: docker compose up -d"
done

pg_can_count_rows ||
  fail "validation" \
    "Could not run the manifest's row-count query against Postgres." \
    "It needs query_to_xml -- core Postgres, but only in a build with libxml --" \
    "and a working psql login. Checked here rather than at manifest time, so" \
    "this is a refusal instead of downtime followed by a failed backup."

have_sha256 ||
  fail "validation" \
    "No SHA-256 tool found (looked for sha256sum, shasum and openssl)." \
    "The manifest records a checksum per artefact so restore.sh can refuse a" \
    "truncated one; without a hasher there is nothing to record."

# Last, so a failure above leaves nothing behind on disk.
mkdir -p "$DEST" 2>/dev/null ||
  fail "destination" \
    "Could not create the destination directory: $DEST" \
    "Check that the path exists, is a directory, and is writable."

# A non-recursive `mkdir`, deliberately: it is atomic, and it fails when the
# directory already exists. A `[ -e ]` test followed by `mkdir -p` is neither,
# and two runs launched inside that window would both believe they had created
# the directory -- so the one that lost would delete the winner's backup on its
# way out. Exactly the same shape as the archive-name race, and fixed the same
# way: exactly one run can win, and only the winner sets OUT_CREATED.
mkdir "$OUT" 2>/dev/null ||
  fail "destination" \
    "Could not create $OUT" \
    "Either it already exists -- another backup started in the same second, or a" \
    "previous run left it behind -- or the destination is not writable."
OUT_CREATED=1

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
# Flag first, command second. `docker compose stop` can stop the container and
# still exit non-zero -- Ctrl-C during the drain exits 130 with the container
# already down -- and under `set -e` that kills this script before any
# assignment placed after it could run, leaving the EXIT trap with nothing to
# restore. See APP_STOPPED in backup-lib.sh for the measurement. Setting it
# early costs nothing: `docker compose start` against a container that is still
# running is a no-op that does not even move StartedAt.
APP_STOPPED=1
docker compose stop "$APP_SERVICE" >/dev/null ||
  fail "quiesce" \
    "docker compose stop $APP_SERVICE exited non-zero." \
    "The app may or may not have stopped; it is being started again either way."

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

# Only now is the archive ours to delete. Marking it before the BACKUP would
# make the run that loses a same-second race clean up the winner's archive.
CH_ARTEFACT_CREATED=1

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
    "Could not write the manifest for $OUT." \
    "The partial backup is being deleted rather than left looking complete." \
    "Run the backup again."

# From here the directory holds a complete, described backup, so the trap must
# stop treating it as debris. Nothing below may fail in a way that invalidates
# the artefacts -- restarting the app does not.
BACKUP_COMPLETE=1

remove_in_container_artefact
# `|| true` because the EXIT trap retries and owns the decision: a restart that
# fails here must not abort before the operator is told where their backup is,
# and must not be reported as success either. The trap does both.
start_app_if_stopped || true

echo "Backup written to $OUT"
