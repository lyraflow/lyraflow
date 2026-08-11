#!/usr/bin/env bash
# Put both Lyraflow data stores back from a backup taken by ./backup.sh.
#
# This is the only script in the repository that destroys live data, and it
# destroys ALL of it: the ClickHouse database is dropped and the Postgres
# `public` schema is dropped, both before their replacements are read in.
# Everything written since the backup was taken is gone. Three guards run
# before any of that happens -- the artefact checksums, the schema version,
# and a typed confirmation -- and every one of them is positioned so that a
# refusal leaves the running system exactly as it was.
#
# bash rather than sh, for the same two reasons backup.sh gives: `set -o
# pipefail`, and traps, which are how this script guarantees it never leaves
# the app stopped. Targets bash 3.2, the version macOS still ships.
#
# Runs plain `docker compose` with no -f, so COMPOSE_FILE and
# COMPOSE_PROJECT_NAME work the way an operator (and the round-trip tests)
# expect.
#
# ONE STORE IS NEVER PUT BACK ON ITS OWN, and there is deliberately no flag
# that would let you. The two stores are not independent: `suppressed_persons`
# lives in Postgres and the events it hides live in ClickHouse. Consider a
# restore that dies half way.
#
#   ClickHouse back, Postgres untouched -- ClickHouse holds a deleted person's
#   events again, but Postgres is current and still carries their suppression
#   row, so they stay hidden. Safe.
#
#   Postgres back, ClickHouse untouched -- Postgres has lost every suppression
#   row written since the backup while ClickHouse is fully current, so those
#   people's future events become visible again. A privacy regression, and a
#   silent one.
#
#   ClickHouse back, Postgres EMPTY -- the third one, and the one an ordering
#   argument written from the first two forgets. It is reachable, because the
#   Postgres half is a drop followed by a refill and a run can stop between
#   them. Worse than it sounds: the app restarts onto an empty schema, finds no
#   `schema_migrations`, migrates forward, and comes up healthy and answering
#   with a structurally complete Postgres holding zero suppression rows beside
#   a ClickHouse full of restored events. Nothing about it looks wrong.
#
# The third is why DATA_STATE below is announced on any exit that began
# destroying anything -- including one caused by a signal -- rather than only
# on the failures this script chose to report, and why every one of its values
# is assigned BEFORE the command it describes rather than after.
#
# Before, because bash DEFERS a signal until the running foreground child
# exits: the destructive command therefore completes and the shell dies before
# the next statement, so an assignment placed after the command never runs and
# the announcement describes the previous step. Measured, with the assignment
# after `DROP SCHEMA public CASCADE`: "Postgres has NOT been touched and is
# still current ... which is the safe half", printed over an EMPTY Postgres
# with zero suppression rows. Silence was the first version of this defect; an
# affirmative false statement about the privacy property is worse.
#
# It is also why a run that began destroying and did not finish leaves the app
# STOPPED. See cleanup().
#
# That asymmetry is the whole reason the order below is ClickHouse first and
# Postgres second, and the intuition points the other way: the store that
# feels safe to do first is the small metadata one. It is not.
#
# `-o pipefail` is part of that line and is not decoration here even though
# this script writes nothing to disk of its own. Anything that feeds a store
# through a pipe -- and backup-lib.sh's copy helpers are pipes now -- reports
# the consumer's exit status without it, so a producer that died half way
# looks like a success. Same class of bug backup.sh sets it for.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=backup-lib.sh
. "$SCRIPT_DIR/backup-lib.sh"

# See backup.sh's own comment for the full reasoning. In short: a reader that
# goes away (`| head`, `| less` then q, a wrapper capping its log) must not be
# able to kill this script mid-restore. `say`/`note` from backup-lib.sh cannot
# fail, and this turns the signal into an ordinary write error for anything
# else. It matters more here than in a backup: a run abandoned between the
# two stores is the exact half-restored state described above.
trap "" PIPE

# How long the confirmation prompt waits for an answer. Matches the two
# minutes the deletion CLI's prompt uses (packages/cli/src/index.ts), and for
# the same reason: generous for a human who is reading the warning, short
# enough that an unattended caller which will never answer does not hang for
# ever. A timeout is a refusal, and a refusal here costs nothing -- nothing
# has been touched yet.
CONFIRM_TIMEOUT=120

# What has happened to the operator's data at this point in the run, in words.
# Printed by announce_data_state below.
#
# A single fixed sentence is what backup-lib.sh's `fail` can afford, because a
# backup only ever reads. This script passes through nine genuinely different
# states and an operator at 4am needs to be told which one they are in -- "your
# data is intact", "ClickHouse may be gone", "Postgres may be empty" and "both
# stores are back" call for completely different next actions.
#
# EVERY VALUE IS ASSIGNED BEFORE THE COMMAND IT DESCRIBES, and each pair reads
# "this may or may not have happened" before, tightened to "this happened"
# after. That is the same rule, for the same reason, as APP_STOPPED and
# CH_ARTEFACT_CREATED: the window in which the outcome is unknown is the whole
# duration of the command, not a gap between two statements, and the shell can
# die inside it. `docker compose stop`'s own comment has the long version.
DATA_STATE_INITIAL="nothing has been changed: both stores still hold exactly what they held before this ran"
DATA_STATE="$DATA_STATE_INITIAL"
DATA_STATE_REPORTED=0

# Set immediately BEFORE the first statement that can destroy anything, and
# never cleared. cleanup() reads it to decide whether this run owes the
# operator an announcement and whether the app may be started again.
#
# A flag rather than `[ "$DATA_STATE" != "$DATA_STATE_INITIAL" ]`, which is
# what this used to be: that comparison is true only once an assignment has
# run, so a signal arriving during the very first DROP left DATA_STATE at its
# initial value and the test suppressed the announcement entirely -- the app
# could not boot, the site was down, and the script said "nothing has been
# changed". A flag cannot be defeated by the wording moving.
DESTRUCTION_BEGUN=0

# Set once BOTH stores are back. Distinct from RESTORE_COMPLETE: verification
# runs after this and can fail, and a verification failure is not a half-
# restored system -- the two stores agree with each other, they merely
# disagree with the manifest -- so the app is still started for it.
STORES_RESTORED=0

# Set on the last line of the run, so cleanup can tell "finished" from "stopped
# part way". Same role as backup.sh's BACKUP_COMPLETE.
RESTORE_COMPLETE=0

usage() {
  cat >&2 <<'EOF'
Usage: ./restore.sh <backup-directory>

Replaces the contents of BOTH data stores with the backup in that directory,
which must be one of the timestamped directories ./backup.sh wrote (the one
containing MANIFEST, clickhouse.zip and postgres.dump).

THIS DESTROYS LIVE DATA. Everything recorded since the backup was taken is
lost. The app is stopped for the duration and started again afterwards.

Before anything is destroyed this checks the artefacts against the manifest's
checksums, refuses a backup newer than the running image, and asks you to type
the backup's timestamp. Any of those refusing leaves your system untouched.

Both stores are always restored together. There is no way to ask for one of
them: Postgres holds the suppression list and ClickHouse holds the events it
hides, so a Postgres older than its ClickHouse partner makes deleted people
visible again.
EOF
}

SRC="${1:-}"
case "$SRC" in
  -h | --help)
    usage
    exit 0
    ;;
esac
if [ -z "$SRC" ]; then
  usage
  exit 2
fi

# ---------------------------------------------------------------------------
# Failure reporting
# ---------------------------------------------------------------------------

# refuse <reason…> -- a guard declining before anything has been touched.
#
# Separate from `abort` so that the two can never be confused at a call site:
# this one is only correct while DATA_STATE is still its initial value, and it
# says so unconditionally rather than reading a variable that a later edit
# could leave stale.
refuse() {
  local line
  note ""
  note "REFUSING TO RESTORE."
  for line in "$@"; do
    note "  ${line}"
  done
  note ""
  note "Nothing has been changed. Your live data and this backup are both intact."
  exit 1
}

# announce_data_state -- says what happened to the operator's data, once.
#
# THE ONLY PLACE DATA_STATE IS PRINTED, and it is deliberately not owned by
# `abort`. It used to be, and that is a defect with a name: a SIGTERM arriving
# between the Postgres drop and the Postgres refill killed the script without
# going through `abort` at all, so the run printed
#
#   Stopping the app...  /  Restoring ClickHouse...  /  Restoring Postgres...
#   Starting the app again...        <- from the EXIT trap
#
# and nothing else, exit 143 -- while leaving a ClickHouse full of restored
# events beside an EMPTY Postgres. The app then restarted, found no
# `schema_migrations`, migrated forward, and came up healthy with zero
# suppression rows. That is the state this file's own header calls "a privacy
# regression, and a silent one", reached without a single word about it.
#
# A signal is ordinary here, not exotic: `timeout`, systemd stopping a unit, a
# supervisor, a CI cancel, a plain `kill`. bash runs the EXIT trap on signal
# death (measured, same as the SIGPIPE case backup-lib.sh documents), so the
# trap sees every exit a trap CAN see -- which is why the announcement belongs
# there rather than in the failure reporter.
#
# EXCEPT SIGKILL, which no process can trap. `kill -9` mid-restore runs
# nothing: no announcement, the app left stopped, and the archive left on the
# backups disk -- reopening the volume growth CH_ARTEFACT_CREATED exists to
# prevent. Measured. There is no shell-level fix for it; it is recorded so
# nobody reads "every exit" as a stronger claim than it is. The next run
# overwrites that archive by name, so the leak is bounded per backup rather
# than per attempt.
#
# Once, because `abort` exits and the trap then runs too; without the flag the
# same paragraph would print twice on the paths that already work.
#
# Cannot fail: `note` cannot, and every other statement is an assignment.
announce_data_state() {
  [ "$DATA_STATE_REPORTED" = "0" ] || return 0
  DATA_STATE_REPORTED=1
  note "STATE OF YOUR DATA: ${DATA_STATE}"
  return 0
}

# abort <step> <detail…> -- a failure after the destruction has begun.
#
# backup-lib.sh's `fail` cannot be reused here: its closing claim is "no data
# was changed", which is true of every path in backup.sh and false of almost
# every path below this line. Printing it from a restore that has already
# dropped the ClickHouse database would be the single most misleading thing
# this script could say.
abort() {
  local step="$1"
  shift
  local line
  note ""
  note "ERROR: the restore failed during the ${step} step."
  for line in "$@"; do
    note "  ${line}"
  done
  note ""
  announce_data_state
  note "The backup directory has not been modified and can be used again."
  exit 1
}

# ---------------------------------------------------------------------------
# Manifest reading
# ---------------------------------------------------------------------------

# manifest_get <dir> <key>
#
# SPLITS ON THE FIRST `=` AND TAKES THE WHOLE REMAINDER, which write_manifest
# in backup-lib.sh requires of any parser: keys never contain an `=` but values
# can. `rowexpr.*` values contain spaces and parentheses, and a `rowttl.*`
# value is an arbitrary ClickHouse expression -- a `TTL … GROUP BY … SET x =
# max(y)` contains an `=` -- so anything that splits on every `=` truncates it
# silently. `${line#*=}` removes up to the FIRST one, which is exactly right;
# the `case` above it is what proves the key matched in full.
manifest_get() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2="*)
        printf '%s\n' "${line#*=}"
        return 0
        ;;
    esac
  done < "$1/MANIFEST"
  return 1
}

# manifest_keys <dir> <prefix> -- every key with that prefix, one per line.
# `%%=*` strips the longest trailing `=…`, i.e. everything from the first `=`.
manifest_keys() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2"*) printf '%s\n' "${line%%=*}" ;;
    esac
  done < "$1/MANIFEST"
}

# A table name out of the manifest is interpolated into SQL, so it is checked
# rather than trusted. A backup directory is not a trust boundary in any
# meaningful sense -- an attacker who can rewrite your MANIFEST can rewrite
# postgres.dump, whose contents are executed verbatim -- but a name with a quote
# would produce a baffling syntax error at the worst possible moment, which is
# reason enough on its own.
safe_identifier() {
  case "$1" in
    '' | *[!A-Za-z0-9_]*) return 1 ;;
  esac
  return 0
}

# ---------------------------------------------------------------------------
# The app image's schema version
# ---------------------------------------------------------------------------

# Read from the IMAGE, never from this checkout. An operator restoring at 2am
# is standing in whatever working tree they happen to have cloned, which is
# routinely not the image the stack is running -- and it is the image that will
# boot against the restored database and either understand it or refuse to.
#
# `docker compose run --rm --no-deps`, NOT `exec`, and that is load-bearing
# rather than stylistic: a restore is the operation you perform on a system
# that is already broken, and `exec` needs a container that is up. The two
# cases that matter both have the app down.
#
#   The previous run left it stopped on purpose (see cleanup) -- so the very
#   command this script tells the operator to run next would have refused.
#
#   The ClickHouse database is missing, so the app EXITS at boot with code 81,
#   UNKNOWN_DATABASE. Measured: `docker compose start` returns 0 and the
#   container is `exited (1)` twenty seconds later, so no amount of starting it
#   first makes `exec` work. The recovery path was a dead end.
#
# `--rm` so nothing is left behind (verified: `compose ps -a` shows no run-
# container afterwards), `--no-deps` so asking the image a question does not
# start the stores, `-T` because there is no terminal.
#
# `--progress quiet` is NOT cosmetic, and it is the same trap `docker compose
# stop` carries in backup.sh. `run` narrates itself on stderr -- "Container …
# Creating", "Container … Created", 384 bytes of it -- and a caller that has
# closed stderr (`./restore.sh DIR 2>&1 | head -1`, which is what a log-capping
# wrapper writes) makes the second of those writes raise SIGPIPE in a child
# this shell's `trap "" PIPE` does not cover. Measured: the child died, the
# guard could not read a version, the run was refused, and no restore happened
# at all. With this flag a successful call writes ZERO bytes to stderr, and a
# genuine failure still prints the image's own error -- verified both ways.
#
# The import is tried as a package specifier first and falls back to the path
# inside the image, because the production install does not link the workspace
# packages at the root of the image's workdir (measured: `node_modules/
# @lyraflow` contains only `db`). Either way this is the constant the image was
# built with.
#
# A failure here is a refusal, not a shrug: a guard that cannot read the number
# it guards on has not passed, and skipping it would turn the one check that
# stands between an operator and an unbootable app into a no-op.
image_schema_version() {
  docker compose --progress quiet run --rm --no-deps -T "$APP_SERVICE" node -e \
    'import("@lyraflow/core").catch(() => import("./packages/core/dist/index.js")).then((m) => console.log(m.SCHEMA_VERSION))' \
    < /dev/null
}

# ---------------------------------------------------------------------------
# Verification, run while the app is still stopped
# ---------------------------------------------------------------------------

# Compares every row count in the manifest against the restored databases and
# exits non-zero on any mismatch, listing all of them rather than the first.
#
# CALLED BEFORE THE APP IS STARTED AGAIN, which is not where the plan put it.
# Two things go wrong if it runs after: the SDK's queued events start arriving
# the moment the app answers, so `rows.clickhouse.events` legitimately grows
# while this is reading it; and an image newer than the backup applies the
# missing migrations on boot, which appends to `schema_migrations` and makes
# `rows.postgres.schema_migrations` disagree by exactly the number of versions
# the operator upgraded through. Both would be reported as data loss, and both
# are races this cannot win by widening a tolerance. Verified here, the numbers
# describe the restore and nothing else.
#
# EVERY CLICKHOUSE COUNT USES THE MANIFEST'S OWN `rowexpr.clickhouse.<table>`,
# never a bare `count()`. A merging engine's `count()` is not stable across a
# RESTORE -- the collapse is done by the background merges that follow it, not
# by the RESTORE -- so a bare count read seconds after a restore can be right
# and the same query minutes later wrong, or the reverse. Measured on this
# branch with merges frozen so the window does not close:
#
#   before backup    device_index count()=5  FINAL=3   (manifest records 3)
#   after RESTORE    device_index count()=5  FINAL=3   at +0s and at +25s
#
# and with merges left alone, `count()` fell from 5 to 3 within five seconds of
# the RESTORE. `count() FINAL` was 3 at every single sample.
#
# The expression is read rather than re-derived because it is not uniform:
# `SELECT count() FROM events_dead_letter FINAL` is rejected outright with
# `Code: 181 … Storage MergeTree doesn't support FINAL (ILLEGAL_FINAL)`, so a
# hardcoded FINAL fails every restore, and a hardcoded bare count silently
# compares the wrong number for four of the five tables.
#
# `rowttl.clickhouse.<table>` present means a LOWER count is expected rather
# than a failure: that table's rows are deleted by the same background merges
# once they age past the window, so restoring a backup older than the retention
# window -- ordinary disaster recovery -- would otherwise report catastrophic
# loss that never happened. A HIGHER count is still a failure even there;
# nothing about a TTL can invent rows.
#
# There are no `rowexpr.postgres.*` keys and there is no Postgres TTL: nothing
# in Postgres collapses or expires rows on its own, so every Postgres table is
# a plain `count(*)` and must match exactly.
verify_row_counts() {
  local key table expected actual expr suffix mismatches=0

  while IFS= read -r key; do
    table="${key#rows.clickhouse.}"
    safe_identifier "$table" ||
      abort "verification" "The manifest names a ClickHouse table this cannot quote: $table"
    expected="$(manifest_get "$SRC" "$key")" || expected=''
    expr="$(manifest_get "$SRC" "rowexpr.clickhouse.$table")" || expr=''
    # Pre-flight already refused a manifest missing any of these, so reaching
    # this is a bug rather than bad input -- and guessing an expression here
    # is precisely the silent wrong comparison the pre-flight exists to stop.
    [ -n "$expected" ] && [ -n "$expr" ] ||
      abort "verification" "The manifest has no count or no expression for $table."
    suffix=''
    case "$expr" in *FINAL) suffix=' FINAL' ;; esac
    # shellcheck disable=SC2016
    actual="$(ch_query "$(printf 'SELECT count() FROM `%s`%s' "$table" "$suffix")")" || actual=''
    if [ -z "$actual" ]; then
      note "  clickhouse.$table: could not be counted after the restore (expected $expected)"
      mismatches=$((mismatches + 1))
      continue
    fi
    if [ "$actual" = "$expected" ]; then continue; fi
    if manifest_get "$SRC" "rowttl.clickhouse.$table" > /dev/null && [ "$actual" -lt "$expected" ]; then
      say "  clickhouse.$table: $actual rows, backup recorded $expected -- lower is expected, this table has a TTL"
      continue
    fi
    note "  clickhouse.$table: $actual rows, the backup recorded $expected"
    mismatches=$((mismatches + 1))
  done < <(manifest_keys "$SRC" 'rows.clickhouse.')

  while IFS= read -r key; do
    table="${key#rows.postgres.}"
    safe_identifier "$table" ||
      abort "verification" "The manifest names a Postgres table this cannot quote: $table"
    expected="$(manifest_get "$SRC" "$key")" || expected=''
    [ -n "$expected" ] ||
      abort "verification" "The manifest has no count for postgres.$table."
    actual="$(pg_query "SELECT count(*) FROM public.\"$table\"")" || actual=''
    if [ -z "$actual" ]; then
      note "  postgres.$table: could not be counted after the restore (expected $expected)"
      mismatches=$((mismatches + 1))
      continue
    fi
    if [ "$actual" = "$expected" ]; then continue; fi
    note "  postgres.$table: $actual rows, the backup recorded $expected"
    mismatches=$((mismatches + 1))
  done < <(manifest_keys "$SRC" 'rows.postgres.')

  [ "$mismatches" = "0" ] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# The EXIT trap. Same shape, and the same three reasons, as backup.sh's.
# ---------------------------------------------------------------------------

# THE RESTART COMES FIRST and nothing above it may be able to abort this
# function. See backup.sh's cleanup() for the three review rounds that
# established the shape; the failure it prevents -- the app left stopped with
# nothing announcing it -- is identical here and, after a restore, worse: the
# operator's attention is on whether their data came back, not on whether the
# site did.
cleanup() {
  local restart_ok=1

  # THE ONE PATH WHERE THE APP IS DELIBERATELY LEFT DOWN, and it is a reversal
  # of backup.sh's invariant rather than a violation of it.
  #
  # There, the script changes nothing, so leaving the app stopped is pure harm
  # and the restart comes first unconditionally. Here the app coming back up on
  # a half-restored pair of stores IS the harm. Two measured shapes:
  #
  #   killed during the Postgres drop -- the app restarts onto an empty schema,
  #   finds no `schema_migrations`, migrates forward, and answers /ready 200
  #   with ZERO suppression rows beside a ClickHouse full of restored events.
  #   Every deleted person is visible again, and nothing looks wrong.
  #
  #   killed during the ClickHouse drop -- the app cannot boot at all (code 81,
  #   UNKNOWN_DATABASE), so the restart burns the full health timeout and fails
  #   anyway, delaying the only message that matters by three minutes.
  #
  # A down site is loud and an operator acts on it within minutes. A site that
  # is up and serving a person who asked to be erased is silent, and the
  # announcement alone cannot fix that: it goes to stderr, and the `timeout`
  # /systemd/cron case that motivates this whole branch is precisely the one
  # where nobody is reading. A re-run is required either way, and its first act
  # is to stop the app again.
  #
  # STORES_RESTORED, not RESTORE_COMPLETE: a failed verification leaves two
  # stores that agree with each other and disagree with the manifest, which is
  # a reason to distrust the backup, not to keep the site dark.
  if [ "$DESTRUCTION_BEGUN" = "1" ] && [ "$STORES_RESTORED" = "0" ]; then
    remove_in_container_artefact || true
    note ""
    note "THE APP HAS BEEN LEFT STOPPED ON PURPOSE. It was not started again."
    announce_data_state
    note ""
    note "Starting it now would serve that state: a Postgres with no suppression"
    note "rows makes deleted people visible again, and a missing ClickHouse"
    note "database stops the app booting at all."
    note ""
    note "Finish the restore -- it is safe to repeat, and it starts the app again"
    note "once both stores are back:"
    note "  ./restore.sh $SRC"
    note ""
    note "Or, if you have decided against it, start the app as it is:"
    note "  docker compose start $APP_SERVICE"
    exit 1
  fi

  # THE RESTART IS FIRST on every other path, and nothing below it may abort.
  start_app_if_stopped || restart_ok=0

  remove_in_container_artefact || true

  # The announcement, for a run that got both stores back and then stopped
  # short -- a failed verification, or a signal during it.
  #
  # Suppressed on a completed run, and only there: stdout has already said
  # "Restored from …" and "Both stores now match …", which is the same fact
  # stated positively, and a cron wrapper that treats any stderr output as a
  # problem should not be handed one by a restore that worked.
  #
  # No bare `note ""` guarding it: `announce_data_state` is a once-per-run
  # function and `abort` usually spends it first, so a blank line printed
  # unconditionally around it is a stray line on exactly the paths that already
  # said everything.
  if [ "$RESTORE_COMPLETE" = "0" ] && [ "$DESTRUCTION_BEGUN" = "1" ]; then
    announce_data_state
  fi

  if [ "$restart_ok" = "0" ]; then
    note ""
    note "ERROR: the app is stopped and this script could not start it."
    note "  Run: docker compose start $APP_SERVICE"
    # Unconditional, unlike the branch above: "the app is down" is not
    # actionable without "and here is what state your data is in", even when
    # that state is the initial one -- which is exactly the case when the
    # restart fails between the quiesce and the first DROP.
    announce_data_state
    exit 1
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pre-flight. Everything that can be checked without touching anything, and
# all of it, because from the quiesce onwards a refusal costs downtime and
# from the DROP onwards it costs data.
# ---------------------------------------------------------------------------

[ -d "$SRC" ] ||
  refuse "$SRC is not a directory."

[ -f "$SRC/MANIFEST" ] ||
  refuse "There is no MANIFEST in $SRC." \
    "Point this at one of the timestamped directories ./backup.sh wrote, not at" \
    "the destination you gave it."

for artefact in clickhouse.zip postgres.dump; do
  [ -f "$SRC/$artefact" ] ||
    refuse "$SRC/$artefact is missing." \
      "A backup directory holds MANIFEST, clickhouse.zip and postgres.dump."
  [ -s "$SRC/$artefact" ] ||
    refuse "$SRC/$artefact is empty."
done

have_sha256 ||
  refuse "No SHA-256 tool found (looked for sha256sum, shasum and openssl)." \
    "The manifest records a checksum per artefact and this refuses to restore" \
    "one it cannot check."

# --- the manifest describes a whole backup ---------------------------------
#
# Not paranoia about a hand-edited file: backup.sh used to be able to leave a
# short manifest behind, and its own comment records what that looked like --
# three files, correct checksums, `mode=quiesced`, a matching timestamp, and
# the entire `rows.postgres.*` block missing. It writes atomically now, but a
# restore that iterated an absent block and reported a flawless verification
# would be the worst possible way to find out that changed back.
BACKUP_VERSION="$(manifest_get "$SRC" lyraflow_backup_version)" || BACKUP_VERSION=''
[ "$BACKUP_VERSION" = "1" ] ||
  refuse "This is not a backup format this script understands." \
    "lyraflow_backup_version is '${BACKUP_VERSION:-missing}', expected 1."

STAMP="$(manifest_get "$SRC" timestamp)" || STAMP=''
[ -n "$STAMP" ] ||
  refuse "The manifest has no timestamp."

MANIFEST_CH_SUM="$(manifest_get "$SRC" clickhouse_sha256)" || MANIFEST_CH_SUM=''
MANIFEST_PG_SUM="$(manifest_get "$SRC" postgres_sha256)" || MANIFEST_PG_SUM=''
[ -n "$MANIFEST_CH_SUM" ] && [ -n "$MANIFEST_PG_SUM" ] ||
  refuse "The manifest is missing a checksum, so the artefacts cannot be verified."

MANIFEST_SCHEMA="$(manifest_get "$SRC" schema_version)" || MANIFEST_SCHEMA=''
case "$MANIFEST_SCHEMA" in
  '' | *[!0-9]*)
    refuse "The manifest's schema_version is '${MANIFEST_SCHEMA:-missing}', which is not a number."
    ;;
esac

CH_KEYS="$(manifest_keys "$SRC" 'rows.clickhouse.')"
PG_KEYS="$(manifest_keys "$SRC" 'rows.postgres.')"
[ -n "$CH_KEYS" ] ||
  refuse "The manifest records no ClickHouse row counts at all." \
    "A restore cannot be verified against it, so it is refused rather than" \
    "reported as a flawless restore of nothing."
[ -n "$PG_KEYS" ] ||
  refuse "The manifest records no Postgres row counts at all." \
    "A restore cannot be verified against it, so it is refused rather than" \
    "reported as a flawless restore of nothing."

# Every count must name the expression it was taken with. Checked here, not at
# verification time, because verification runs after the data is already gone
# and there is nothing useful to do about a bad manifest at that point.
while IFS= read -r key; do
  [ -n "$key" ] || continue
  table="${key#rows.clickhouse.}"
  manifest_get "$SRC" "rowexpr.clickhouse.$table" > /dev/null ||
    refuse "The manifest counts clickhouse.$table but does not say with which expression." \
      "Comparing a merging engine's rows without that is a coin flip; see the" \
      "rowexpr keys backup.sh writes."
done <<EOF
$CH_KEYS
EOF

# --- the stores are up ------------------------------------------------------
#
# The two stores, and DELIBERATELY NOT THE APP. Finding either store missing
# after the ClickHouse database has been dropped would be the worst possible
# time, so they are checked here.
#
# The app is not, and this is the opposite of backup.sh's rule. A backup's
# whole consistency claim rests on THIS script having been the one that stopped
# the writer, so an app that is already down makes the backup meaningless.
# A restore overwrites both stores wholesale; there is nothing for a concurrent
# writer to make inconsistent, and requiring the app to be up would refuse in
# exactly the two situations a restore exists for. Both measured:
#
#   the previous run left it stopped on purpose (cleanup, below) -- so the
#   command that run printed as the way to finish would have been refused;
#
#   the ClickHouse database is missing, so the app exits at boot with code 81
#   and `compose ps --status running` never lists it, no matter how many times
#   the operator starts it.
#
# `docker compose stop` on a container that is already stopped returns 0 and
# `wait_until_stopped` returns immediately, so the quiesce below needs no
# special case; and the app is started at the end either way, which is what an
# operator recovering a dead stack actually wants.
for service in "$CH_SERVICE" "$PG_SERVICE"; do
  service_running "$service" ||
    refuse "The '$service' service is not running." \
      "Both stores must be up to restore into them." \
      "Start the stack first: docker compose up -d"
done

# ---------------------------------------------------------------------------
# GUARD 1 -- the artefacts are the ones the manifest describes.
#
# First of the three, because it is the one that catches a backup that is not
# a backup: a copy interrupted half way, a truncated download, a disk that
# went bad under an archive nobody has read since it was written. Every one of
# those is only recoverable while the live data still exists.
# ---------------------------------------------------------------------------

say "Checking the artefacts against the manifest..."
ACTUAL_CH_SUM="$(sha256_of "$SRC/clickhouse.zip")" || ACTUAL_CH_SUM=''
ACTUAL_PG_SUM="$(sha256_of "$SRC/postgres.dump")" || ACTUAL_PG_SUM=''
[ "$ACTUAL_CH_SUM" = "$MANIFEST_CH_SUM" ] ||
  refuse "clickhouse.zip does not match the checksum in the manifest." \
    "  manifest: $MANIFEST_CH_SUM" \
    "  on disk:  ${ACTUAL_CH_SUM:-could not be computed}" \
    "This backup is damaged. Do not restore it; find another copy."
[ "$ACTUAL_PG_SUM" = "$MANIFEST_PG_SUM" ] ||
  refuse "postgres.dump does not match the checksum in the manifest." \
    "  manifest: $MANIFEST_PG_SUM" \
    "  on disk:  ${ACTUAL_PG_SUM:-could not be computed}" \
    "This backup is damaged. Do not restore it; find another copy."

# ---------------------------------------------------------------------------
# GUARD 2 -- the running image can understand this backup's schema.
#
# The same condition the app already raises at boot as SchemaTooNewError
# ("Database schema version N is newer than this build understands (M)"), but
# reached before the data is gone instead of after. That is the difference
# between an error message and an outage: restore a schema-12 backup into a
# schema-11 image and the app refuses to start, with the database it would
# have refused to start against now being the only copy you have.
# ---------------------------------------------------------------------------

say "Checking the backup against the running image..."
IMAGE_SCHEMA="$(image_schema_version)" || IMAGE_SCHEMA=''
case "$IMAGE_SCHEMA" in
  '' | *[!0-9]*)
    refuse "Could not read the schema version the running app image understands." \
      "Asked the '$APP_SERVICE' container and got '${IMAGE_SCHEMA:-nothing}'." \
      "This guard is what stops a backup newer than your image being restored" \
      "into it, so a restore is refused rather than run without it."
    ;;
esac

# `-gt`, not `-lt` and not `-ne`. An OLDER backup is the ordinary case -- it is
# what disaster recovery IS -- and the app migrates it forward on boot. Only a
# backup from a build the running image has never heard of is unrestorable.
if [ "$MANIFEST_SCHEMA" -gt "$IMAGE_SCHEMA" ]; then
  refuse "This backup is newer than the running image." \
    "Database schema version $MANIFEST_SCHEMA is newer than this build understands ($IMAGE_SCHEMA)." \
    "Restoring it would leave you with a database the app refuses to start" \
    "against. Upgrade the image first, then restore."
fi

# ---------------------------------------------------------------------------
# GUARD 3 -- a human types the backup's timestamp.
#
# Last of the three on purpose: everything a machine can check has been
# checked, so the one thing an operator is asked to do is the one thing only
# they can decide. Asking first and then refusing on a checksum wastes the
# only irreplaceable input in the process, which is their attention.
#
# The timestamp rather than "yes": the deletion CLI asks a yes/no question
# because it names one person and the risk is that you meant a different
# person. Here the risk is that you meant a different BACKUP, and typing the
# stamp is what makes an operator look at which directory they actually
# passed. It has the same fail-closed property that CLI's prompt has -- a
# closed stdin, an empty line or a timeout are all refusals, and there is no
# flag to skip it. A non-interactive caller that wants one is a separate
# decision with its own review.
# ---------------------------------------------------------------------------

note ""
note "About to REPLACE the contents of both data stores from:"
note "  $SRC"
note "Backup taken:    $STAMP"
note "Schema version:  $MANIFEST_SCHEMA (running image understands $IMAGE_SCHEMA)"
note ""
note "Everything recorded since then will be lost, in both stores."
note ""
# The expected answer is NOT repeated on the prompt line. It is on the
# "Backup taken" line above, where reading it is part of reading which backup
# this is about; putting it here as well would turn a transcription into a
# copy-paste and lose the only thing the question is for. Same instinct as the
# deletion CLI, which deliberately keeps the person's id out of its question.
note "Type that timestamp to confirm, or anything else to abandon:"
CONFIRMATION=''
if ! IFS= read -r -t "$CONFIRM_TIMEOUT" CONFIRMATION; then
  CONFIRMATION=''
fi
[ "$CONFIRMATION" = "$STAMP" ] ||
  refuse "That is not the backup's timestamp." \
    "Expected: $STAMP" \
    "Nothing was restored."

# ---------------------------------------------------------------------------
# FROM HERE ON, LIVE DATA IS AT RISK.
# ---------------------------------------------------------------------------

# Named from the manifest's own timestamp, not from the clock: a restore that
# is interrupted and retried then reuses one path on the backups disk instead
# of accumulating a copy per attempt, and ClickHouse's own error message on a
# failed restore names an archive the operator can recognise.
CH_FILE="lyraflow-$STAMP.zip"

say "Stopping the app..."
# Flag first, command second. `docker compose stop` can stop the container and
# still exit non-zero -- Ctrl-C during the 30-second drain exits 130 with the
# container already down -- and under `set -e` that kills this script before
# any assignment placed after it could run, leaving the EXIT trap with nothing
# to restore. Four review rounds on backup.sh were this one ordering; see
# APP_STOPPED in backup-lib.sh for the measurement.
APP_STOPPED=1
docker compose stop "$APP_SERVICE" > /dev/null 2>&1 ||
  abort "quiesce" \
    "docker compose stop $APP_SERVICE exited non-zero." \
    "The app may or may not have stopped; it is being started again either way."

wait_until_stopped "$APP_SERVICE" 60 ||
  abort "quiesce" \
    "The app did not stop within 60s; refusing to replace the stores underneath it."

# --- ClickHouse ------------------------------------------------------------

say "Restoring ClickHouse..."

# `docker compose exec` writing through a redirect, and NOT `docker compose
# cp`, for a reason specific to this direction: `cp` reproduces the HOST
# file's mode inside the container, and backup.sh deliberately writes its
# artefacts 0600 owned by the operator. Copied in that way the archive lands
# unreadable by the `clickhouse` user the server runs as, and RESTORE fails on
# a file that is sitting right there. Through a redirect it is created by the
# container's own umask -- measured as 0644 root:clickhouse, which the server
# reads without complaint.
#
# FLAG FIRST, COPY SECOND, and this is the opposite of the trade-off backup.sh
# makes one line from the same place. There the flag goes up only after BACKUP
# succeeds, because two runs launched in the same second compute the same
# archive name and the loser must not delete the winner's. Here the name comes
# from the MANIFEST's timestamp rather than the clock, so a second run of this
# script against the same backup computes the same name deliberately -- it
# overwrites its own previous attempt instead of accumulating one archive per
# try, and there is no other run whose archive it could be.
#
# So the archive is ours from the moment the copy STARTS, and setting the flag
# after the copy means a copy that fails part way leaks a partial database
# archive. Measured, with a copy that really ran and then reported failure:
#
#   STATE OF YOUR DATA: nothing has been changed ...
#   backups disk after:  -rw-r--r-- 1 root clickhouse 34198 lyraflow-….zip
#
# The backups disk lives inside the ClickHouse data volume and survives
# `docker compose down`, so that is one whole database copy per abandoned run,
# for ever. The flag defaults to 0 in backup-lib.sh, so forgetting this line
# does not fail -- it makes remove_in_container_artefact a silent no-op.
CH_ARTEFACT_CREATED=1
docker compose exec -T "$CH_SERVICE" sh -c 'cat > "$1"' _ "$CH_BACKUP_DIR/$CH_FILE" \
  < "$SRC/clickhouse.zip" ||
  abort "ClickHouse" \
    "Could not copy the archive into the $CH_SERVICE container."

# EVERYTHING BELOW THIS LINE CAN DESTROY DATA. The flag goes up before the
# statement that does, never after: bash defers a signal until the running
# child exits, so the shell can die between a destructive command finishing and
# any assignment placed after it.
DESTRUCTION_BEGUN=1
DATA_STATE="the ClickHouse database was being dropped and may already be gone; Postgres is untouched. If it is gone the app cannot start at all (code 81, UNKNOWN_DATABASE). Run this script again with the same backup."

# Bound to `default`, not to the application database. A ClickHouse session
# sets its current database on connect and naming one that does not exist is
# itself an error -- Code 81, UNKNOWN_DATABASE, measured -- which is precisely
# the state between this DROP and the RESTORE after it. The second argument to
# ch_query exists for this.
ch_query "DROP DATABASE IF EXISTS $CH_DATABASE SYNC" default > /dev/null ||
  abort "ClickHouse" \
    "Could not drop the $CH_DATABASE database; the ClickHouse error is above."

# The window this comment describes is real but not avoidable: from here until
# the RESTORE returns there is no ClickHouse database at all. SYNC is what
# keeps it as short as it can be -- without it the DROP returns while the
# tables are still being detached and the RESTORE races it.
DATA_STATE="the ClickHouse database has been dropped and not yet restored, and Postgres is untouched. The app cannot start against it. Run this script again with the same backup."

DATA_STATE="the ClickHouse database was being restored and is either missing or half-restored; Postgres is untouched. Run this script again with the same backup."
ch_query "RESTORE DATABASE $CH_DATABASE FROM Disk('backups', '$CH_FILE')" default > /dev/null ||
  abort "ClickHouse" \
    "RESTORE DATABASE $CH_DATABASE failed; the ClickHouse error is above." \
    "The archive is still on the backups disk inside the container and the" \
    "backup directory is untouched, so this can simply be run again."

DATA_STATE="ClickHouse has been restored from the backup; Postgres has NOT been touched and is still current. Deleted people stay hidden, which is the safe half. Run this script again with the same backup to finish."

# --- Postgres --------------------------------------------------------------

say "Restoring Postgres..."

# The schema is dropped and recreated first, and `--clean --if-exists` alone
# is not a substitute. MEASURED, all four on this branch:
#
#   --clean --if-exists onto the live schema     rc=0, no output, and a table
#                                                that exists live but is not in
#                                                the dump SURVIVES the restore
#   --clean, no --if-exists, onto an empty one   rc=1 and 123 error lines
#   --clean --if-exists onto an empty one        rc=0 and ZERO error lines
#   DROP SCHEMA with no CREATE after it          rc=1 and 544 error lines
#
# The first line is the one that matters. `--clean` only drops what is IN the
# dump, so restoring an older backup leaves every object a later migration
# added still standing, holding rows from an era the restored
# `schema_migrations` says never happened -- and the next boot re-runs those
# migrations against tables that already exist. Dropping the schema makes this
# a replacement rather than an overlay, which is what the ClickHouse half
# already does and what the word restore ought to mean.
#
# The fourth line is why the CREATE is not optional: pg_dump's archive
# contains no SCHEMA entry at all (checked with `pg_restore -l`), so a dropped
# `public` is never recreated for you and the whole restore fails object by
# object.
#
# `--clean --if-exists` is kept anyway even though the schema is empty by
# then. It costs nothing measurable and it is the layer that still replaces
# objects if the drop above is ever weakened; the third line is the
# measurement that it is silent, which is why the noise the plan warned about
# does not appear.
#
# `client_min_messages=warning` only to keep the output readable: CASCADE
# announces every one of the fifteen objects it is taking with it, on stderr,
# in the middle of the one part of this script where a real diagnostic must not
# be scrolled past. Which objects are dropped is not news -- all of them are.
#
# THE MOST DANGEROUS STATEMENT IN THE SCRIPT, and the one whose state message
# used to be assigned after it. A signal delivered while this runs left the
# announcement saying "Postgres has NOT been touched and is still current …
# the safe half" over an empty Postgres with zero suppression rows -- measured.
DATA_STATE="ClickHouse has been restored and the Postgres schema was being dropped: Postgres may already be EMPTY, which means NO SUPPRESSION ROWS and every deleted person visible again. Run this script again with the same backup."
docker compose exec -T "$PG_SERVICE" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c client_min_messages=warning" \
     psql -U "$0" -d "$1" -v ON_ERROR_STOP=1 -q \
     -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public"' \
  "$PG_USER" "$PG_DATABASE" < /dev/null > /dev/null ||
  abort "Postgres" \
    "Could not drop and recreate the public schema; the Postgres error is above."

DATA_STATE="ClickHouse has been restored and the Postgres schema has been dropped but not yet refilled. Postgres is EMPTY, which means NO SUPPRESSION ROWS. Run this script again with the same backup."

# `--single-transaction` so the dump lands whole or not at all: a half-applied
# Postgres is the state with real teeth, because a partial `suppressed_persons`
# is a partial suppression list and nothing announces which rows are missing.
# It implies --exit-on-error, so the first genuine failure stops the run
# instead of being counted up and reported at the end.
#
# The one thing it does not cover is the drop above, which is its own
# statement and cannot be inside this transaction -- hence the state message
# on the line before, which names the only intermediate state that exists.
DATA_STATE="ClickHouse has been restored and Postgres was being refilled: it is either EMPTY or complete, and this run cannot tell which. If it is empty there are NO SUPPRESSION ROWS. Run this script again with the same backup."
docker compose exec -T "$PG_SERVICE" sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U "$0" -d "$1" \
     --clean --if-exists --no-owner --single-transaction' \
  "$PG_USER" "$PG_DATABASE" < "$SRC/postgres.dump" ||
  abort "Postgres" \
    "pg_restore failed; its error is above." \
    "Nothing of the dump was applied -- it ran in a single transaction -- so" \
    "the public schema is empty and this can be run again."

DATA_STATE="both stores have been restored from the backup"
# Both stores agree with each other from here, so the app may be started again
# even if what follows fails. See cleanup().
STORES_RESTORED=1

# --- Verification, with the app still stopped ------------------------------

say "Verifying row counts..."
verify_row_counts ||
  abort "verification" \
    "The restored row counts do not match the manifest; each difference is listed above." \
    "The data that was restored is what the backup contained -- this is a" \
    "mismatch between that and what the backup SAYS it contained, so treat the" \
    "backup as suspect rather than the restore."

remove_in_container_artefact
# `|| true` because the EXIT trap retries and owns the decision: a restart that
# fails here must not stop the operator being told the restore succeeded, and
# must not be reported as success either. The trap does both.
start_app_if_stopped || true

# The run reached its own ending, so the EXIT trap does not need to announce
# the state of the data -- the two lines below are that announcement, stated
# positively. Set BEFORE them rather than after: `say` cannot fail, but a
# signal can still land between two statements, and a run that has done
# everything and been killed on the last line is a finished restore, not a
# half-finished one.
RESTORE_COMPLETE=1

say "Restored from $SRC"
say "Both stores now match the backup taken at $STAMP."
