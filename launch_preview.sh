#!/usr/bin/env bash
# ==============================================================================
#  RED FRONTIER — Local Game Preview Server
#
#  Mars · 2066 — Real-Time Strategy · Survival · Automation
#  Repository: https://github.com/iant89/red-frontier
# ==============================================================================
#  This script verifies the production distribution in dist/ (building it if
#  missing or stale), configures the host/port, and launches the Vite preview
#  web server so Red Frontier is instantly playable in a browser.
# ==============================================================================

set -euo pipefail

# ------------------------------------------------------------------------------
# Styling & Terminal Capabilities
# ------------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    BOLD="\033[1m"
    DIM="\033[2m"
    RESET="\033[0m"
    RED="\033[38;5;196m"
    GREEN="\033[38;5;46m"
    YELLOW="\033[38;5;220m"
    BLUE="\033[38;5;39m"
    CYAN="\033[38;5;51m"
    MARS="\033[38;5;202m" # Mars Rust / Orange
    WHITE="\033[38;5;255m"
else
    BOLD=""
    DIM=""
    RESET=""
    RED=""
    GREEN=""
    YELLOW=""
    BLUE=""
    CYAN=""
    MARS=""
    WHITE=""
fi

# ------------------------------------------------------------------------------
# Default Options
# ------------------------------------------------------------------------------
SCRIPT_VERSION="1.1.0"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-4173}"
FORCE_BUILD=false
AUTO_OPEN=true

# ------------------------------------------------------------------------------
# Logging Functions
# ------------------------------------------------------------------------------
log_banner() {
    echo -e "${MARS}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────────┐"
    echo "  │                      R E D   F R O N T I E R                 │"
    echo "  │               Local Game Preview Web Server                  │"
    echo "  │          Ares Expeditionary Command · Mars RTS 2066          │"
    echo "  └──────────────────────────────────────────────────────────────┘"
    echo -e "${RESET}"
}

log_step() {
    local num="$1"
    local total="$2"
    local msg="$3"
    echo -e "\n${CYAN}${BOLD}[STEP ${num}/${total}]${RESET} ${BOLD}${msg}${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────────────────────${RESET}"
}

log_info() {
    echo -e "  ${BLUE}ℹ${RESET}  $1"
}

log_success() {
    echo -e "  ${GREEN}✓${RESET}  ${BOLD}$1${RESET}"
}

log_warn() {
    echo -e "  ${YELLOW}⚠  $1${RESET}"
}

log_error() {
    echo -e "  ${RED}${BOLD}✗  ERROR:${RESET} ${RED}$1${RESET}" >&2
}

# ------------------------------------------------------------------------------
# Error Trap
# ------------------------------------------------------------------------------
cleanup() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo ""
        log_error "Preview server encountered an error (Exit Code: $exit_code)."
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------------------
# CLI Help & Argument Parsing
# ------------------------------------------------------------------------------
show_help() {
    cat << EOF
Red Frontier — Game Preview Server (v${SCRIPT_VERSION})

Usage:
  ./launch_preview.sh [options]

Options:
  -p, --port <port>   Port number to listen on (default: 4173)
  -h, --host <host>   Network interface host to bind to (default: 0.0.0.0)
  -b, --build         Force a production rebuild before starting
      --open          Automatically open game in default web browser
      --no-open       Do not attempt to open web browser
      --help          Display this help message and exit

Description:
  1. Validates node_modules and verifies dist/index.html is compiled.
  2. Automatically compiles the game if the production build is missing.
  3. Launches Vite preview bound to all interfaces (0.0.0.0).
  4. Provides accessible local and network URLs for gameplay.

Examples:
  ./launch_preview.sh
  ./launch_preview.sh --port 5000
  ./launch_preview.sh --build --no-open
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        -h|--host)
            HOST="$2"
            shift 2
            ;;
        -b|--build)
            FORCE_BUILD=true
            shift
            ;;
        --no-open)
            AUTO_OPEN=false
            shift
            ;;
        --open)
            AUTO_OPEN=true
            shift
            ;;
        --help)
            show_help
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help to view available options."
            exit 1
            ;;
    esac
done

# ------------------------------------------------------------------------------
# Execution Flow
# ------------------------------------------------------------------------------
log_banner

# 1. Resolve Workspace Root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": *"red-frontier"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    REPO_ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ] && grep -q '"name": *"red-frontier"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
elif [ -f "./package.json" ] && grep -q '"name": *"red-frontier"' "./package.json" 2>/dev/null; then
    REPO_ROOT="$(pwd -P)"
else
    log_error "Cannot locate Red Frontier repository root (package.json not found)."
    exit 1
fi

cd "$REPO_ROOT"

# 2. Check Prerequisites
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    log_error "Node.js or npm is missing. Please run ./setup_ubuntu.sh first."
    exit 1
fi

if [ ! -d "node_modules" ]; then
    log_warn "Dependencies missing in node_modules. Running npm install..."
    npm install
fi

# 3. Ensure Build Exists
if [ "$FORCE_BUILD" = true ] || [ ! -f "dist/index.html" ]; then
    if [ "$FORCE_BUILD" = true ]; then
        log_info "Forcing production build (--build requested)..."
    else
        log_warn "Production build not found in dist/. Compiling game now..."
    fi
    npm run build
    log_success "Build completed."
fi

# 4. Resolve Display Host IP
LOCAL_IP=""
if command -v hostname >/dev/null 2>&1; then
    LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [ -z "$LOCAL_IP" ] && command -v ip >/dev/null 2>&1; then
    LOCAL_IP="$(ip route get 1 2>/dev/null | awk '{print $7}')"
fi

# 5. Display Status Dashboard
echo -e "${GREEN}${BOLD}  ┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}${BOLD}  │                 RED FRONTIER IS READY TO PLAY                │${RESET}"
echo -e "${GREEN}${BOLD}  └──────────────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${BOLD}Access Endpoints:${RESET}"
echo -e "    • Local Web:     ${CYAN}${BOLD}http://localhost:${PORT}/${RESET}"
if [ -n "$LOCAL_IP" ] && [ "$LOCAL_IP" != "127.0.0.1" ]; then
    echo -e "    • LAN Network:   ${CYAN}${BOLD}http://${LOCAL_IP}:${PORT}/${RESET}"
fi
echo -e "    • Bind Address:  ${DIM}http://${HOST}:${PORT}/${RESET}"
echo ""
echo -e "  ${BOLD}Controls:${RESET}"
echo -e "    • Press ${WHITE}${BOLD}Ctrl + C${RESET} in this terminal to shut down the server."
echo ""

# Attempt desktop browser launch if running in desktop GUI environment
if [ "$AUTO_OPEN" = true ] && [ -n "${DISPLAY:-${WAYLAND_DISPLAY:-}}" ] && command -v xdg-open >/dev/null 2>&1; then
    log_info "Launching default web browser to http://localhost:${PORT}/ ..."
    (
        sleep 1.2
        xdg-open "http://localhost:${PORT}/" >/dev/null 2>&1 || true
    ) &
fi

log_info "Starting Vite preview server..."
echo -e "${DIM}────────────────────────────────────────────────────────────────${RESET}\n"

exec npm run preview -- --host "$HOST" --port "$PORT"
