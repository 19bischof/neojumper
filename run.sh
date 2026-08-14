#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

NODE_BIN="/opt/homebrew/bin/node"

if [[ ! -x "$NODE_BIN" ]]; then
  echo "Node.js not found at ${NODE_BIN}." >&2
  exit 1
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec "$NODE_BIN" server.js
