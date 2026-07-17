#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/infra/postgres/compose.yaml"
project_name="${HIVE_CHAMELEON_SCHEMA_PROJECT:-hive-chameleon-schema-check-$$}"

cleanup() {
  docker compose \
    --project-name "${project_name}" \
    --file "${compose_file}" \
    down \
    --volumes \
    --remove-orphans
}

trap cleanup EXIT

docker compose \
  --project-name "${project_name}" \
  --file "${compose_file}" \
  up \
  --abort-on-container-exit \
  --exit-code-from schema-test \
  schema-test
