#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repository_root}/clients/unity"
build_path="${project_path}/Builds/WebGL"
scene_path="${project_path}/Assets/Scenes/Development.unity"
scene_backup="$(mktemp "${TMPDIR:-/tmp}/hive-chameleon-scene.XXXXXX")"

cp "${scene_path}" "${scene_backup}"

restore_source_scene() {
  cp "${scene_backup}" "${scene_path}"
  rm -f "${scene_backup}"
}

trap restore_source_scene EXIT

find_unity_editor() {
  if [[ -n "${UNITY_EDITOR:-}" ]]; then
    printf '%s\n' "${UNITY_EDITOR}"
    return
  fi

  local candidate
  for candidate in \
    "/Applications/Unity/Hub/Editor/6000.3.18f1-arm64/Unity.app/Contents/MacOS/Unity" \
    "/Applications/Unity/Hub/Editor/6000.3.18f1/Unity.app/Contents/MacOS/Unity"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return
    fi
  done

  if command -v unity-editor >/dev/null 2>&1; then
    command -v unity-editor
    return
  fi

  return 1
}

unity_editor="$(find_unity_editor)" || {
  echo "Unity 6000.3.18f1 was not found. Set UNITY_EDITOR to the editor executable." >&2
  exit 1
}

echo "Building credential-free Unity WebGL showcase..."
env \
  -u HIVE_CHAMELEON_API_URL \
  -u NAKAMA_SERVER_KEY \
  -u REALTIME_DEV_BEARER_TOKEN \
  UNITY_BUILD_TARGET=webgl \
  "${unity_editor}" \
  -batchmode \
  -quit \
  -projectPath "${project_path}" \
  -executeMethod HiveChameleon.Editor.DevelopmentBuild.BuildFromCommandLine \
  -logFile -

required_files=(
  "index.html"
  "Build/WebGL.loader.js"
  "Build/WebGL.framework.js"
  "Build/WebGL.data"
  "Build/WebGL.wasm"
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "${build_path}/${required_file}" ]]; then
    echo "Unity build is incomplete: missing ${required_file}." >&2
    exit 1
  fi
done

echo "WebGL showcase ready at ${build_path}"
