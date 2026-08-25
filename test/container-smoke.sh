#!/bin/sh
set -eu

image=${INSIGHT_IMAGE:-insight:container-smoke}
run_id=$$
success_name=insight-smoke-success-$run_id
missing_name=insight-smoke-missing-$run_id
readonly_name=insight-smoke-readonly-$run_id
incompatible_name=insight-smoke-incompatible-$run_id
restore_name=insight-smoke-restore-$run_id
smoke_root=$(mktemp -d)
success_volume=$smoke_root/success
readonly_volume=$smoke_root/readonly
incompatible_volume=$smoke_root/incompatible

cleanup() {
  docker rm -f "$success_name" "$missing_name" "$readonly_name" "$incompatible_name" "$restore_name" \
    >/dev/null 2>&1 || true
  for cleanup_volume in "$success_volume" "$readonly_volume" "$incompatible_volume"; do
    if [ -d "$cleanup_volume" ] && docker image inspect "$image" >/dev/null 2>&1; then
      docker run --rm --entrypoint chmod \
        --mount "type=bind,src=$cleanup_volume,dst=/var/lib/insight" \
        "$image" -R a+rwx /var/lib/insight >/dev/null 2>&1 || true
    fi
  done
  case "$smoke_root" in
    /tmp/*) rm -rf "$smoke_root" ;;
  esac
}
trap cleanup EXIT TERM INT

fail() {
  printf 'container smoke failed: %s\n' "$1" >&2
  exit 1
}

wait_ready() {
  wait_name=$1
  wait_count=0
  while [ "$wait_count" -lt 60 ]; do
    if docker exec "$wait_name" node -e \
      "fetch('http://127.0.0.1:3000/api/v1/ready').then(async r=>{const b=await r.json();if(!r.ok||b.checks?.database!=='ready'||b.checks?.worker!=='ready')process.exit(1)}).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$wait_name" 2>/dev/null || true)" = "true" ] \
      || return 1
    wait_count=$((wait_count + 1))
    sleep 1
  done
  return 1
}

docker build --tag "$image" .

if docker image inspect --format '{{json .Config.Env}}' "$image" \
  | grep -Eiq '(OPENAI|PROVIDER|API_KEY|TOKEN|PASSWORD|SECRET)='; then
  fail "provider credential variable is baked into image"
fi
docker run --rm --entrypoint node "$image" -e \
  "for(const name of ['electron','typescript']){try{require.resolve(name);process.exit(1)}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error}}"
docker run --rm --entrypoint sh "$image" -c 'test ! -e /opt/insight/Bayesian-Engine'

mkdir -p "$success_volume"
docker run -d --name "$success_name" \
  --memory 768m --cpus 1 --pids-limit 256 \
  --env INSIGHT_OFFICIAL_IDENTIFIER_TYPE=RESEARCH_ID \
  --env INSIGHT_OFFICIAL_IDENTIFIER_ISSUER=INSIGHT_TEST \
  --env 'INSIGHT_OFFICIAL_IDENTIFIER_PATTERN=^SYNTHETIC-[0-9]{6}$' \
  --env INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION=NFKC_UPPERCASE \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" >/dev/null
if ! wait_ready "$success_name"; then
  docker logs "$success_name" >&2 || true
  fail "fresh volume did not reach readiness"
fi
[ "$(docker inspect -f '{{.HostConfig.Memory}}' "$success_name")" = "805306368" ] \
  || fail "container memory limit is missing"
[ "$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$success_name")" = "1000000000" ] \
  || fail "container CPU limit is missing"
[ "$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$success_name")" = "256" ] \
  || fail "container PID limit is missing"
[ "$(docker exec -u postgres "$success_name" sh -c "tr -d '\\r\\n' < /var/lib/insight/postgres/PG_VERSION")" = "16" ] \
  || fail "fresh volume did not initialize PostgreSQL 16"
[ -d "$success_volume/artifacts" ] || fail "artifact directory is missing"

docker exec "$success_name" sh -c ': > /run/insight/maintenance'
docker exec "$success_name" node -e '
Promise.all([
  fetch("http://127.0.0.1:3000/api/v1/login", { method: "POST" }),
  fetch("http://127.0.0.1:3000/api/v1/ready"),
]).then(async ([ordinary, ready]) => {
  const ordinaryBody = await ordinary.json();
  const readyBody = await ready.json();
  if (ordinary.status !== 503 || ordinaryBody.error?.code !== "MAINTENANCE") process.exit(1);
  if (ready.status !== 503 || readyBody.checks?.application !== "not_ready") process.exit(1);
}).catch(() => process.exit(1));
' || fail "runtime maintenance did not block ordinary traffic"
docker exec "$success_name" rm /run/insight/maintenance
wait_ready "$success_name" || fail "container did not leave runtime maintenance"

docker exec -u postgres "$success_name" pg_ctl -D /var/lib/insight/postgres -m immediate -w stop \
  >/dev/null
database_crash_wait=0
while [ "$(docker inspect -f '{{.State.Running}}' "$success_name")" = "true" ] \
  && [ "$database_crash_wait" -lt 20 ]; do
  database_crash_wait=$((database_crash_wait + 1))
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$success_name")" = "false" ] \
  || fail "database outage did not make container unhealthy"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$success_name")" != "0" ] \
  || fail "database outage produced a successful container exit"
docker rm "$success_name" >/dev/null
docker run -d --name "$success_name" \
  --env INSIGHT_OFFICIAL_IDENTIFIER_TYPE=RESEARCH_ID \
  --env INSIGHT_OFFICIAL_IDENTIFIER_ISSUER=INSIGHT_TEST \
  --env 'INSIGHT_OFFICIAL_IDENTIFIER_PATTERN=^SYNTHETIC-[0-9]{6}$' \
  --env INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION=NFKC_UPPERCASE \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" >/dev/null
wait_ready "$success_name" || fail "container did not recover after database crash"

docker exec -u insight "$success_name" psql -v ON_ERROR_STOP=1 -d insight \
  -c "CREATE TABLE insight.container_smoke_persistence (value text PRIMARY KEY); INSERT INTO insight.container_smoke_persistence VALUES ('preserved');" \
  >/dev/null
backup_id=$(docker exec "$success_name" node -e '
(async () => {
const base = "http://127.0.0.1:3000/api/v1";
const request = async (path, options = {}) => {
  const response = await fetch(base + path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
  return { response, body };
};
const denied = await fetch(base + "/admin/backups", { method: "POST" });
if (denied.status !== 401) throw new Error(`unauthenticated backup returned ${denied.status}`);
let login = await request("/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
let cookie = login.response.headers.get("set-cookie").split(";", 1)[0];
let changed = await request("/session/password", {
  method: "POST",
  headers: {
    cookie,
    "content-type": "application/json",
    "x-csrf-token": login.body.csrfToken,
  },
  body: JSON.stringify({ password: "container-backup-password" }),
});
cookie = changed.response.headers.get("set-cookie").split(";", 1)[0];
const started = await request("/admin/backups", {
  method: "POST",
  headers: { cookie, "x-csrf-token": changed.body.csrfToken },
});
for (let attempt = 0; attempt < 100; attempt += 1) {
  const status = await request(`/admin/backups/${started.body.backup.id}`, { headers: { cookie } });
  if (status.body.backup.status === "COMPLETED") {
    process.stdout.write(started.body.backup.id);
    process.exit(0);
  }
  if (status.body.backup.status === "FAILED") throw new Error("production backup failed");
  await new Promise(resolve => setTimeout(resolve, 100));
}
throw new Error("production backup timed out");
})().catch(error => { console.error(error.message); process.exit(1); });
')
docker exec "$success_name" node -e '
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const id = process.argv[1];
const root = "/var/lib/insight/backups";
const manifest = JSON.parse(readFileSync(`${root}/${id}.manifest.json`, "utf8"));
const dump = readFileSync(`${root}/${id}.dump`);
if (manifest.applicationVersion !== "0.1.0" || manifest.postgresMajor !== 16 || manifest.migrationHead !== 36) process.exit(1);
if (manifest.byteLength !== statSync(`${root}/${id}.dump`).size) process.exit(1);
if (manifest.sha256 !== createHash("sha256").update(dump).digest("hex")) process.exit(1);
' "$backup_id" || fail "backup manifest or SHA-256 is invalid"
docker exec "$success_name" pg_restore --list "/var/lib/insight/backups/$backup_id.dump" >/dev/null \
  || fail "PostgreSQL custom-format backup could not be inspected"
docker exec "$success_name" sh -c \
  "pg_restore --list '/var/lib/insight/backups/$backup_id.dump' | grep -q 'application_encryption_keys'" \
  || fail "database-held master key table is absent from backup"
docker exec -u insight "$success_name" psql -v ON_ERROR_STOP=1 -d insight \
  -c "UPDATE insight.container_smoke_persistence SET value = 'modified-after-backup';" >/dev/null
docker stop -t 20 "$success_name" >/dev/null
docker rm "$success_name" >/dev/null
docker run --rm --entrypoint gosu \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" \
  "$image" postgres pg_controldata /var/lib/insight/postgres \
  | grep -q 'Database cluster state:.*shut down' \
  || fail "SIGTERM did not leave PostgreSQL cleanly shut down"
if ! docker run --name "$restore_name" \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" \
  restore "/var/lib/insight/backups/$backup_id.dump" \
  "/var/lib/insight/backups/$backup_id.manifest.json" \
  >"$smoke_root/restore.log" 2>&1; then
  cat "$smoke_root/restore.log" >&2
  fail "maintenance restore failed"
fi
docker rm "$restore_name" >/dev/null
grep -q '"status":"RESTORED"' "$smoke_root/restore.log" \
  || fail "maintenance restore did not report completion"
[ ! -e "$success_volume/postgres/.restore-maintenance" ] \
  || fail "successful restore left maintenance marker"
docker run -d --name "$success_name" \
  --env INSIGHT_OFFICIAL_IDENTIFIER_TYPE=RESEARCH_ID \
  --env INSIGHT_OFFICIAL_IDENTIFIER_ISSUER=INSIGHT_TEST \
  --env 'INSIGHT_OFFICIAL_IDENTIFIER_PATTERN=^SYNTHETIC-[0-9]{6}$' \
  --env INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION=NFKC_UPPERCASE \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" >/dev/null
if ! wait_ready "$success_name"; then
  docker logs "$success_name" >&2 || true
  fail "replacement container did not reach readiness"
fi
[ "$(docker exec -u insight "$success_name" psql -At -d insight -c 'SELECT value FROM insight.container_smoke_persistence')" = "preserved" ] \
  || fail "full restore did not replace modified rows"
rollback_database=$(grep -m 1 -o 'insight_rollback_[0-9a-f]*' "$smoke_root/restore.log")
[ -n "$rollback_database" ] || fail "restore did not report rollback database"
[ "$(docker exec -u postgres "$success_name" psql -At -d "$rollback_database" -c 'SELECT value FROM insight.container_smoke_persistence')" = "modified-after-backup" ] \
  || fail "restore rollback database did not preserve displaced rows"

docker exec "$success_name" node -e '
const fs = require("node:fs");
for (const entry of fs.readdirSync("/proc")) {
  if (!/^\d+$/.test(entry)) continue;
  try {
    const command = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8");
    if (command.includes(".tsbuild/server/worker.js")) process.kill(Number(entry), "SIGKILL");
  } catch {}
}
'
crash_wait=0
while [ "$(docker inspect -f '{{.State.Running}}' "$success_name")" = "true" ] \
  && [ "$crash_wait" -lt 20 ]; do
  crash_wait=$((crash_wait + 1))
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$success_name")" = "false" ] \
  || fail "supervisor did not stop after worker crash"
[ "$(docker inspect -f '{{.State.ExitCode}}' "$success_name")" != "0" ] \
  || fail "worker crash produced a successful container exit"
docker rm "$success_name" >/dev/null
docker run -d --name "$success_name" \
  --env INSIGHT_OFFICIAL_IDENTIFIER_TYPE=RESEARCH_ID \
  --env INSIGHT_OFFICIAL_IDENTIFIER_ISSUER=INSIGHT_TEST \
  --env 'INSIGHT_OFFICIAL_IDENTIFIER_PATTERN=^SYNTHETIC-[0-9]{6}$' \
  --env INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION=NFKC_UPPERCASE \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" >/dev/null
wait_ready "$success_name" || fail "container did not recover after worker crash"
docker exec -u postgres "$success_name" sh -c ': > /var/lib/insight/postgres/.restore-maintenance'
docker stop -t 20 "$success_name" >/dev/null
docker rm "$success_name" >/dev/null
if docker run --name "$restore_name" \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" \
  >"$smoke_root/maintenance.log" 2>&1; then
  fail "normal startup ignored restore maintenance marker"
fi
grep -q "restore maintenance marker exists" "$smoke_root/maintenance.log" \
  || fail "maintenance startup block was not explicit"
docker rm "$restore_name" >/dev/null

if docker run --name "$missing_name" "$image" >"$smoke_root/missing.log" 2>&1; then
  fail "startup without external volume succeeded"
fi
grep -q "required external volume is not mounted" "$smoke_root/missing.log" \
  || fail "missing-volume failure was not explicit"

mkdir -p "$readonly_volume/postgres" "$readonly_volume/artifacts" "$readonly_volume/backups"
printf '1\n' > "$readonly_volume/layout-version"
if docker run --name "$readonly_name" \
  --mount "type=bind,src=$readonly_volume,dst=/var/lib/insight,readonly" "$image" \
  >"$smoke_root/readonly.log" 2>&1; then
  fail "startup with read-only volume succeeded"
fi

mkdir -p "$incompatible_volume/postgres"
printf '1\n' > "$incompatible_volume/layout-version"
printf '15\n' > "$incompatible_volume/postgres/PG_VERSION"
if docker run --name "$incompatible_name" \
  --mount "type=bind,src=$incompatible_volume,dst=/var/lib/insight" "$image" \
  >"$smoke_root/incompatible.log" 2>&1; then
  fail "startup with incompatible PostgreSQL data succeeded"
fi
grep -q "PostgreSQL data major is incompatible" "$smoke_root/incompatible.log" \
  || fail "incompatible-volume failure was not explicit"

printf 'container smoke passed\n'
