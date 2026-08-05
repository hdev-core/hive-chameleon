#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_path="${repository_root}/clients/unity/Builds/WebGL"

required_files=(
  "index.html"
  "Build/WebGL.loader.js"
  "Build/WebGL.framework.js"
  "Build/WebGL.data"
  "Build/WebGL.wasm"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "${build_path}/${required_file}" ]]; then
    echo "WebGL build is missing ${required_file}; run npm run unity:webgl:build first." >&2
    exit 1
  fi
done

echo "Deployment is disabled: the current WebGL test build contains a short-lived development" >&2
echo "session. Add production login/session delivery before publishing an approved build to" >&2
echo "Hetzner Object Storage." >&2
exit 1
