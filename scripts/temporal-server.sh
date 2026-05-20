#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
mkdir -p var
GRPC_PORT=$(jq -r '.temporal.grpcPort' infra.json)
UI_PORT=$(jq -r '.temporal.uiPort' infra.json)
exec temporal server start-dev \
  --db-filename var/temporal.db \
  --ip 127.0.0.1 \
  --port "$GRPC_PORT" \
  --ui-ip 127.0.0.1 \
  --ui-port "$UI_PORT" \
  --log-format pretty \
  --namespace default
