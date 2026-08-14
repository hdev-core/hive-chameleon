#!/usr/bin/env bash
set -euo pipefail

repository=/opt/hive-chameleon/current
compose_file="${repository}/infra/hetzner/compose.yaml"
environment_file=/etc/hive-chameleon/game.env
backup_directory=/var/backups/hive-chameleon
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

umask 077
install -d -m 0700 "${backup_directory}"
temporary="$(mktemp -d "${backup_directory}/.backup.XXXXXX")"
trap 'rm -rf "${temporary}"' EXIT

cd "${repository}"
docker compose --env-file "${environment_file}" -f "${compose_file}" exec -T \
  application-postgres pg_dump -U postgres -d hive_chameleon \
  --format=custom --no-owner --no-privileges >"${temporary}/application-${timestamp}.dump"
docker compose --env-file "${environment_file}" -f "${compose_file}" exec -T \
  nakama-postgres pg_dump -U nakama -d nakama \
  --format=custom --no-owner --no-privileges >"${temporary}/nakama-${timestamp}.dump"

(
  cd "${temporary}"
  sha256sum ./*.dump >"checksums-${timestamp}.sha256"
)
mv "${temporary}"/* "${backup_directory}/"

find "${backup_directory}" -type f \
  \( -name '*.dump' -o -name '*.sha256' \) -mtime +7 -delete

echo "Hive Chameleon database backup completed at ${timestamp}."

