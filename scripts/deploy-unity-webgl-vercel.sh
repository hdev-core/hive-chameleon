#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_path="${repository_root}/clients/unity/Builds/WebGL"
project_name="${VERCEL_PROJECT:-hive-chameleon}"

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

if ! command -v vercel >/dev/null 2>&1; then
  echo "The Vercel CLI is required. Install it and authenticate with 'vercel login'." >&2
  exit 1
fi

if ! vercel whoami >/dev/null 2>&1; then
  echo "The Vercel CLI is not authenticated. Run 'vercel login' first." >&2
  exit 1
fi

if [[ ! -f "${build_path}/.vercel/project.json" ]]; then
  vercel link --yes --project "${project_name}" --cwd "${build_path}"
fi

echo "Deploying the credential-free WebGL showcase to Vercel production..."
vercel deploy --prod --yes --cwd "${build_path}"
