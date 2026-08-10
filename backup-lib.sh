# shellcheck shell=bash
#
# Shared helpers for backup.sh (and restore.sh, which sources this same file).
#
# Sourced, never executed, so it deliberately has no shebang and is not
# executable — the `shell=bash` directive above is what tells shellcheck which
# dialect to check it as.
#
# Targets bash 3.2, the version macOS still ships: no associative arrays, no
# `mapfile`, no `${var^^}`. An operator restoring at 2am is not going to
# upgrade their shell first.
#
# Every `docker` invocation here is plain `docker compose` with no `-f`, so
# COMPOSE_FILE and COMPOSE_PROJECT_NAME work the way an operator (and the
# round-trip tests) expect.

# Service names as they appear in docker-compose.yml, named once so the two
# scripts cannot drift apart.
APP_SERVICE=lyraflow
CH_SERVICE=clickhouse
PG_SERVICE=postgres

# The application database and role in each store.
CH_DATABASE=lyraflow
PG_DATABASE=lyraflow
PG_USER=lyraflow

# Where the ClickHouse `backups` disk is mounted inside its container. Declared
# by docker/clickhouse/backup-disk.xml; see that file for why the disk lives
# inside the existing data volume and what that obliges this script to clean up.
CH_BACKUP_DIR=/var/lib/clickhouse/backups

# Set to 1 between `docker compose stop` and the restart. Read by
# start_app_if_stopped, which both the happy path and the EXIT trap call.
APP_STOPPED=0

# ---------------------------------------------------------------------------
# Failure reporting
# ---------------------------------------------------------------------------

# fail <step> <detail…>
#
# This script runs unattended at 4am and the log line is the only artefact of
# the failure, so it has to answer the two questions an operator has
# immediately: which step died, and whether their data is intact. A stack trace
# or a bare `Code: 598` answers neither.
#
# The "no data was changed" claim is true on every path because neither script
# path writes to either store: BACKUP, pg_dump and every count query are reads.
# The only thing written inside a container is the scratch archive on the
# ClickHouse backups disk, which is not data and which cleanup removes.
#
# Exits 1, which fires the EXIT trap — so the app is restarted after this
# prints, not before.
fail() {
  local step="$1"
  shift
  echo "" >&2
  echo "ERROR: the backup failed during the ${step} step." >&2
  local line
  for line in "$@"; do
    echo "  ${line}" >&2
  done
  echo "" >&2
  echo "No data was changed: this script only reads from ClickHouse and Postgres," >&2
  echo "so both stores still hold exactly what they held before it started." >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Store access
# ---------------------------------------------------------------------------

# ch_query <sql> [database]
#
# The ClickHouse password is already in the container's own environment
# (CLICKHOUSE_PASSWORD, which compose sets from .env). It is referenced INSIDE
# the single-quoted `sh -c` program, so the host shell never expands it and the
# secret never reaches the host's argv — `ps auxww` during a multi-second
# BACKUP shows the literal string "$CLICKHOUSE_PASSWORD" and nothing else.
# Do NOT interpolate "$CLICKHOUSE_PASSWORD" from the host here.
#
# The database argument exists because the normal binding to `lyraflow` is
# unusable at exactly the moments restore.sh needs a client: the HTTP/native
# session sets its current database on connect, and naming one that does not
# exist is itself an error (Code: 81, UNKNOWN_DATABASE) — which is the state
# the database is in between a DROP and its RESTORE. Pass `default` there.
#
# `< /dev/null` is load-bearing, not decoration: `docker compose exec -T`
# forwards the caller's stdin into the container, so a ch_query inside a
# `while read` loop eats the rest of the loop's input. Observed exactly once,
# with ch_row_counts reporting the first table and silently dropping the other
# four — a manifest that looks well-formed and describes a quarter of the
# database. Every exec below closes stdin for the same reason.
ch_query() {
  docker compose exec -T "$CH_SERVICE" sh -c \
    'clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
       --database "$1" --query "$0"' \
    "$1" "${2:-$CH_DATABASE}" < /dev/null
}

# pg_query <sql>
#
# Same argument as ch_query for the password: PGPASSWORD is assigned inside the
# single-quoted program from the container's own POSTGRES_PASSWORD, so it never
# appears in the host's process list. The official image's pg_hba grants `local
# all all trust`, so this would work without a password today — it is written
# this way so it keeps working against a hardened pg_hba rather than failing at
# 4am the day someone tightens it.
pg_query() {
  docker compose exec -T "$PG_SERVICE" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U "$1" -d "$2" -At -v ON_ERROR_STOP=1 -c "$0"' \
    "$1" "$PG_USER" "$PG_DATABASE" < /dev/null
}

# pg_dump_to <file>
#
# A redirect, not a pipe, so the exit status is pg_dump's own. `set -o pipefail`
# is set by the callers as a second line of defence, but the redirect is the
# first: a failed dump piped into anything still writes a perfectly valid
# archive of nothing.
#
# The redirect is what applies the caller's `umask 077` to the dump — see
# backup.sh's umask comment.
pg_dump_to() {
  local out="$1"
  docker compose exec -T "$PG_SERVICE" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$0" -d "$1" -Fc' \
    "$PG_USER" "$PG_DATABASE" < /dev/null > "$out"
}

# copy_ch_artefact_to <file>
#
# `docker compose exec … cat > file`, deliberately, and NOT `docker compose cp`.
# `cp` reproduces the mode the file has inside the container and ignores the
# caller's umask: measured on this branch, the same archive arrived as 0640 via
# `cp` and 0600 via this redirect, byte-for-byte identical otherwise. 0640 is
# whatever ClickHouse happened to choose, not what this script chose, and the
# archive contains the identity dictionaries' Postgres password — see
# backup.sh's umask comment. A redirect is the only form the umask applies to.
#
# A redirect, not a pipe, so the exit status is the copy's own.
copy_ch_artefact_to() {
  local out="$1"
  docker compose exec -T "$CH_SERVICE" cat "$CH_BACKUP_DIR/$CH_FILE" < /dev/null > "$out"
}

# ---------------------------------------------------------------------------
# Compose helpers
# ---------------------------------------------------------------------------

service_running() {
  docker compose ps --status running --services 2>/dev/null | grep -qx "$1"
}

# service_image <service> — the image reference the container was created from.
# Recorded in the manifest because "which images produced this backup" is the
# first thing a restore needs and the last thing anyone writes down. Read from
# the container rather than from `docker compose config --images`, which does
# not say which image belongs to which service, and works while the container
# is stopped, which is when the manifest is written.
service_image() {
  local cid
  cid="$(docker compose ps -aq "$1" 2>/dev/null | head -n 1)"
  if [ -z "$cid" ]; then
    echo "unknown"
    return 0
  fi
  docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null || echo "unknown"
}

# wait_until_stopped <service> <seconds>
#
# `docker compose stop` returning is not the same as the grace period having
# elapsed. The drain is the entire reason for quiescing, so poll rather than
# assume.
wait_until_stopped() {
  local i=0
  while [ "$i" -lt "$2" ]; do
    service_running "$1" || return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# wait_until_healthy <service> <seconds>
wait_until_healthy() {
  local cid i status
  cid="$(docker compose ps -aq "$1" 2>/dev/null | head -n 1)"
  [ -n "$cid" ] || return 1
  i=0
  while [ "$i" -lt "$2" ]; do
    status="$(docker inspect \
      --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
      "$cid" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy)
        return 0
        ;;
      none)
        # A service that declares no healthcheck cannot be probed this way, and
        # "running" is the strongest signal available for it.
        if service_running "$1"; then return 0; fi
        ;;
    esac
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# Idempotent on purpose: called on the happy path AND from the EXIT trap, and
# exactly one of them must do the work.
start_app_if_stopped() {
  [ "$APP_STOPPED" = "1" ] || return 0
  APP_STOPPED=0
  echo "Starting the app again..."
  if ! docker compose start "$APP_SERVICE" >/dev/null 2>&1; then
    echo "WARNING: could not restart the app. Run: docker compose start $APP_SERVICE" >&2
    return 0
  fi
  # `start` returns as soon as the container is running, which is not the same
  # as the app answering requests. Anything an operator runs straight after
  # this script — a smoke test, a monitoring probe, the round-trip test — would
  # otherwise hit a still-booting server and read it as a failed backup.
  if ! wait_until_healthy "$APP_SERVICE" 180; then
    echo "WARNING: the app was started but has not become healthy." >&2
    echo "Check: docker compose logs $APP_SERVICE" >&2
  fi
}

# The backups disk lives inside the ClickHouse data volume, so the scratch
# archive survives `docker compose down` and accumulates one full backup per
# night until the volume fills. Removing it is load-bearing, not tidiness.
remove_in_container_artefact() {
  [ -n "${CH_FILE:-}" ] || return 0
  docker compose exec -T "$CH_SERVICE" \
    rm -f "$CH_BACKUP_DIR/$CH_FILE" < /dev/null >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Checksums
# ---------------------------------------------------------------------------

# macOS ships `shasum`, not `sha256sum`, and this script is written for an
# operator on a Mac. Checked up front by backup.sh so a missing hasher is a
# validation failure rather than a failure after the app is already down.
have_sha256() {
  command -v sha256sum >/dev/null 2>&1 ||
    command -v shasum >/dev/null 2>&1 ||
    command -v openssl >/dev/null 2>&1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

# ---------------------------------------------------------------------------
# Row counts
# ---------------------------------------------------------------------------

# ch_count_expression <engine>
#
# MEASURED, not assumed: a plain `count()` is NOT stable across BACKUP and
# RESTORE, and not because of a race. RESTORE writes the restored data as fresh
# parts, and the merging engines collapse rows sharing a sorting key as it does
# so. Reproduced twice on this branch, with the app stopped and nothing
# ingesting:
#
#   device_index   count() 23 -> 7   (AggregatingMergeTree, 6 parts -> 2)
#   person_traits  count() 12 -> 4   (AggregatingMergeTree)
#   device_index   count() 12 -> 3   (second run)
#   event_schema   count()  8 -> 4   (ReplacingMergeTree)
#
# `count() … FINAL` applies the engine's merge logic at read time, so it
# reports the fully-merged count — a property of the data rather than of the
# current part layout — and it matched on both sides of every BACKUP/RESTORE
# measured. That is the merge-stable expression, recorded per table in the
# manifest as `rowexpr.clickhouse.<table>` so restore.sh compares like with
# like instead of applying a tolerance.
#
# FINAL is not usable everywhere: `SELECT count() FROM events_dead_letter
# FINAL` is rejected with `Code: 181 … Storage MergeTree doesn't support FINAL
# (ILLEGAL_FINAL)`. That is fine, because a plain MergeTree never collapses
# rows on merge, so its `count()` is already stable — 30 -> 30 across every
# restore measured. Hence the split below, by property rather than by table
# name: anything ending in MergeTree that is not the plain or plain-replicated
# engine collapses on merge and needs FINAL.
ch_count_expression() {
  case "$1" in
    MergeTree | ReplicatedMergeTree) echo 'count()' ;;
    *MergeTree) echo 'count() FINAL' ;;
    *) echo 'count()' ;;
  esac
}

# Emits `rows.clickhouse.<table>=<n>` and `rowexpr.clickhouse.<table>=<expr>`.
#
# The table list comes from system.tables rather than a hardcoded list, because
# a hardcoded list is a list that a future migration silently falls off. The
# three non-data engines are excluded by name and everything else is counted:
# excluding known non-tables fails towards counting a new engine, where
# including only known table engines would fail towards skipping one.
#
# Materialized views are excluded because they are not storage — every one of
# them has a TO target that is already counted, so counting them would
# double-count the same rows. Dictionaries are excluded because counting one
# forces a load from Postgres, which is neither a property of the ClickHouse
# backup nor something to trigger during a quiesce.
ch_row_counts() {
  local tables name engine expr suffix count
  tables="$(ch_query "
    SELECT name || '|' || engine FROM system.tables
    WHERE database = '$CH_DATABASE'
      AND engine NOT IN ('MaterializedView', 'View', 'Dictionary')
    ORDER BY name
  ")" || return 1
  [ -n "$tables" ] || return 1

  printf '%s\n' "$tables" | while IFS='|' read -r name engine; do
    [ -n "$name" ] || continue
    expr="$(ch_count_expression "$engine")"
    suffix=''
    case "$expr" in *FINAL) suffix=' FINAL' ;; esac
    # The `%s` below are printf placeholders, not shell expansions, and the
    # single quotes are what stop the backticks — ClickHouse's identifier
    # quoting — from being read as command substitution.
    # shellcheck disable=SC2016
    count="$(ch_query "$(printf 'SELECT count() FROM `%s`%s' "$name" "$suffix")")" || exit 1
    [ -n "$count" ] || exit 1
    printf 'rows.clickhouse.%s=%s\n' "$name" "$count"
    printf 'rowexpr.clickhouse.%s=%s\n' "$name" "$expr"
  done
}

# Emits `rows.postgres.<table>=<n>`.
#
# One statement rather than one round trip per table, so every count comes from
# a single snapshot and the numbers in the manifest are mutually consistent.
# `query_to_xml` is the standard way to count a dynamically-named relation from
# plain SQL; it is core Postgres, and the image is pinned by this repo's own
# compose file.
#
# Views are excluded (`table_type = 'BASE TABLE'`): each identity dictionary's
# source view — identity_bindings_dict_src and friends — is a windowed
# projection of a table already counted here, so counting it would both
# double-count and record a number that is a function of the wall clock.
#
# Postgres rows are always a plain `count(*)`: nothing in Postgres collapses
# rows on its own, so there is no per-table `rowexpr.postgres.*` key.
pg_row_counts() {
  pg_query "
    SELECT 'rows.postgres.' || table_name || '=' ||
           (xpath('/row/c/text()',
                  query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name),
                               false, true, '')))[1]::text
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  "
}

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

# write_manifest <out-dir>
#
# Plain `key=value` lines, sorted, so `diff` between two manifests reads
# cleanly. Values are never quoted; a parser splits on the first `=` (the
# `rowexpr.*` values contain spaces and parentheses, nothing else does).
#
# Both checksums are taken from the bytes in <out-dir>, never from the
# in-container archive: restore.sh has to be able to catch an artefact that was
# truncated on its way out, while the live data still exists, and a checksum of
# anything other than the file on disk cannot do that.
write_manifest() {
  local out="$1"
  local schema_version app_image ch_image pg_image ch_sum pg_sum

  schema_version="$(pg_query 'SELECT max(version) FROM schema_migrations')" || return 1
  [ -n "$schema_version" ] || return 1
  app_image="$(service_image "$APP_SERVICE")"
  ch_image="$(service_image "$CH_SERVICE")"
  pg_image="$(service_image "$PG_SERVICE")"
  ch_sum="$(sha256_of "$out/clickhouse.zip")" || return 1
  pg_sum="$(sha256_of "$out/postgres.dump")" || return 1
  [ -n "$ch_sum" ] && [ -n "$pg_sum" ] || return 1

  {
    printf 'lyraflow_backup_version=1\n'
    printf 'timestamp=%s\n' "$STAMP"
    printf 'mode=quiesced\n'
    printf 'schema_version=%s\n' "$schema_version"
    printf 'app_image=%s\n' "$app_image"
    printf 'clickhouse_image=%s\n' "$ch_image"
    printf 'postgres_image=%s\n' "$pg_image"
    printf 'clickhouse_sha256=%s\n' "$ch_sum"
    printf 'postgres_sha256=%s\n' "$pg_sum"
    ch_row_counts || exit 1
    pg_row_counts || exit 1
  } | LC_ALL=C sort > "$out/MANIFEST"
}
