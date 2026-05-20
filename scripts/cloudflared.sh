#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
set -a; source .env; set +a
exec cloudflared --no-autoupdate tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
