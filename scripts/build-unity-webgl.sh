#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project_path="${repository_root}/clients/unity"
build_path="${project_path}/Builds/WebGL"
scene_path="${project_path}/Assets/Scenes/Development.unity"

if [[ -e "${project_path}/Temp/UnityLockfile" ]]; then
  echo "Unity currently owns this project. Exit the Editor, then run this command again." >&2
  echo "The tooling will not close Unity or bypass its project lock." >&2
  exit 1
fi

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

build_configuration="${HIVE_CHAMELEON_BUILD_CONFIGURATION:-development}"
echo "Building the credential-neutral ${build_configuration} Unity WebGL client..."
env \
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
)

for required_file in "${required_files[@]}"; do
  if [[ ! -s "${build_path}/${required_file}" ]]; then
    echo "Unity build is incomplete: missing ${required_file}." >&2
    exit 1
  fi
done

for payload in WebGL.framework.js WebGL.data WebGL.wasm; do
  if ! compgen -G "${build_path}/Build/${payload}*" >/dev/null; then
    echo "Unity build is incomplete: missing Build/${payload}." >&2
    exit 1
  fi
done

echo "Credential-neutral WebGL ${build_configuration} build ready at ${build_path}"
if [[ "${build_configuration}" == "production" ]]; then
  echo "Run scripts/prepare-public-webgl.mjs before deployment."
else
  echo "Use npm run authoritative:webgl to supply local per-client sessions."
fi
