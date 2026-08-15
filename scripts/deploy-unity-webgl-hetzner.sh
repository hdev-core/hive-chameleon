#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_path="${repository_root}/clients/unity/Builds/WebGL"
remote_host="${HIVE_CHAMELEON_DEPLOY_HOST:-hivelinux}"
remote_path="${HIVE_CHAMELEON_DEPLOY_PATH:-/srv/hive-chameleon/game}"

required_files=(
  "index.html"
  "game-bootstrap.js"
  "runtime-config.json"
  "Build/WebGL.loader.js"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "${build_path}/${required_file}" ]]; then
    echo "WebGL build is missing ${required_file}; run npm run unity:webgl:build first." >&2
    exit 1
  fi
done

for payload in WebGL.framework.js WebGL.data WebGL.wasm; do
  if ! compgen -G "${build_path}/Build/${payload}*" >/dev/null; then
    echo "WebGL build is missing Build/${payload}; run the production build first." >&2
    exit 1
  fi
done

if grep -E -- '--hc-bearer-token=[A-Za-z0-9_-]|--hc-authoritative-development' \
  "${build_path}/index.html" \
  "${build_path}/game-bootstrap.js" \
  "${build_path}/runtime-config.json" >/dev/null; then
  echo "Refusing to deploy a WebGL artifact containing development credentials or markers." >&2
  exit 1
fi

ssh "${remote_host}" "install -d -m 0755 '${remote_path}'"
rsync -az --delete --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  "${build_path}/" "${remote_host}:${remote_path}/"

echo "Published the credential-neutral WebGL client to ${remote_host}:${remote_path}."
