#!/usr/bin/env bash
set -euo pipefail

target="${1:-/etc/hive-chameleon/game.env}"
if [[ -e "${target}" ]]; then
  echo "Refusing to replace existing deployment secrets at ${target}." >&2
  exit 1
fi

base64url_secret() {
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n'
}

umask 077
temporary="$(mktemp "${target}.XXXXXX")"
trap 'rm -f "${temporary}"' EXIT

{
  printf 'HC_PUBLIC_ORIGIN=https://hive-signer.cloverapis.xyz\n'
  printf 'HC_PUBLIC_WEBSOCKET_URL=wss://hive-signer.cloverapis.xyz/ws\n'
  printf 'HC_API_BIND_PORT=3000\n'
  printf 'HC_NAKAMA_BIND_PORT=7350\n'
  printf 'HC_DATABASE_OWNER_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'HC_API_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'HC_NAKAMA_DB_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'NAKAMA_DATABASE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'AUTH_TOKEN_SECRET=%s\n' "$(base64url_secret)"
  printf 'AUTH_IDENTITY_LOOKUP_KEY=%s\n' "$(base64url_secret)"
  printf 'NAKAMA_BRIDGE_HMAC_KEY=%s\n' "$(base64url_secret)"
  printf 'NAKAMA_SERVER_KEY=%s\n' "$(openssl rand -hex 24)"
  printf 'NAKAMA_RUNTIME_HTTP_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'NAKAMA_SESSION_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'NAKAMA_REFRESH_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'NAKAMA_CONSOLE_USERNAME=hc-admin\n'
  printf 'NAKAMA_CONSOLE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'NAKAMA_CONSOLE_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)"
} >"${temporary}"

chmod 0600 "${temporary}"
mv "${temporary}" "${target}"
trap - EXIT
echo "Created deployment secrets at ${target}."

