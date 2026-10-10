#!/usr/bin/env bash
# Build the Polpo server as a standalone binary for Electron sidecar.
# Uses Bun to compile the server into a single executable (no Node.js required at runtime).
#
# playwright-core and sharp (native) cannot be compiled in: they stay external and ship next to
# the binary in binaries/node_modules (resources/node_modules in the app), with this platform's
# sharp binaries. The app starts the server with NODE_PATH pointing there.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXT=""
if [[ "$(uname -s)" == MINGW* ]] || [[ "$(uname -s)" == MSYS* ]]; then
  EXT=".exe"
fi

echo "Building polpo-server sidecar..."

cd "$REPO_ROOT"
# --compile-autoload-package-json: without it the binary ignores package.json "main"/"exports"
# of the external packages and cannot load them
bun build dist/cli/index.js --compile \
  --compile-autoload-package-json \
  --external chromium-bidi \
  --external playwright-core \
  --external playwright \
  --external sharp \
  --outfile "$SCRIPT_DIR/polpo-server${EXT}"

echo "Sidecar built: $SCRIPT_DIR/polpo-server${EXT}"
ls -lh "$SCRIPT_DIR/polpo-server${EXT}"

# The external packages, at the versions the server is built and tested with
PLAYWRIGHT_VERSION="$(node -p "require('playwright-core/package.json').version")"
SHARP_VERSION="$(node -p "require('sharp/package.json').version")"
DEPS_DIR="$SCRIPT_DIR/sidecar-deps"
rm -rf "$DEPS_DIR" "$SCRIPT_DIR/node_modules"
mkdir -p "$DEPS_DIR"
echo '{ "private": true }' > "$DEPS_DIR/package.json"
(cd "$DEPS_DIR" && npm install --no-save --no-package-lock --no-audit --no-fund --ignore-scripts --omit=dev \
  "playwright-core@$PLAYWRIGHT_VERSION" "sharp@$SHARP_VERSION")
mv "$DEPS_DIR/node_modules" "$SCRIPT_DIR/node_modules"
rm -rf "$DEPS_DIR"

# The binary must load both from there
cat > "$SCRIPT_DIR/.sidecar-check.mjs" <<'EOF'
const { chromium } = await import("playwright-core");
if (typeof chromium?.launch !== "function") throw new Error("playwright-core did not load");
const { default: sharp } = await import("sharp");
await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).jpeg().toBuffer();
console.log("playwright-core and sharp load from the sidecar's node_modules");
EOF
bun build "$SCRIPT_DIR/.sidecar-check.mjs" --compile --compile-autoload-package-json \
  --external playwright-core --external sharp --outfile "$SCRIPT_DIR/.sidecar-check${EXT}"
NM_PATH="$SCRIPT_DIR/node_modules"
if [[ -n "$EXT" ]]; then NM_PATH="$(cygpath -w "$NM_PATH")"; fi
CHECK_CWD="$(mktemp -d)"
(cd "$CHECK_CWD" && NODE_PATH="$NM_PATH" "$SCRIPT_DIR/.sidecar-check${EXT}")
rm -rf "$CHECK_CWD"
rm -f "$SCRIPT_DIR/.sidecar-check.mjs" "$SCRIPT_DIR/.sidecar-check${EXT}"

du -sh "$SCRIPT_DIR/node_modules"
