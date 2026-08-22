#!/bin/sh
set -eu

image=${INSIGHT_IMAGE:-insight:container-smoke}
run_id=$$
success_name=insight-smoke-success-$run_id
missing_name=insight-smoke-missing-$run_id
readonly_name=insight-smoke-readonly-$run_id
incompatible_name=insight-smoke-incompatible-$run_id
smoke_root=$(mktemp -d)
success_volume=$smoke_root/success
readonly_volume=$smoke_root/readonly
incompatible_volume=$smoke_root/incompatible

cleanup() {
  docker rm -f "$success_name" "$missing_name" "$readonly_name" "$incompatible_name" \
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
  --env INSIGHT_OFFICIAL_IDENTIFIER_TYPE=RESEARCH_ID \
  --env INSIGHT_OFFICIAL_IDENTIFIER_ISSUER=INSIGHT_TEST \
  --env 'INSIGHT_OFFICIAL_IDENTIFIER_PATTERN=^SYNTHETIC-[0-9]{6}$' \
  --env INSIGHT_OFFICIAL_IDENTIFIER_NORMALIZATION=NFKC_UPPERCASE \
  --mount "type=bind,src=$success_volume,dst=/var/lib/insight" "$image" >/dev/null
if ! wait_ready "$success_name"; then
  docker logs "$success_name" >&2 || true
  fail "fresh volume did not reach readiness"
fi
[ "$(docker exec -u postgres "$success_name" sh -c "tr -d '\\r\\n' < /var/lib/insight/postgres/PG_VERSION")" = "16" ] \
  || fail "fresh volume did not initialize PostgreSQL 16"
[ -d "$success_volume/artifacts" ] || fail "artifact directory is missing"

docker exec -u postgres "$success_name" psql -v ON_ERROR_STOP=1 -d insight \
  -c "CREATE TABLE container_smoke_persistence (value text PRIMARY KEY); INSERT INTO container_smoke_persistence VALUES ('preserved');" \
  >/dev/null
docker stop -t 20 "$success_name" >/dev/null
docker rm "$success_name" >/dev/null
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
[ "$(docker exec -u postgres "$success_name" psql -At -d insight -c 'SELECT value FROM container_smoke_persistence')" = "preserved" ] \
  || fail "replacement container lost database files"

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
