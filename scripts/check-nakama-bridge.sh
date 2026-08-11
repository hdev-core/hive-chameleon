#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/runtime/nakama/compose.yaml"
application_compose_file="${repository_root}/infra/postgres/compose.yaml"
project_name="${HIVE_CHAMELEON_NAKAMA_PROJECT:-hive-chameleon-nakama-smoke-$$}"
application_project_name="${project_name}-application"
keep_stack="${HIVE_CHAMELEON_KEEP_STACK:-0}"
state_file="${HIVE_CHAMELEON_DEV_STATE_FILE:-${TMPDIR:-/tmp}/hive-chameleon-authoritative-dev.env}"
api_log="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-api-smoke.XXXXXX")"
nakama_log="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-nakama-smoke.XXXXXX")"
api_pid=""

if [[ "${keep_stack}" != "0" && "${keep_stack}" != "1" ]]; then
  echo "HIVE_CHAMELEON_KEEP_STACK must be 0 or 1." >&2
  exit 1
fi

umask 077

compose() {
  docker compose \
    --project-name "${project_name}" \
    --file "${compose_file}" \
    "$@"
}

application_compose() {
  docker compose \
    --project-name "${application_project_name}" \
    --file "${application_compose_file}" \
    "$@"
}

redact_log() {
  node - "$1" <<'NODE'
const fs = require('node:fs');

const secretNames = [
  'NAKAMA_DATABASE_PASSWORD',
  'NAKAMA_SERVER_KEY',
  'NAKAMA_RUNTIME_HTTP_KEY',
  'NAKAMA_BRIDGE_HMAC_KEY',
  'NAKAMA_SESSION_ENCRYPTION_KEY',
  'NAKAMA_REFRESH_ENCRYPTION_KEY',
  'NAKAMA_CONSOLE_PASSWORD',
  'NAKAMA_CONSOLE_SIGNING_KEY',
  'HC_NAKAMA_DATABASE_URL',
  'AUTH_TOKEN_SECRET',
  'AUTH_IDENTITY_LOOKUP_KEY',
];

let output = fs.readFileSync(process.argv[2], 'utf8');
for (const name of secretNames) {
  const secret = process.env[name];
  if (secret) {
    output = output.split(secret).join('[REDACTED]');
  }
}

const lines = output.trimEnd().split('\n').slice(-80).join('\n');
if (lines) {
  process.stderr.write(`${lines}\n`);
}
NODE
}

cleanup() {
  local status=$?
  local cleanup_status=0

  trap - EXIT INT TERM

  if [[ ${status} -eq 0 && "${keep_stack}" == "1" ]]; then
    echo "Authoritative development stack is running."
    echo "Runtime state: ${state_file}"
    exit 0
  fi

  if [[ -n "${api_pid}" ]] && kill -0 "${api_pid}" 2>/dev/null; then
    kill "${api_pid}" 2>/dev/null || true
    wait "${api_pid}" 2>/dev/null || true
  fi

  if [[ ${status} -ne 0 && -s "${api_log}" ]]; then
    echo "NestJS smoke log (credentials redacted):" >&2
    redact_log "${api_log}"
  fi
  if [[ ${status} -ne 0 ]]; then
    compose logs --no-color --tail 120 nakama >"${nakama_log}" 2>&1 || true
    if [[ -s "${nakama_log}" ]]; then
      echo "Nakama smoke log (credentials redacted):" >&2
      redact_log "${nakama_log}"
    fi
  fi

  compose down --volumes --remove-orphans --rmi local || cleanup_status=$?
  application_compose down --volumes --remove-orphans || cleanup_status=$?
  rm -f "${api_log}" "${nakama_log}" "${state_file}"

  if [[ ${status} -eq 0 && ${cleanup_status} -ne 0 ]]; then
    status=${cleanup_status}
  fi
  exit "${status}"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

random_hex() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(Number(process.argv[1])).toString('hex'))" "$1"
}

random_base64url() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(Number(process.argv[1])).toString('base64url'))" "$1"
}

random_uuid_v7() {
  node <<'NODE'
const { randomBytes } = require('node:crypto');

const bytes = randomBytes(16);
let timestamp = BigInt(Date.now());
for (let index = 5; index >= 0; index -= 1) {
  bytes[index] = Number(timestamp & 0xffn);
  timestamp >>= 8n;
}
bytes[6] = (bytes[6] & 0x0f) | 0x70;
bytes[8] = (bytes[8] & 0x3f) | 0x80;

const hex = bytes.toString('hex');
process.stdout.write(
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
);
NODE
}

free_port() {
  node <<'NODE'
const net = require('node:net');

const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  server.close(() => process.stdout.write(String(address.port)));
});
NODE
}

create_access_token() {
  node - "$1" "$2" <<'NODE'
const { createHmac } = require('node:crypto');

const playerId = process.argv[2];
const sessionId = process.argv[3];
const now = Math.floor(Date.now() / 1_000);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(
  JSON.stringify({
    aud: 'hive-chameleon-client',
    exp: now + 3_600,
    iat: now,
    iss: 'hive-chameleon-api',
    sid: sessionId,
    sub: playerId,
    typ: 'access',
  }),
).toString('base64url');
const signingInput = `${header}.${payload}`;
const signature = createHmac(
  'sha256',
  Buffer.from(process.env.AUTH_TOKEN_SECRET, 'base64url'),
)
  .update(signingInput)
  .digest('base64url');
process.stdout.write(`${signingInput}.${signature}`);
NODE
}

write_dev_state() {
  local host_access_token
  local guest_access_token

  host_access_token="$(create_access_token "${SMOKE_PLAYER_ID}" "${SMOKE_AUTH_SESSION_ID}")"
  guest_access_token="$(
    create_access_token "${SMOKE_PLAYER_TWO_ID}" "${SMOKE_AUTH_SESSION_TWO_ID}"
  )"

  {
    printf 'export HIVE_CHAMELEON_REPOSITORY_ROOT=%q\n' "${repository_root}"
    printf 'export HIVE_CHAMELEON_NAKAMA_PROJECT=%q\n' "${project_name}"
    printf 'export HIVE_CHAMELEON_APPLICATION_PROJECT=%q\n' "${application_project_name}"
    printf 'export HIVE_CHAMELEON_API_PID=%q\n' "${api_pid}"
    printf 'export HIVE_CHAMELEON_API_LOG=%q\n' "${api_log}"
    printf 'export HIVE_CHAMELEON_WEBGL_PORT=%q\n' "${HIVE_CHAMELEON_WEBGL_PORT}"
    printf 'export HIVE_CHAMELEON_API_URL=%q\n' "${HIVE_CHAMELEON_API_URL}"
    printf 'export PORT=%q\n' "${PORT}"
    printf 'export HTTP_CORS_ALLOWED_ORIGINS=%q\n' "${HTTP_CORS_ALLOWED_ORIGINS}"
    printf 'export NAKAMA_HTTP_URL=%q\n' "${NAKAMA_HTTP_URL}"
    printf 'export NAKAMA_SOCKET_URL=%q\n' "${NAKAMA_SOCKET_URL}"
    printf 'export NAKAMA_SERVER_KEY=%q\n' "${NAKAMA_SERVER_KEY}"
    printf 'export REALTIME_DEV_BEARER_TOKEN_HOST=%q\n' "${host_access_token}"
    printf 'export REALTIME_DEV_BEARER_TOKEN_GUEST=%q\n' "${guest_access_token}"
    printf 'export NAKAMA_DATABASE_PASSWORD=%q\n' "${NAKAMA_DATABASE_PASSWORD}"
    printf 'export NAKAMA_RUNTIME_HTTP_KEY=%q\n' "${NAKAMA_RUNTIME_HTTP_KEY}"
    printf 'export NAKAMA_BRIDGE_HMAC_KEY=%q\n' "${NAKAMA_BRIDGE_HMAC_KEY}"
    printf 'export NAKAMA_SESSION_ENCRYPTION_KEY=%q\n' "${NAKAMA_SESSION_ENCRYPTION_KEY}"
    printf 'export NAKAMA_REFRESH_ENCRYPTION_KEY=%q\n' "${NAKAMA_REFRESH_ENCRYPTION_KEY}"
    printf 'export NAKAMA_CONSOLE_USERNAME=%q\n' "${NAKAMA_CONSOLE_USERNAME}"
    printf 'export NAKAMA_CONSOLE_PASSWORD=%q\n' "${NAKAMA_CONSOLE_PASSWORD}"
    printf 'export NAKAMA_CONSOLE_SIGNING_KEY=%q\n' "${NAKAMA_CONSOLE_SIGNING_KEY}"
    printf 'export NAKAMA_API_PORT=%q\n' "${NAKAMA_API_PORT}"
    printf 'export NAKAMA_CONSOLE_PORT=%q\n' "${NAKAMA_CONSOLE_PORT}"
    printf 'export NAKAMA_METRICS_PORT=%q\n' "${NAKAMA_METRICS_PORT}"
    printf 'export HC_POSTGRES_PORT=%q\n' "${HC_POSTGRES_PORT}"
    printf 'export HC_NAKAMA_DATABASE_URL=%q\n' "${HC_NAKAMA_DATABASE_URL}"
    printf 'export DATABASE_URL=%q\n' "${DATABASE_URL}"
    printf 'export AUTH_TOKEN_SECRET=%q\n' "${AUTH_TOKEN_SECRET}"
    printf 'export AUTH_IDENTITY_LOOKUP_KEY=%q\n' "${AUTH_IDENTITY_LOOKUP_KEY}"
  } >"${state_file}"
  chmod 600 "${state_file}"
}

wait_for_nakama() {
  local deadline=$((SECONDS + 120))
  local container_id
  local health

  while ((SECONDS < deadline)); do
    container_id="$(compose ps --quiet nakama 2>/dev/null || true)"
    if [[ -n "${container_id}" ]]; then
      health="$(
        docker inspect \
          --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
          "${container_id}" 2>/dev/null || true
      )"
      if [[ "${health}" == "healthy" ]]; then
        return 0
      fi
      if [[ "${health}" == "exited" || "${health}" == "dead" ]]; then
        break
      fi
    fi
    sleep 1
  done

  echo "Nakama did not become healthy within 120 seconds." >&2
  return 1
}

wait_for_api() {
  local deadline=$((SECONDS + 60))
  local readiness_url="${HIVE_CHAMELEON_API_URL}/api/v1/health/ready"

  while ((SECONDS < deadline)); do
    if curl --fail --silent --show-error "${readiness_url}" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${api_pid}" 2>/dev/null; then
      echo "NestJS exited before becoming ready." >&2
      return 1
    fi
    sleep 1
  done

  echo "NestJS did not become ready within 60 seconds." >&2
  return 1
}

export NAKAMA_DATABASE_PASSWORD="$(random_hex 24)"
export NAKAMA_SERVER_KEY="$(random_hex 24)"
export NAKAMA_RUNTIME_HTTP_KEY="$(random_hex 24)"
export NAKAMA_BRIDGE_HMAC_KEY="$(random_base64url 32)"
export NAKAMA_SESSION_ENCRYPTION_KEY="$(random_hex 32)"
export NAKAMA_REFRESH_ENCRYPTION_KEY="$(random_hex 32)"
export NAKAMA_CONSOLE_USERNAME="local-admin"
export NAKAMA_CONSOLE_PASSWORD="$(random_hex 24)"
export NAKAMA_CONSOLE_SIGNING_KEY="$(random_hex 32)"
export NAKAMA_API_PORT="$(free_port)"
export NAKAMA_CONSOLE_PORT=0
export NAKAMA_METRICS_PORT=0

export NODE_ENV=development
export SMOKE_PLAYER_ID="$(random_uuid_v7)"
export SMOKE_PLAYER_TWO_ID="$(random_uuid_v7)"
export SMOKE_AUTH_SESSION_ID="$(random_uuid_v7)"
export SMOKE_AUTH_SESSION_TWO_ID="$(random_uuid_v7)"
export AUTH_TOKEN_SECRET="$(random_base64url 32)"
export AUTH_IDENTITY_LOOKUP_KEY="$(random_base64url 32)"
export HC_POSTGRES_PORT="$(free_port)"
export HIVE_CHAMELEON_WEBGL_PORT="$(free_port)"
export HTTP_CORS_ALLOWED_ORIGINS="http://127.0.0.1:${HIVE_CHAMELEON_WEBGL_PORT}"
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${HC_POSTGRES_PORT}/hive_chameleon?sslmode=disable"
export HC_NAKAMA_DATABASE_URL="postgres://postgres:postgres@host.docker.internal:${HC_POSTGRES_PORT}/hive_chameleon?sslmode=disable"

cd "${repository_root}"

backend_map_content_version="$(
  sed -n 's/.*defaultOfficialMapContentVersion = "\([^"]*\)".*/\1/p' \
    runtime/nakama/lobby_store.go \
    | head -n 1
)"
unity_map_content_version="$(
  sed -n 's/.*public const string ContentVersion = "\([^"]*\)".*/\1/p' \
    clients/unity/Assets/HiveChameleon/Runtime/Presentation/CityDistrictMap.cs \
    | head -n 1
)"
backend_geometry_version="$(
  sed -n 's/.*officialAuthorityGeometryVersion *= "\([^"]*\)".*/\1/p' \
    runtime/nakama/authority_geometry.go \
    | head -n 1
)"
unity_geometry_version="$(
  sed -n 's/.*public const string AuthorityGeometryVersion *= *//p' \
    clients/unity/Assets/HiveChameleon/Runtime/Presentation/CityDistrictMap.cs \
    | head -n 1
)"
if [[ -z "${unity_geometry_version}" ]]; then
  unity_geometry_version="$(
    sed -n '/public const string AuthorityGeometryVersion/{n;s/^[[:space:]]*"\([^"]*\)";.*/\1/p;}' \
      clients/unity/Assets/HiveChameleon/Runtime/Presentation/CityDistrictMap.cs \
      | head -n 1
  )"
fi
backend_geometry_digest="$(
  sed -n 's/.*officialAuthorityGeometryExpectedDigest *= "\([^"]*\)".*/\1/p' \
    runtime/nakama/authority_geometry.go \
    | head -n 1
)"
unity_geometry_digest="$(
  sed -n '/public const string AuthorityGeometryDigest/{n;s/^[[:space:]]*"\([^"]*\)";.*/\1/p;}' \
    clients/unity/Assets/HiveChameleon/Runtime/Presentation/CityDistrictMap.cs \
    | head -n 1
)"
backend_build_version="$(
  sed -n 's/.*gameServerBuildVersion *= "\([^"]*\)".*/\1/p' \
    runtime/nakama/round_scaffold.go \
    | head -n 1
)"
unity_build_version="$(
  sed -n '/public const string SupportedGameServerBuildVersion/{n;s/^[[:space:]]*"\([^"]*\)";.*/\1/p;}' \
    clients/unity/Assets/HiveChameleon/Runtime/Realtime/LobbyMenuRules.cs \
    | head -n 1
)"
backend_protocol_version="$(
  sed -n 's/.*matchProtocolVersion *= "\([^"]*\)".*/\1/p' \
    runtime/nakama/round_scaffold.go \
    | head -n 1
)"
unity_protocol_version="$(
  sed -n 's/.*public const string SupportedProtocolVersion = "\([^"]*\)".*/\1/p' \
    clients/unity/Assets/HiveChameleon/Runtime/Realtime/LobbyMenuRules.cs \
    | head -n 1
)"

assert_runtime_contract() {
  local label="$1"
  local backend_value="$2"
  local unity_value="$3"

  if [[ -z "${backend_value}" \
     || -z "${unity_value}" \
     || "${backend_value}" != "${unity_value}" ]]; then
    echo "Backend and Unity ${label} values must match." >&2
    echo "Backend: ${backend_value:-missing}" >&2
    echo "Unity: ${unity_value:-missing}" >&2
    exit 1
  fi
}

assert_runtime_contract \
  "official map content version" \
  "${backend_map_content_version}" \
  "${unity_map_content_version}"
assert_runtime_contract \
  "authority geometry version" \
  "${backend_geometry_version}" \
  "${unity_geometry_version}"
assert_runtime_contract \
  "authority geometry digest" \
  "${backend_geometry_digest}" \
  "${unity_geometry_digest}"
assert_runtime_contract \
  "game-server build version" \
  "${backend_build_version}" \
  "${unity_build_version}"
assert_runtime_contract \
  "realtime protocol version" \
  "${backend_protocol_version}" \
  "${unity_protocol_version}"

echo "Building the NestJS bridge and isolated Nakama runtime..."
npm run build --workspace @hive-chameleon/api
application_compose up --detach postgres
application_compose run --rm dbmate
application_compose exec --no-TTY postgres psql \
  -U postgres \
  -d hive_chameleon \
  -v ON_ERROR_STOP=1 \
  -v player_id="${SMOKE_PLAYER_ID}" \
  -v player_two_id="${SMOKE_PLAYER_TWO_ID}" \
  -v session_id="${SMOKE_AUTH_SESSION_ID}" \
  -v session_two_id="${SMOKE_AUTH_SESSION_TWO_ID}" <<'SQL'
INSERT INTO identity.player (id, hive_username, hive_control_state) VALUES
  (:'player_id', 'smoke-user', 'external_self_custodial'),
  (:'player_two_id', 'smoke-user-two', 'external_self_custodial');

INSERT INTO identity.auth_session (
  id, player_id, refresh_token_hash, platform, authentication_method,
  hive_signing_provider, hive_control_state_at_issue, custodial_signing_eligible,
  issued_at, expires_at
) VALUES
  (
    :'session_id', :'player_id', repeat('a', 64), 'linux', 'direct_hive_challenge',
    'keychain', 'external_self_custodial', false, now(), now() + interval '1 hour'
  ),
  (
    :'session_two_id', :'player_two_id', repeat('b', 64), 'linux',
    'direct_hive_challenge', 'keychain', 'external_self_custodial', false,
    now(), now() + interval '1 hour'
  );
SQL
compose up --build --detach nakama
wait_for_nakama
export SMOKE_NAKAMA_CONTAINER_ID="$(compose ps --quiet nakama)"
if [[ -z "${SMOKE_NAKAMA_CONTAINER_ID}" ]]; then
  echo "Could not resolve the Nakama container ID for restart recovery." >&2
  exit 1
fi

nakama_binding="$(compose port nakama 7350)"
nakama_port="${nakama_binding##*:}"
if [[ ! "${nakama_port}" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve Nakama's ephemeral host port." >&2
  exit 1
fi

api_port="$(free_port)"
export PORT="${api_port}"
export HIVE_CHAMELEON_API_URL="http://127.0.0.1:${api_port}"
export NAKAMA_HTTP_URL="http://127.0.0.1:${nakama_port}"
export NAKAMA_SOCKET_URL="ws://127.0.0.1:${nakama_port}/ws"

if [[ "${keep_stack}" == "1" ]]; then
  nohup node apps/api/dist/main.js >"${api_log}" 2>&1 </dev/null &
else
  node apps/api/dist/main.js >"${api_log}" 2>&1 &
fi
api_pid=$!
wait_for_api

echo "Exercising the NestJS-to-Nakama bridge contract..."
node runtime/nakama/smoke.mjs
application_compose exec --no-TTY postgres psql \
  -U postgres \
  -d hive_chameleon \
  -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  round_count integer;
  invalid_round_count integer;
  participant_count integer;
  reconnected_participant_count integer;
  scored_like_count integer;
  discovery_count integer;
  like_count integer;
  revision_count integer;
  live_checkpoint_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (
           WHERE status <> 'completed'
              OR sequence_number <> 1
              OR hunter_count <> 1
              OR winning_side <> 'hunters'
              OR ended_at IS NULL
              OR canonical_result_sha256 IS NULL
              OR game_server_build_version <> 'hive-chameleon-m4-dev'
              OR protocol_version <> 'm4-v2'
              OR result_schema_version <> 'match-result-1'
              OR scoring_rule_version <> 'scoring-1'
         )
    INTO round_count, invalid_round_count
    FROM game.game_round;

  SELECT count(*),
         count(*) FILTER (WHERE reconnected),
         count(*) FILTER (
           WHERE (score_breakdown ->> 'disguise_likes')::integer = 100
         )
    INTO participant_count, reconnected_participant_count, scored_like_count
    FROM game.round_participant;

  SELECT count(*) INTO discovery_count FROM game.round_discovery;
  SELECT count(*) INTO like_count FROM game.round_like;
  SELECT count(*) INTO revision_count
    FROM game.round_result_revision
   WHERE revision_type = 'initial'
     AND revision_number = 1;
  SELECT count(*) INTO live_checkpoint_count
    FROM game.round_live_checkpoint;

  IF round_count <> 1
     OR invalid_round_count <> 0
     OR participant_count <> 2
     OR reconnected_participant_count <> 2
     OR scored_like_count <> 1
     OR discovery_count <> 1
     OR like_count <> 1
     OR revision_count <> 1
     OR live_checkpoint_count <> 0 THEN
    RAISE EXCEPTION
      'terminal round persistence mismatch: rounds %, invalid %, participants %, reconnected %, scored likes %, discoveries %, likes %, revisions %, live checkpoints %',
      round_count, invalid_round_count, participant_count, reconnected_participant_count,
      scored_like_count, discovery_count, like_count, revision_count,
      live_checkpoint_count;
  END IF;
END;
$$;
SQL

if [[ "${keep_stack}" == "1" ]]; then
  write_dev_state
fi
