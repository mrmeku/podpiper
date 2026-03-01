#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
source .env
set +a

until curl -sf http://localhost:8888 >/dev/null 2>&1; do
  sleep 5
done

exec /opt/homebrew/bin/bun run src/cli/cli.ts serve
