#!/usr/bin/env bash
# Build the Polpo server as a standalone binary for Electron sidecar.
# Uses Bun to compile the server into a single executable (no Node.js required at runtime).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXT=""
if [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == MSYS* ]]; then
  EXT=".exe"
fi

echo "Building polpo-server sidecar..."

cd "$REPO_ROOT"
bun build dist/cli/index.js --compile \
  --external chromium-bidi \
  --external playwright-core \
  --external playwright \
  --outfile "$SCRIPT_DIR/polpo-server${EXT}"

echo "Sidecar built: $SCRIPT_DIR/polpo-server${EXT}"
ls -lh "$SCRIPT_DIR/polpo-server${EXT}"
