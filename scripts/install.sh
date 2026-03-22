#!/bin/sh
# Polpo installer — https://polpo.sh
# Usage: curl -fsSL https://get.polpo.sh | sh
set -e

BOLD="\033[1m"
RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
CYAN="\033[36m"
RESET="\033[0m"

MIN_NODE=20

info()  { printf "${CYAN}%s${RESET}\n" "$*"; }
ok()    { printf "${GREEN}%s${RESET}\n" "$*"; }
warn()  { printf "${YELLOW}%s${RESET}\n" "$*"; }
err()   { printf "${RED}%s${RESET}\n" "$*" >&2; }

# --- OS / arch detection ---
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)
      err "Unsupported OS: $OS"
      err "Install manually: npm install -g polpo-ai"
      exit 1
      ;;
  esac

  case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)
      warn "Unknown architecture: $ARCH (proceeding anyway)"
      ;;
  esac
}

# --- Check Node.js ---
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "Node.js is not installed."
    echo ""
    info "Install Node.js ${MIN_NODE}+ first:"
    echo ""
    echo "  # macOS / Linux (recommended)"
    echo "  curl -fsSL https://fnm.vercel.app/install | bash"
    echo "  fnm install ${MIN_NODE}"
    echo ""
    echo "  # or via nvm"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
    echo "  nvm install ${MIN_NODE}"
    echo ""
    echo "  # or download directly"
    echo "  https://nodejs.org"
    echo ""
    exit 1
  fi

  NODE_VERSION="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"

  if [ "$NODE_MAJOR" -lt "$MIN_NODE" ]; then
    err "Node.js $NODE_VERSION is too old. Polpo requires Node.js >= ${MIN_NODE}."
    echo ""
    info "Upgrade Node.js:"
    echo "  nvm install ${MIN_NODE}   # if using nvm"
    echo "  fnm install ${MIN_NODE}   # if using fnm"
    echo "  https://nodejs.org        # or download directly"
    echo ""
    exit 1
  fi

  ok "Node.js $NODE_VERSION"
}

# --- Check npm ---
check_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    err "npm not found. It should come with Node.js."
    err "Reinstall Node.js: https://nodejs.org"
    exit 1
  fi
  ok "npm $(npm -v)"
}

# --- Install ---
install_polpo() {
  info "Installing polpo-ai..."
  echo ""

  if npm install -g polpo-ai; then
    echo ""
    ok "Polpo installed successfully!"
    echo ""
    INSTALLED_VERSION="$(polpo --version 2>/dev/null || echo "unknown")"
    info "  Version:  $INSTALLED_VERSION"
    info "  Platform: $PLATFORM ($ARCH)"
    echo ""
    echo "  ${BOLD}Get started:${RESET}"
    echo "    polpo login       # connect to Polpo cloud"
    echo "    polpo init        # or run locally"
    echo "    polpo --help      # see all commands"
    echo ""
    info "  Docs: https://docs.polpo.sh"
    echo ""
  else
    echo ""
    err "Installation failed."
    echo ""
    warn "Try with sudo:"
    echo "  sudo npm install -g polpo-ai"
    echo ""
    warn "Or install to a user directory:"
    echo "  npm config set prefix ~/.npm-global"
    echo "  export PATH=~/.npm-global/bin:\$PATH"
    echo "  npm install -g polpo-ai"
    echo ""
    exit 1
  fi
}

# --- Main ---
main() {
  echo ""
  echo "  ${BOLD}Polpo Installer${RESET}"
  echo ""

  detect_platform
  check_node
  check_npm
  echo ""
  install_polpo
}

main
