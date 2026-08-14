#!/usr/bin/env bash
set -euo pipefail

psql "${DATABASE_URL:?DATABASE_URL is required}" \
  -v ON_ERROR_STOP=1 \
  -v api_password="${HC_API_DB_PASSWORD:?HC_API_DB_PASSWORD is required}" \
  -v nakama_password="${HC_NAKAMA_DB_PASSWORD:?HC_NAKAMA_DB_PASSWORD is required}" \
  -f /deployment/runtime-roles.sql

