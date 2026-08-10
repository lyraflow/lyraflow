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

# Set to 1 immediately BEFORE `docker compose stop`, not after it. Read by
# start_app_if_stopped, which both the happy path and the EXIT trap call.
#
# Before, because `docker compose stop` can stop the container and still exit
# non-zero — Ctrl-C during the 30-second drain exits 130 with the container
# already down. Setting the flag afterwards means that path never sets it, the
# trap sees 0, and the app is left stopped with nothing announcing it.
# Measured, with a shim that really stopped the container and then reported
# failure: `exited/unhealthy` immediately after the script and still
# `exited/unhealthy` 50 seconds later. Setting it early is free — M2 in the
# mutation set established that `docker compose start` against a running
# container is a no-op that does not even move `StartedAt`.
APP_STOPPED=0

# Set to 1 only once `BACKUP` has reported success, so cleanup removes an
# archive this run created and never one belonging to a concurrent run. See
# remove_in_container_artefact.
CH_ARTEFACT_CREATED=0

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

# say <text…>   progress, on stdout
# note <text…>  diagnostics, on stderr
#
# NEITHER CAN FAIL, and that is the whole point of them existing.
#
# `./backup.sh DEST | head -1` closes this script's stdout as soon as the
# reader has what it wants. A plain `echo` then dies of SIGPIPE, which killed
# the shell *inside the EXIT trap* -- before `docker compose start` -- leaving
# the app stopped, stderr completely silent, and the pipeline's status 0
# because that is `head`'s. Measured before the fix:
#
#   PIPESTATUS=141 head=0        <- 141 = 128 + SIGPIPE
#   lyraflow-ci-lyraflow-1  exited  Exited (0)
#   --- full stderr of that run ---   (nothing but docker's own two lines)
#
# `trap '' PIPE` in backup.sh turns the signal into a write error; the
# `|| true` here turns the write error into nothing at all. Both are needed:
# the trap alone leaves `echo` returning non-zero, which `set -e` turns into
# the same aborted-cleanup outcome by a different route.
#
# Reachable by `| less` and pressing q, by `| head -n N` in a wrapper capping a
# log, by `| grep -m1`, and by `| mail` or `| logger` where the reader dies.
# Note a closed stdout does NOT abandon the backup: a wrapper that caps its log
# asked for a shorter log, not for an unfinished backup.
#
# The `2>/dev/null` suppresses bash's own "echo: write error: Broken pipe"
# diagnostic, which otherwise replaces the message the reader did not want with
# a noisier one it also did not want. Redirections apply left to right, so
# note()'s fd1 is the real stderr before fd2 is discarded.
say() { echo "$@" 2>/dev/null || true; }
note() { echo "$@" >&2 2>/dev/null || true; }

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
  note ""
  note "ERROR: the backup failed during the ${step} step."
  local line
  for line in "$@"; do
    note "  ${line}"
  done
  note ""
  note "No data was changed: this script only reads from ClickHouse and Postgres,"
  note "so both stores still hold exactly what they held before it started."
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

# artefact_write <path> — THE ONLY PLACE IN EITHER SCRIPT THAT CREATES A FILE
# BY WRITING TO IT.
#
# The qualifier is not pedantry. `mv "$tmp" "$out/MANIFEST"` also brings a path
# into existence; it is safe because it renames a file this function already
# created, carrying that mode with it, and it is deliberately the only other
# way any path here appears. An absolute claim in this header would be false,
# and E3 below is what a false absolute costs.
#
# Reads stdin, writes <path>. Every artefact goes through here, which is what
# makes "created at 0600 by the process umask, never widened, never staged
# through anything looser" a property of one auditable line instead of a claim
# about the whole codebase.
#
# KNOWN LIMITATION (E3). The chokepoint is enforced by two audits — one static
# rule that this is the only data redirect, one runtime allow-list of the
# commands that actually run — and a *simplification* slips between them:
# replacing `| artefact_write "$tmp"` with `sort -o "$tmp"` creates the file
# with no redirect at all, using an already-allow-listed command, on a covered
# path. The mode stays 0600 because the umask still applies, so there is no
# security regression today; what is lost is the invariant, silently. Closing
# it needs an assertion on how many times artefact_write is *invoked* per run,
# which is left undone deliberately rather than unnoticed.
#
# This shape exists because two rounds of banning spellings lost. First `chmod`
# was banned, so the next attempt used `install -m 600`; that was banned too, so
# the next used `docker compose cp` into a scratch file and then `cat` that
# scratch through the umask into the real destination -- no chmod, no install,
# one correctly placed `umask 077`, both permission tests green, and a scratch
# file holding the plaintext Postgres password sitting at 0640 for the length of
# the copy. You cannot win a spelling war against file creation; you can only
# reduce the number of places it happens to one and audit that.
#
# The test enforces the chokepoint rather than the vocabulary: exactly one data
# redirect in either script and it is the one below, plus an allow-list of the
# external commands these scripts may invoke at all, so a new way to make a file
# cannot be introduced without failing a test whatever it is spelled.
#
# `cat` and not `cp`/`install`/`dd`: the caller supplies bytes on a pipe, so
# there is no source file whose mode could be copied along with them.
artefact_write() {
  cat > "$1"
}

pg_dump_to() {
  # A pipe, not a redirect. `set -o pipefail` is what makes the exit status
  # still pg_dump's -- verified by the tests that inject a pg_dump failure and
  # require the run to fail and leave nothing behind. restore.sh must set
  # pipefail too if it uses this.
  docker compose exec -T "$PG_SERVICE" sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U "$0" -d "$1" -Fc' \
    "$PG_USER" "$PG_DATABASE" < /dev/null | artefact_write "$1"
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
# A pipe into the chokepoint, as pg_dump_to is: `set -o pipefail` is what keeps
# the exit status the copy's own, and restore.sh must set it too.
copy_ch_artefact_to() {
  docker compose exec -T "$CH_SERVICE" cat "$CH_BACKUP_DIR/$CH_FILE" < /dev/null |
    artefact_write "$1"
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

# Brings the app back, and reports whether it is actually back.
#
# Returns 0 only when the app is running AND healthy. APP_STOPPED is cleared at
# that point and not one statement earlier, which is the whole design: the EXIT
# trap calls this too, so leaving the flag set is what makes a failed attempt
# get RETRIED rather than silently abandoned.
#
# Clearing the flag first — as this did — produced the exact mirror image of the
# bug that put it before `docker compose stop`. A failed `start` cleared the
# flag, warned, and returned 0; the trap then saw 0 and did nothing; and the
# script printed "Backup written to …" and exited 0 with the app down. Measured
# with a shim failing only `compose start lyraflow`:
#
#   Starting the app again...
#   WARNING: could not restart the app. …
#   Backup written to /tmp/probe-…/2026-08-10T150922Z
#   backup.sh EXIT CODE = 0
#   lyraflow    exited  Exited (0) 2 seconds ago
#
# That is worse than the bug it mirrors, which at least exited non-zero: a cron
# wrapper testing $? saw success while the site went uninstrumented.
#
# It is reachable by the operator action this script's own comments name. bash
# DEFERS SIGINT while a foreground `docker compose` child is running, so Ctrl-C
# during the drain does not interrupt the stop — it is delivered to a later
# `docker compose` invocation. When that is the restart, the restart dies with
# 130 while every other command in the run succeeded. Reproduced here with a
# logging shim, where the deferred signal landed on a manifest query instead:
#
#   rc=0    compose exec -T postgres … pg_dump …
#   rc=130  compose exec -T clickhouse … SELECT count() FROM `events` FINAL
#   rc=0    compose start lyraflow
#
# A manual `docker compose start` seconds later returns 0, so one retry from the
# trap recovers it — which is exactly what leaving the flag set now buys.
start_app_if_stopped() {
  [ "$APP_STOPPED" = "1" ] || return 0
  # The start comes before ANY write, including the one announcing it. The
  # announcement used to be the first statement, and on a closed stdout that
  # single `echo` was enough to kill the shell inside the trap before the app
  # was ever started -- the fourth consecutive round in which the ordering of
  # this function was the defect. `say`/`note` cannot fail either, so neither
  # the ordering nor the write-safety is load-bearing on its own.
  if ! docker compose start "$APP_SERVICE" >/dev/null 2>&1; then
    note "WARNING: 'docker compose start $APP_SERVICE' failed; it will be retried."
    return 1
  fi
  say "Starting the app again..."
  # `start` returns as soon as the container is running, which is not the same
  # as the app answering requests. Anything an operator runs straight after
  # this script — a smoke test, a monitoring probe, the round-trip test — would
  # otherwise hit a still-booting server and read it as a failed backup.
  #
  # A health timeout is also a failure, not a warning: "the container is up but
  # the app never came back" is the same outcome for the site as "the container
  # never started", and the caller must not report success for either. The cost
  # is that a genuinely slow boot can be waited for twice, once here and once
  # from the trap's retry.
  if ! wait_until_healthy "$APP_SERVICE" 180; then
    note "WARNING: the app was started but has not become healthy."
    note "Check: docker compose logs $APP_SERVICE"
    return 1
  fi
  APP_STOPPED=0
}

# Removes the timestamped output directory unless a complete backup landed in
# it.
#
# Validation creates the directory before the quiesce, and the three artefacts
# appear one at a time, so every failure from validation onwards used to leave
# something behind that reads as a backup to anyone running `ls`. Measured, one
# injected failure per step:
#
#   pg_dump fails    -> postgres.dump 0 bytes + clickhouse.zip 8390 bytes
#   copy-out fails   -> clickhouse.zip 0 bytes
#   manifest fails   -> three files, only rows.postgres.* missing
#
# Only the last of those was handled. `restore.sh` refuses a directory with no
# MANIFEST, so none of them is as dangerous as a manifest that is present and
# short — but "a failed run leaves nothing" is either true or it is not, and it
# is far easier to keep true than to document the exceptions.
#
# Guarded on OUT_CREATED so it can only ever remove a directory this run
# created: validation refuses to start when the directory already exists, and
# creates it with a non-recursive `mkdir` that exactly one racing run can win.
# Cannot fail. Called from the EXIT trap, where a non-zero return under `set -e`
# would abort the trap -- and this used to end in a bare `rm -rf "$OUT"`, which
# on a destination gone read-only aborted cleanup before the app was restarted.
# The trap now runs the restart first and guards every call, so this is the
# third of three independent reasons that cannot happen; it is here so that no
# single one of them is load-bearing.
remove_incomplete_output() {
  [ "${OUT_CREATED:-0}" = "1" ] || return 0
  if [ "${BACKUP_COMPLETE:-0}" = "1" ]; then return 0; fi
  rm -rf "$OUT" 2>/dev/null || {
    note "WARNING: could not remove the incomplete backup at $OUT"
    note "It has no manifest and cannot be restored; delete it by hand."
  }
  return 0
}

# The backups disk lives inside the ClickHouse data volume, so the scratch
# archive survives `docker compose down` and accumulates one full backup per
# night until the volume fills. Removing it is load-bearing, not tidiness.
#
# Removes ONLY an archive this run created, which is why the flag exists rather
# than a bare `rm -f "$CH_FILE"`. The archive name is derived from a UTC
# *second*, so two backups launched 50ms apart compute the same name — and the
# one that loses the BACKUP_ALREADY_EXISTS race would otherwise delete the
# winner's archive on its way out. Measured: run A lost the race and ran the
# unguarded cleanup, leaving B with its three files only because B had already
# copied out; had A's cleanup landed between B's BACKUP and B's copy-out, both
# runs would have failed.
#
# The cost of the flag is that an archive left behind by a BACKUP that failed
# part-way is not cleaned up. That is the right trade: a stale archive is
# visible, bounded and removable, while deleting a concurrent run's archive
# corrupts a backup that was otherwise going to succeed.
#
# NOTE FOR restore.sh: this function is shared, and the flag defaults to 0, so
# calling it without setting the flag is a silent no-op. A restore copies an
# archive INTO the container and must therefore set CH_ARTEFACT_CREATED=1 once
# that copy has succeeded — otherwise the restored archive stays on the backups
# disk forever, which is precisely the volume growth this exists to prevent.
# Cannot fail, for the same reason as remove_incomplete_output.
remove_in_container_artefact() {
  [ "${CH_ARTEFACT_CREATED:-0}" = "1" ] || return 0
  [ -n "${CH_FILE:-}" ] || return 0
  docker compose exec -T "$CH_SERVICE" \
    rm -f "$CH_BACKUP_DIR/$CH_FILE" < /dev/null >/dev/null 2>&1 || true
  return 0
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
# MEASURED: a plain `count()` is not stable across BACKUP and RESTORE for a
# merging engine. It is a race, and one that is always eventually lost — the
# collapse is not done by RESTORE, it is done by the background merges that
# follow it. Sampled across three rounds, four phases each:
#
#   BEFORE-RESTORE      device_index count=28 FINAL=16 parts=5
#   IMMEDIATELY-AFTER   device_index count=28 FINAL=16 parts=5   <- unchanged
#   +20s                device_index count=16 FINAL=16 parts=3   <- the merge
#
# So a verification run soon after a restore can read the pre-merge number and
# pass, and the same check minutes later reads a smaller one and reports data
# loss. `count()` moved on 6 of 12 samples; `count() … FINAL` was invariant on
# all 12.
#
# `count() … FINAL` applies the engine's merge logic at read time, so it
# reports the fully-merged count — a property of the data rather than of the
# current part layout. That is the merge-stable expression, recorded per table
# in the manifest as `rowexpr.clickhouse.<table>` so restore.sh compares like
# with like instead of applying a tolerance. It is not free: at 20M rows,
# `FINAL` cost 243ms and 263 MiB read against 1ms for a bare `count()`. That is
# spent inside the quiesce, so it is downtime.
#
# FINAL is not usable everywhere: `SELECT count() FROM events_dead_letter
# FINAL` is rejected with `Code: 181 … Storage MergeTree doesn't support FINAL
# (ILLEGAL_FINAL)`. A plain MergeTree never collapses rows on merge, so its
# `count()` is stable under merges — but see ch_row_counts on TTL, which is a
# separate way for a plain MergeTree's count to fall. Hence the split below, by
# property rather than by table name: anything ending in MergeTree that is not
# the plain or plain-replicated engine collapses on merge and needs FINAL.
ch_count_expression() {
  case "$1" in
    MergeTree | ReplicatedMergeTree) echo 'count()' ;;
    *MergeTree) echo 'count() FINAL' ;;
    *) echo 'count()' ;;
  esac
}

# Emits `rows.clickhouse.<table>=<n>`, `rowexpr.clickhouse.<table>=<expr>`, and
# `rowttl.clickhouse.<table>=<expr>` for the tables that carry a table-level TTL.
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
#
# TTL, and why the answer is to record it rather than to skip the table.
# `events_dead_letter` carries `TTL toDateTime(received_at) + toIntervalDay(30)`.
# Its rows are deleted by the same background merges discussed above, so its
# count falls on its own — measured on a scale model with the TTL shortened:
# manifest 10, count immediately after RESTORE 10, count after the first merge
# 0. Restoring a backup older than the retention window is an ordinary
# disaster-recovery case, and a naive comparison would report catastrophic data
# loss that never happened. FINAL is not available as a fix here (Code 181).
#
# Dropping the table from the manifest would fix the false alarm and create a
# worse problem: a table missing from `rows.clickhouse.*` is indistinguishable
# from the stale-hardcoded-list failure the enumeration above exists to
# prevent, and the count at backup time is a true fact worth recording.
# So the table is counted like any other and its TTL is recorded alongside.
# The contract for restore.sh: for a table with a `rowttl.clickhouse.*` key, a
# restored count LOWER than the manifest is expected and must not be reported
# as loss; for every other table, equality is required.
#
# system.tables has no TTL column in 24.8 — the table-level TTL is only
# available inside `engine_full`, which carries the engine clause, PARTITION
# BY, ORDER BY, TTL and SETTINGS and nothing else. Column-level TTLs live in
# the column definitions in `create_table_query` and correctly do not appear
# here, since they expire values rather than rows.
#
# KNOWN LIMITATION, and one restore.sh must not paper over. This records ANY
# table-level TTL, including `TTL … TO DISK 'x'` and `TO VOLUME 'y'`, which
# MOVE rows between storage tiers rather than deleting them. A table whose only
# TTL is a move would be marked "lower is expected" and have its row
# verification effectively disabled forever, silently. Lyraflow has no such TTL
# today (`events_dead_letter`'s is a plain delete). If one is ever added, this
# must learn to distinguish the two rather than restore.sh loosening further.
ch_row_counts() {
  local tables name engine ttl expr suffix count
  tables="$(ch_query "
    SELECT name, engine,
           trim(replaceRegexpOne(extract(engine_full, ' TTL .*'), ' SETTINGS .*\$', ''))
    FROM system.tables
    WHERE database = '$CH_DATABASE'
      AND engine NOT IN ('MaterializedView', 'View', 'Dictionary')
    ORDER BY name
  ")" || return 1
  [ -n "$tables" ] || return 1

  printf '%s\n' "$tables" | while IFS="$(printf '\t')" read -r name engine ttl; do
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
    # Emitted only for the tables that have one, so its presence is the signal.
    if [ -n "$ttl" ]; then
      printf 'rowttl.clickhouse.%s=%s\n' "$name" "${ttl#TTL }"
    fi
  done
}

# Proves the whole Postgres path works before anything is stopped.
#
# `pg_row_counts` below is the only thing in this file that needs more from
# Postgres than a plain SELECT, and until this existed the first exercise of
# any Postgres query at all happened AFTER the app was down — so a Postgres
# built without libxml, or a psql that cannot authenticate, turned into
# downtime plus a failed backup instead of a refusal. Same principle as
# have_sha256: move the failure to the safe side of the quiesce. Measured at
# ~0.13s, which is noise next to a 30-second drain.
pg_can_count_rows() {
  local probe
  probe="$(pg_query \
    "SELECT (xpath('/row/c/text()', query_to_xml('SELECT 1 AS c', false, true, '')))[1]::text")" ||
    return 1
  [ "$probe" = "1" ]
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
# cleanly. Values are never quoted.
#
# A PARSER MUST SPLIT ON THE FIRST `=` AND TAKE THE WHOLE REMAINDER, not split
# on every `=`. Keys never contain one; values can. `rowexpr.*` values contain
# spaces and parentheses, and a `rowttl.*` value is an arbitrary ClickHouse
# expression — a `TTL … GROUP BY … SET x = max(y)` produces one containing
# spaces, parentheses AND an `=`. Anything that assumes two fields will
# silently truncate it.
#
# Both checksums are taken from the bytes in <out-dir>, never from the
# in-container archive: restore.sh has to be able to catch an artefact that was
# truncated on its way out, while the live data still exists, and a checksum of
# anything other than the file on disk cannot do that.
write_manifest() {
  local out="$1"
  local schema_version app_image ch_image pg_image ch_sum pg_sum tmp
  tmp="$out/MANIFEST.tmp"

  schema_version="$(pg_query 'SELECT max(version) FROM schema_migrations')" || return 1
  [ -n "$schema_version" ] || return 1
  app_image="$(service_image "$APP_SERVICE")"
  ch_image="$(service_image "$CH_SERVICE")"
  pg_image="$(service_image "$PG_SERVICE")"
  ch_sum="$(sha256_of "$out/clickhouse.zip")" || return 1
  pg_sum="$(sha256_of "$out/postgres.dump")" || return 1
  [ -n "$ch_sum" ] && [ -n "$pg_sum" ] || return 1

  # Written to a temporary name and renamed, never straight to MANIFEST. The
  # redirect creates its target BEFORE the pipeline runs, and `sort` writes
  # whatever it received before the left-hand side died — so a failure part-way
  # through leaves a short but perfectly well-formed manifest. Measured: forcing
  # a failure inside pg_row_counts produced three files, correct checksums,
  # `mode=quiesced` and a matching timestamp, missing only the entire
  # `rows.postgres.*` block. That satisfies every assertion a caller is likely
  # to make, and a restore.sh iterating those keys would find none and report a
  # flawless Postgres verification.
  if ! {
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
  } | LC_ALL=C sort | artefact_write "$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  # `mv`, not a second write: the rename carries the mode artefact_write gave
  # the temporary file, so MANIFEST cannot appear with any other mode, and it
  # appears atomically or not at all.
  mv "$tmp" "$out/MANIFEST"
}
