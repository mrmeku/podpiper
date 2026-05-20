#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
set -a; source .env; set +a

GRPC_PORT=$(jq -r '.temporal.grpcPort' infra.json)
TEMPORAL_HOST="localhost:${GRPC_PORT}"
echo "Waiting for Temporal at $TEMPORAL_HOST..."
start=$SECONDS
until nc -z localhost "$GRPC_PORT" 2>/dev/null; do
  (( SECONDS - start > 120 )) && { echo "Temporal not reachable after 120s; exiting for launchd retry"; exit 1; }
  sleep 2
done
echo "Temporal is ready."

exec /opt/homebrew/bin/bun run src/cli/cli.ts serve --address "$TEMPORAL_HOST"
