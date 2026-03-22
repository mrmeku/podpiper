#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

cd "$(dirname "$0")/.."

set -a
source .env
set +a

docker compose -f docker-compose.temporal.yml up -d

TEMPORAL_HOST="${TEMPORAL_ADDRESS:-localhost:7233}"
echo "Waiting for Temporal at $TEMPORAL_HOST..."
until nc -z "${TEMPORAL_HOST%%:*}" "${TEMPORAL_HOST##*:}" 2>/dev/null; do
  sleep 2
done
echo "Temporal is ready."

exec /opt/homebrew/bin/bun run src/cli/cli.ts serve --address "$TEMPORAL_HOST"
