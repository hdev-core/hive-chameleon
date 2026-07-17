#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/runtime/nakama/compose.yaml"
project_name="${HIVE_CHAMELEON_NAKAMA_PROJECT:-hive-chameleon-nakama-smoke-$$}"
api_log="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-api-smoke.XXXXXX")"
api_pid=""

compose() {
  docker compose \
    --project-name "${project_name}" \
    --file "${compose_file}" \
    "$@"
}

redact_api_log() {
  node - "${api_log}" <<'NODE'
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
  'REALTIME_DEV_BEARER_TOKEN',
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
    redact_api_log
  fi

  compose down --volumes --remove-orphans --rmi local || cleanup_status=$?
  rm -f "${api_log}"

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
export REALTIME_DEV_PRINCIPAL_ENABLED=true
export REALTIME_DEV_DISCLOSURE_ACKNOWLEDGED=true
export REALTIME_DEV_PLAYER_ID="$(random_uuid_v7)"
export REALTIME_DEV_AUTH_SESSION_ID="$(random_uuid_v7)"
export REALTIME_DEV_BEARER_TOKEN="$(random_hex 32)"

cd "${repository_root}"

echo "Building the NestJS bridge and isolated Nakama runtime..."
npm run build --workspace @hive-chameleon/api
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
