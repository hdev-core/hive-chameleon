#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/runtime/nakama/compose.yaml"
application_compose_file="${repository_root}/infra/postgres/compose.yaml"
project_name="${HIVE_CHAMELEON_NAKAMA_PROJECT:-hive-chameleon-nakama-smoke-$$}"
application_project_name="${project_name}-application"
api_log="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-api-smoke.XXXXXX")"
nakama_log="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-nakama-smoke.XXXXXX")"
api_pid=""

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
  rm -f "${api_log}" "${nakama_log}"

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
export NAKAMA_API_PORT=0
export NAKAMA_CONSOLE_PORT=0
export NAKAMA_METRICS_PORT=0

export NODE_ENV=development
export SMOKE_PLAYER_ID="$(random_uuid_v7)"
export SMOKE_PLAYER_TWO_ID="$(random_uuid_v7)"
export SMOKE_AUTH_SESSION_ID="$(random_uuid_v7)"
export SMOKE_AUTH_SESSION_TWO_ID="$(random_uuid_v7)"
export SMOKE_DISCLOSURE_ACK_ID="$(random_uuid_v7)"
export SMOKE_DISCLOSURE_ACK_TWO_ID="$(random_uuid_v7)"
export SMOKE_MAP_ID="$(random_uuid_v7)"
export SMOKE_MAP_VERSION_ID="$(random_uuid_v7)"
export SMOKE_MAP_DESKTOP_DISTRIBUTION_ID="$(random_uuid_v7)"
export SMOKE_MAP_WEB_DISTRIBUTION_ID="$(random_uuid_v7)"
export AUTH_TOKEN_SECRET="$(random_base64url 32)"
export AUTH_IDENTITY_LOOKUP_KEY="$(random_base64url 32)"
export HC_POSTGRES_PORT="$(free_port)"
export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${HC_POSTGRES_PORT}/hive_chameleon?sslmode=disable"
export HC_NAKAMA_DATABASE_URL="postgres://postgres:postgres@host.docker.internal:${HC_POSTGRES_PORT}/hive_chameleon?sslmode=disable"

cd "${repository_root}"

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
  -v session_two_id="${SMOKE_AUTH_SESSION_TWO_ID}" \
  -v disclosure_ack_id="${SMOKE_DISCLOSURE_ACK_ID}" \
  -v disclosure_ack_two_id="${SMOKE_DISCLOSURE_ACK_TWO_ID}" \
  -v map_id="${SMOKE_MAP_ID}" \
  -v map_version_id="${SMOKE_MAP_VERSION_ID}" \
  -v map_desktop_distribution_id="${SMOKE_MAP_DESKTOP_DISTRIBUTION_ID}" \
  -v map_web_distribution_id="${SMOKE_MAP_WEB_DISTRIBUTION_ID}" <<'SQL'
INSERT INTO identity.player (id, hive_username, hive_control_state) VALUES
  (:'player_id', 'smoke-user', 'external_self_custodial'),
  (:'player_two_id', 'smoke-user-two', 'external_self_custodial');

INSERT INTO content.map (
  id, origin, slug, title, description, lifecycle
) VALUES (
  :'map_id', 'official', 'm4-smoke-scaffold', 'M4 Smoke Scaffold',
  'Non-visual map record for authoritative round scaffolding tests.', 'published'
);

INSERT INTO content.map_version (
  id, map_id, version_number, manifest, status, license_declaration_version,
  license_accepted_at, technical_validation, submitted_at, approved_at, published_at
) VALUES (
  :'map_version_id', :'map_id', 'm4-smoke-1', '{}', 'published', 'dev-1',
  now(), '{"validated":true}', now(), now(), now()
);

INSERT INTO content.map_distribution (
  id, map_version_id, platform, state, required_game_build_version, published_at
) VALUES
  (
    :'map_desktop_distribution_id', :'map_version_id', 'desktop', 'available',
    'hive-chameleon-m4-dev', now()
  ),
  (
    :'map_web_distribution_id', :'map_version_id', 'web', 'available',
    'hive-chameleon-m4-dev', now()
  );

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

INSERT INTO identity.public_record_disclosure_acknowledgment (
  id, disclosure_version, player_id, source, acknowledged_at
) VALUES
  (
    :'disclosure_ack_id', '2026-07-22', :'player_id',
    'direct_hive_pre_participation', now()
  ),
  (
    :'disclosure_ack_two_id', '2026-07-22', :'player_two_id',
    'direct_hive_pre_participation', now()
  );
SQL
compose up --build --detach nakama
wait_for_nakama

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

node apps/api/dist/main.js >"${api_log}" 2>&1 &
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
  live_participant_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (
           WHERE status <> 'aborted'
              OR sequence_number <> 1
              OR hunter_count <> 1
              OR game_server_build_version <> 'hive-chameleon-m4-dev'
              OR protocol_version <> 'm4-v1'
         )
    INTO round_count, invalid_round_count
    FROM game.game_round;

  SELECT count(*) INTO live_participant_count
    FROM game.round_participant;

  IF round_count <> 1 OR invalid_round_count <> 0 OR live_participant_count <> 0 THEN
    RAISE EXCEPTION
      'round scaffold persistence mismatch: rounds %, invalid %, terminal participants %',
      round_count, invalid_round_count, live_participant_count;
  END IF;
END;
$$;
SQL
