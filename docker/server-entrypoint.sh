#!/bin/sh
set -e

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

: "${PORT:=3890}"
: "${POLPO_WORKDIR:=/workspace}"

set -- node dist/cli/index.js serve --host 0.0.0.0 --port "$PORT" --dir "$POLPO_WORKDIR"

if [ -n "${POLPO_API_KEY:-}" ]; then
  set -- "$@" --api-key "$POLPO_API_KEY"
fi

if [ -n "${POLPO_CORS_ORIGINS:-}" ]; then
  set -- "$@" --cors-origins "$POLPO_CORS_ORIGINS"
fi

exec "$@"
