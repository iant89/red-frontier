#!/usr/bin/env bash
# ==============================================================================
# Red Frontier - Launch Preview Server
#
# This script:
#   1. Verifies that the production build exists (builds if missing)
#   2. Starts the Vite preview web server on host 0.0.0.0:4173
#   3. Optionally opens the browser on desktop Linux systems
# ==============================================================================

set -euo pipefail

# Terminal colors
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

print_info() {
    echo -e "${CYAN}${BOLD}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}${BOLD}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}${BOLD}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}${BOLD}[✗]${NC} $1" >&2
}

# ------------------------------------------------------------------------------
# 1. Resolve Repository Root
# ------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ]; then
    REPO_ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ]; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
elif [ -f "./package.json" ]; then
    REPO_ROOT="$(pwd)"
else
    print_error "Cannot find Red Frontier repository root (package.json not found)."
    exit 1
fi

cd "$REPO_ROOT"

# ------------------------------------------------------------------------------
# 2. Parse Arguments and Configuration
# ------------------------------------------------------------------------------
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-4173}"
AUTO_OPEN=true

while [ $# -gt 0 ]; do
    case "$1" in
        --port|-p)
            PORT="$2"
            shift 2
            ;;
        --host|-h)
            HOST="$2"
            shift 2
            ;;
        --no-open)
            AUTO_OPEN=false
            shift
            ;;
        --open)
            AUTO_OPEN=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

# ------------------------------------------------------------------------------
# 3. Check Prerequisites & Ensure Build Exists
# ------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    print_error "Node.js or npm is not installed. Please run ./setup_ubuntu.sh first."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    print_warning "Dependencies are not installed. Running npm install..."
    npm install
fi

if [ ! -f "dist/index.html" ]; then
    print_warning "Production build not found in dist/. Building the game first..."
    npm run build
    print_success "Build completed."
fi

# ------------------------------------------------------------------------------
# 4. Announce and Launch Preview Server
# ------------------------------------------------------------------------------
echo -e "${CYAN}${BOLD}"
echo "=========================================================="
echo "          Red Frontier - Preview Server                   "
echo "=========================================================="
echo -e "${NC}"
echo -e "  ➜  ${BOLD}Local:${NC}   http://localhost:${PORT}/"
echo -e "  ➜  ${BOLD}Network:${NC} http://${HOST}:${PORT}/"
echo ""
print_info "Starting Vite preview server on ${HOST}:${PORT}..."
echo "Press Ctrl+C to stop the server."
echo ""

# Attempt to open browser on desktop GUI if available
if [ "$AUTO_OPEN" = true ] && [ -n "${DISPLAY:-${WAYLAND_DISPLAY:-}}" ] && command -v xdg-open >/dev/null 2>&1; then
    (
        sleep 1
        xdg-open "http://localhost:${PORT}/" >/dev/null 2>&1 || true
    ) &
fi

exec npm run preview -- --host "$HOST" --port "$PORT"
