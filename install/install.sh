#!/usr/bin/env bash
# OpenPolpo installer — works on macOS, Linux, and WSL
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.sh | bash
#   wget -qO- https://raw.githubusercontent.com/lumea-labs/polpo/main/install/install.sh | bash

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Helpers ─────────────────────────────────────────────────────────
info()  { printf "${BLUE}info${RESET}  %s\n" "$*"; }
ok()    { printf "${GREEN}  ok${RESET}  %s\n" "$*"; }
warn()  { printf "${YELLOW}warn${RESET}  %s\n" "$*"; }
error() { printf "${RED}error${RESET} %s\n" "$*" >&2; }
fatal() { error "$@"; exit 1; }

# ── Banner ──────────────────────────────────────────────────────────
cat << 'BANNER'

  ██████╗  ██████╗ ██╗     ██████╗  ██████╗
  ██╔══██╗██╔═══██╗██║     ██╔══██╗██╔═══██╗
  ██████╔╝██║   ██║██║     ██████╔╝██║   ██║
  ██╔═══╝ ██║   ██║██║     ██╔═══╝ ██║   ██║
  ██║     ╚██████╔╝███████╗██║     ╚██████╔╝
  ╚═╝      ╚═════╝ ╚══════╝╚═╝      ╚═════╝

BANNER
printf "  ${DIM}Agent-agnostic AI orchestration framework${RESET}\n\n"

# ── Platform detection ──────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)       fatal "Unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64)  ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7l)        ARCH="armv7" ;;
    *)             ARCH="$arch" ;;
  esac

  info "Detected platform: ${BOLD}${PLATFORM}${RESET} (${ARCH})"
}

# ── Prerequisite checks ────────────────────────────────────────────
INSTALL_METHOD=""

check_node() {
  if command -v node &>/dev/null; then
    local ver
    ver="$(node --version 2>/dev/null | sed 's/^v//')"
    local major="${ver%%.*}"
    if [ "$major" -ge 18 ] 2>/dev/null; then
      ok "Node.js ${ver} found"
      return 0
    else
      warn "Node.js ${ver} found but >= 18 is required"
      return 1
    fi
  fi
  return 1
}

check_npm() {
  if command -v npm &>/dev/null; then
    ok "npm $(npm --version) found"
    return 0
  fi
  return 1
}

check_pnpm() {
  if command -v pnpm &>/dev/null; then
    ok "pnpm $(pnpm --version) found"
    return 0
  fi
  return 1
}

# ── Install Node.js if missing ─────────────────────────────────────
install_node() {
  info "Node.js >= 18 is required. Attempting to install..."

  # Try nvm first
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
    info "Installing Node.js 22 via nvm..."
    nvm install 22
    nvm use 22
    ok "Node.js installed via nvm"
    return 0
  fi

  # Try fnm
  if command -v fnm &>/dev/null; then
    info "Installing Node.js 22 via fnm..."
    fnm install 22
    fnm use 22
    ok "Node.js installed via fnm"
    return 0
  fi

  # Try volta
  if command -v volta &>/dev/null; then
    info "Installing Node.js 22 via volta..."
    volta install node@22
    ok "Node.js installed via volta"
    return 0
  fi

  # Platform-specific package manager
  case "$PLATFORM" in
    macos)
      if command -v brew &>/dev/null; then
        info "Installing Node.js via Homebrew..."
        brew install node@22
        ok "Node.js installed via Homebrew"
        return 0
      fi
      ;;
    linux)
      # Try NodeSource setup for Debian/Ubuntu
      if command -v apt-get &>/dev/null; then
        info "Installing Node.js via NodeSource (apt)..."
        if command -v sudo &>/dev/null; then
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
          sudo apt-get install -y nodejs
        else
          curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
          apt-get install -y nodejs
        fi
        ok "Node.js installed via apt"
        return 0
      fi

      # Fedora/RHEL
      if command -v dnf &>/dev/null; then
        info "Installing Node.js via dnf..."
        sudo dnf install -y nodejs
        ok "Node.js installed via dnf"
        return 0
      fi

      # Arch
      if command -v pacman &>/dev/null; then
        info "Installing Node.js via pacman..."
        sudo pacman -S --noconfirm nodejs npm
        ok "Node.js installed via pacman"
        return 0
      fi

      # Alpine
      if command -v apk &>/dev/null; then
        info "Installing Node.js via apk..."
        sudo apk add --no-cache nodejs npm
        ok "Node.js installed via apk"
        return 0
      fi
      ;;
  esac

  # Last resort: suggest manual install
  error "Could not automatically install Node.js."
  echo ""
  echo "  Please install Node.js >= 18 manually:"
  echo ""
  echo "    ${BOLD}https://nodejs.org/en/download${RESET}"
  echo ""
  echo "  Or use a version manager:"
  echo ""
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "    nvm install 22"
  echo ""
  echo "  Then re-run this installer."
  exit 1
}

# ── Install Polpo ──────────────────────────────────────────────────
install_polpo() {
  local pkg_manager="npm"
  local force_flag=""

  if check_pnpm; then
    pkg_manager="pnpm"
  fi

  # If polpo is already installed, force overwrite to allow upgrades
  if command -v polpo &>/dev/null; then
    info "Existing polpo installation detected — upgrading..."
    force_flag="--force"
  fi

  info "Installing @polpo-ai/polpo globally via ${BOLD}${pkg_manager}${RESET}..."

  case "$pkg_manager" in
    pnpm)
      pnpm add -g @polpo-ai/polpo
      ;;
    npm)
      npm install -g @polpo-ai/polpo $force_flag
      ;;
  esac

  # Verify installation
  if command -v polpo &>/dev/null; then
    local installed_ver
    installed_ver="$(polpo --version 2>/dev/null || echo 'unknown')"
    ok "@polpo-ai/polpo ${installed_ver} installed successfully"
  else
    # npm global bin might not be in PATH
    warn "polpo was installed but is not in your PATH."
    echo ""

    local npm_bin
    npm_bin="$(npm config get prefix 2>/dev/null)/bin"

    echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo "    export PATH=\"${npm_bin}:\$PATH\""
    echo ""
    echo "  Then restart your shell or run: source ~/.bashrc"
    echo ""
  fi
}

# ── Post-install guidance ──────────────────────────────────────────
print_next_steps() {
  echo ""
  printf "  ${GREEN}${BOLD}Installation complete!${RESET}\n"
  echo ""
  printf "  ${BOLD}Quick start:${RESET}\n"
  echo ""
  printf "    ${CYAN}mkdir my-project && cd my-project${RESET}\n"
  printf "    ${CYAN}polpo init${RESET}\n"
  printf "    ${CYAN}polpo${RESET}\n"
  echo ""
  printf "  ${BOLD}Run as a server:${RESET}\n"
  echo ""
  printf "    ${CYAN}polpo serve${RESET}\n"
  echo ""
  printf "  ${BOLD}Run with Docker:${RESET}\n"
  echo ""
  printf "    ${CYAN}docker run -it -p 3000:3000 -v \$(pwd):/workspace lumea-labs/polpo${RESET}\n"
  echo ""
  printf "  ${DIM}Documentation: https://docs.polpo.sh${RESET}\n"
  printf "  ${DIM}GitHub:        https://github.com/lumea-labs/polpo${RESET}\n"
  echo ""
}

# ── Main ────────────────────────────────────────────────────────────
main() {
  detect_platform

  # Check or install Node.js
  if ! check_node; then
    install_node
    # Re-check after install
    if ! check_node; then
      fatal "Node.js installation failed. Please install Node.js >= 18 manually."
    fi
  fi

  # Check npm
  if ! check_npm; then
    fatal "npm not found. It should come with Node.js — please reinstall Node.js."
  fi

  # Install polpo
  install_polpo

  # Show next steps
  print_next_steps
}

main "$@"
