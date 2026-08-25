#!/bin/sh
set -eu

mode=${1:-start}
case "$mode" in
  start) [ "$#" -eq 0 ] || { printf 'INSIGHT startup refused: start takes no arguments\n' >&2; exit 1; } ;;
  restore) [ "$#" -eq 3 ] || { printf 'Usage: insight-entrypoint restore <dump> <manifest>\n' >&2; exit 1; } ;;
  restore-rollback) [ "$#" -eq 2 ] || { printf 'Usage: insight-entrypoint restore-rollback <rollback-database>\n' >&2; exit 1; } ;;
  *) printf 'INSIGHT startup refused: expected start, restore, or restore-rollback operation\n' >&2; exit 1 ;;
esac

fail() {
  printf 'INSIGHT startup refused: %s\n' "$1" >&2
  exit 1
}

volume=${INSIGHT_VOLUME:-/var/lib/insight}
case "$volume" in
  /*) ;;
  *) fail "INSIGHT_VOLUME must be an absolute path" ;;
esac
case "$volume" in
  *[!A-Za-z0-9_./-]* | "")
    fail "INSIGHT_VOLUME must be an absolute path without whitespace"
    ;;
esac

[ -d "$volume" ] || fail "required external volume is missing"
[ ! -L "$volume" ] || fail "external volume path must not be a symbolic link"
awk -v target="$volume" '$5 == target { found = 1 } END { exit !found }' /proc/self/mountinfo \
  || fail "required external volume is not mounted"

layout_file=$volume/layout-version
if [ -e "$layout_file" ]; then
  [ "$(tr -d '\r\n' < "$layout_file")" = "1" ] || fail "external volume layout is incompatible"
elif [ -n "$(find "$volume" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  fail "unrecognized non-empty external volume"
else
  printf '1\n' > "$layout_file" || fail "external volume is unwritable"
fi

database_dir=$volume/postgres
artifact_dir=$volume/artifacts
backup_dir=$volume/backups
maintenance_marker=${INSIGHT_MAINTENANCE_MARKER:-$database_dir/.restore-maintenance}
mkdir -p "$database_dir" "$artifact_dir" "$backup_dir" || fail "external volume is unwritable"
chown postgres:postgres "$database_dir"
chown insight:insight "$artifact_dir" "$backup_dir"
chmod 0700 "$database_dir"
chmod 0750 "$artifact_dir" "$backup_dir"

if [ "$mode" = "start" ] && [ -e "$maintenance_marker" ]; then
  fail "restore maintenance marker exists; complete restore or documented rollback before startup"
fi

gosu postgres sh -c "probe='$database_dir/.write-probe'; : > \"\$probe\" && rm -f \"\$probe\"" \
  || fail "database volume directory is unwritable"
for data_dir in "$artifact_dir" "$backup_dir"; do
  gosu insight sh -c "probe='$data_dir/.write-probe'; : > \"\$probe\" && rm -f \"\$probe\"" \
    || fail "application volume directory is unwritable"
done

fresh_database=0
if [ -e "$database_dir/PG_VERSION" ]; then
  [ "$(tr -d '\r\n' < "$database_dir/PG_VERSION")" = "16" ] \
    || fail "PostgreSQL data major is incompatible; expected 16"
elif [ -n "$(find "$database_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  fail "PostgreSQL data directory is corrupt or incomplete"
else
  fresh_database=1
  gosu postgres initdb -D "$database_dir" --auth-local=peer --auth-host=reject \
    --encoding=UTF8 --locale=C.UTF-8 >/dev/null \
    || fail "PostgreSQL initialization failed"
fi

install -d -o postgres -g postgres -m 0770 /run/postgresql
rm -f "$INSIGHT_WORKER_READY_FILE"

server_pid=
worker_pid=
postgres_started=0
cleanup() {
  trap - EXIT TERM INT
  [ -z "$server_pid" ] || kill -TERM "$server_pid" 2>/dev/null || true
  [ -z "$worker_pid" ] || kill -TERM "$worker_pid" 2>/dev/null || true
  [ -z "$server_pid" ] || wait "$server_pid" 2>/dev/null || true
  [ -z "$worker_pid" ] || wait "$worker_pid" 2>/dev/null || true
  if [ "$postgres_started" = "1" ]; then
    gosu postgres pg_ctl -D "$database_dir" -m fast -w stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 0' TERM INT

gosu postgres pg_ctl -D "$database_dir" \
  -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/run/postgresql" \
  -w start >/dev/null || fail "PostgreSQL failed to start; data may be corrupt"
postgres_started=1

if [ "$fresh_database" = "1" ]; then
  gosu postgres createuser --no-createdb --no-createrole --no-superuser insight
  gosu postgres createdb --owner=insight insight
fi

if [ "$mode" = "restore" ] || [ "$mode" = "restore-rollback" ]; then
  if [ "$mode" = "restore" ]; then
    [ -r "$2" ] || fail "backup dump is unreadable"
    [ -r "$3" ] || fail "backup manifest is unreadable"
    install -o postgres -g postgres -m 0640 /dev/null "$maintenance_marker"
    INSIGHT_RESTORE_ADMIN_DATABASE_URL='postgresql://postgres@localhost/postgres?host=%2Frun%2Fpostgresql' \
      gosu postgres node .tsbuild/server/database/restore-cli.js restore "$2" "$3" \
      || fail "database restore operation failed; maintenance mode remains active"
  else
    install -o postgres -g postgres -m 0640 /dev/null "$maintenance_marker"
    INSIGHT_RESTORE_ADMIN_DATABASE_URL='postgresql://postgres@localhost/postgres?host=%2Frun%2Fpostgresql' \
      gosu postgres node .tsbuild/server/database/restore-cli.js rollback "$2" \
      || fail "database restore operation failed; maintenance mode remains active"
  fi
  printf 'INSIGHT restore operation completed; displaced database name is reported above\n'
  exit 0
fi

gosu insight node .tsbuild/server/database/cli.js migrate \
  || fail "database migrations failed"

gosu insight node .tsbuild/server/worker.js &
worker_pid=$!
worker_wait=0
while [ ! -f "$INSIGHT_WORKER_READY_FILE" ]; do
  kill -0 "$worker_pid" 2>/dev/null || fail "worker failed during startup"
  worker_wait=$((worker_wait + 1))
  [ "$worker_wait" -lt 30 ] || fail "worker readiness timed out"
  sleep 1
done

gosu insight node .tsbuild/server/index.js &
server_pid=$!

while kill -0 "$server_pid" 2>/dev/null \
  && kill -0 "$worker_pid" 2>/dev/null \
  && gosu postgres pg_ctl -D "$database_dir" status >/dev/null 2>&1; do
  sleep 1
done
fail "application, worker, or PostgreSQL process exited"
