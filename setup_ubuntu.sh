#!/usr/bin/env bash
# ==============================================================================
#  RED FRONTIER — Ubuntu / Debian Automated Environment Setup
#
#  Mars · 2066 — Real-Time Strategy · Survival · Automation
#  Repository: https://github.com/iant89/red-frontier
# ==============================================================================
#  This script prepares a fresh or existing Ubuntu/Debian system to build and
#  run Red Frontier. It detects missing system packages (Git, curl, Node.js LTS,
#  npm), installs them with appropriate permissions, clones or verifies the
#  game repository, and installs all npm project dependencies.
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
# Default Configuration
# ------------------------------------------------------------------------------
SCRIPT_VERSION="1.1.0"
REPO_URL="https://github.com/iant89/red-frontier.git"
DEFAULT_TARGET_DIR="red-frontier"
TARGET_DIR=""
MIN_NODE_VERSION=18
NODE_TARGET_LTS=20
NON_INTERACTIVE=false
SKIP_SYSTEM=false
VERBOSE=false

# ------------------------------------------------------------------------------
# Logging Functions
# ------------------------------------------------------------------------------
log_banner() {
    echo -e "${MARS}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────────┐"
    echo "  │                      R E D   F R O N T I E R                 │"
    echo "  │             Automated Environment Setup & Installer          │"
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
# Error Trap & Cleanup
# ------------------------------------------------------------------------------
cleanup() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo ""
        log_error "Setup encountered an error and could not complete (Exit Code: $exit_code)."
        echo -e "  ${DIM}For support or troubleshooting, see docs/ or file an issue on GitHub.${RESET}"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------------------
# CLI Help & Options
# ------------------------------------------------------------------------------
show_help() {
    cat << EOF
Red Frontier — Ubuntu / Debian Setup Utility (v${SCRIPT_VERSION})

Usage:
  ./setup_ubuntu.sh [options]

Options:
  -y, --yes          Run non-interactively (accept all prompts automatically)
  -d, --dir <path>   Destination directory for repository clone (default: ./${DEFAULT_TARGET_DIR})
  -s, --skip-system  Skip system package checks (run npm install only)
  -v, --verbose      Show full output from underlying package managers
  -h, --help         Display this help message and exit

Description:
  1. Detects system architecture and OS release (Ubuntu/Debian).
  2. Verifies and installs missing dependencies: Git, curl, ca-certificates.
  3. Verifies Node.js (>= v${MIN_NODE_VERSION}) & npm; installs Node.js ${NODE_TARGET_LTS} LTS if needed.
  4. Clones the game repository from GitHub (if not already inside one).
  5. Installs all project dependencies via npm.

Examples:
  ./setup_ubuntu.sh
  ./setup_ubuntu.sh -y
  ./setup_ubuntu.sh --dir ~/games/red-frontier
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        -y|--yes)
            NON_INTERACTIVE=true
            shift
            ;;
        -d|--dir)
            TARGET_DIR="$2"
            shift 2
            ;;
        -s|--skip-system)
            SKIP_SYSTEM=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
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
# Privilege Elevation Helper
# ------------------------------------------------------------------------------
run_elevated() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        if [ "$NON_INTERACTIVE" = true ]; then
            sudo -n "$@"
        else
            sudo "$@"
        fi
    else
        log_error "Root privileges are required to install system packages, but 'sudo' was not found."
        log_error "Please run this script as root or install sudo."
        return 1
    fi
}

# ------------------------------------------------------------------------------
# Execution Flow
# ------------------------------------------------------------------------------
log_banner

TOTAL_STEPS=5
CURRENT_STEP=1

# ------------------------------------------------------------------------------
# STEP 1: System Identification
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "System & Platform Discovery"
CURRENT_STEP=$((CURRENT_STEP + 1))

ARCH="$(uname -m)"
KERNEL="$(uname -r)"
OS_NAME="Linux"
OS_VER="Unknown"

if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    OS_NAME="${PRETTY_NAME:-Linux}"
    OS_ID="${ID:-linux}"
    log_info "Operating System: ${BOLD}${OS_NAME}${RESET} (${ARCH})"
    log_info "Kernel Release:   ${KERNEL}"
else
    log_warn "Standard /etc/os-release not detected; continuing in Debian-compatible mode."
fi

# ------------------------------------------------------------------------------
# STEP 2: System Package Manager & Core Tools
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "System Dependencies (Git, curl, certificates)"
CURRENT_STEP=$((CURRENT_STEP + 1))

if [ "$SKIP_SYSTEM" = true ]; then
    log_info "Skipping system package verification (--skip-system enabled)."
else
    # 1. Check Git
    if ! command -v git >/dev/null 2>&1; then
        log_info "Git was not found. Installing via apt-get..."
        run_elevated apt-get update -y ${VERBOSE:+>/dev/null}
        run_elevated apt-get install -y git ${VERBOSE:+>/dev/null}
        log_success "Git installed: $(git --version)"
    else
        log_success "Git verified: $(git --version)"
    fi

    # 2. Check curl & certificates
    if ! command -v curl >/dev/null 2>&1; then
        log_info "curl not found. Installing curl, ca-certificates, and gnupg..."
        run_elevated apt-get update -y ${VERBOSE:+>/dev/null}
        run_elevated apt-get install -y curl ca-certificates gnupg ${VERBOSE:+>/dev/null}
        log_success "curl installed: $(curl --version | head -n 1 | awk '{print $1, $2}')"
    else
        log_success "curl verified: $(curl --version | head -n 1 | awk '{print $1, $2}')"
    fi
fi

# ------------------------------------------------------------------------------
# STEP 3: Node.js & npm Toolchain Check
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "JavaScript Runtime (Node.js LTS >= v${MIN_NODE_VERSION} & npm)"
CURRENT_STEP=$((CURRENT_STEP + 1))

INSTALL_NODE=false

if command -v node >/dev/null 2>&1; then
    NODE_VERSION_STR="$(node -v | sed -E 's/^v//')"
    NODE_MAJOR="$(echo "$NODE_VERSION_STR" | cut -d. -f1)"
    if [ "$NODE_MAJOR" -ge "$MIN_NODE_VERSION" ]; then
        log_success "Node.js runtime verified: v${NODE_VERSION_STR} (satisfies >= v${MIN_NODE_VERSION})"
    else
        log_warn "Installed Node.js (v${NODE_VERSION_STR}) is below the minimum required version (v${MIN_NODE_VERSION})."
        INSTALL_NODE=true
    fi
else
    log_info "Node.js is not present in PATH."
    INSTALL_NODE=true
fi

if ! command -v npm >/dev/null 2>&1; then
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
    if [ "$SKIP_SYSTEM" = true ]; then
        log_error "Node.js >= v${MIN_NODE_VERSION} is required, but --skip-system was requested."
        exit 1
    fi

    log_info "Configuring NodeSource repository for Node.js ${NODE_TARGET_LTS} LTS..."
    run_elevated apt-get update -y ${VERBOSE:+>/dev/null}
    run_elevated apt-get install -y curl ca-certificates gnupg ${VERBOSE:+>/dev/null}

    # Setup NodeSource repository with official distribution script
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_TARGET_LTS}.x" | run_elevated bash - ${VERBOSE:+>/dev/null}
    run_elevated apt-get install -y nodejs ${VERBOSE:+>/dev/null}

    log_success "Node.js successfully installed: $(node -v)"
    log_success "npm successfully installed:     v$(npm -v)"
else
    log_success "npm verified:                   v$(npm -v)"
fi

# ------------------------------------------------------------------------------
# STEP 4: Repository Workspace Resolution
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "Repository Workspace & Source Tree"
CURRENT_STEP=$((CURRENT_STEP + 1))

is_game_root() {
    local dir="$1"
    if [ -f "$dir/package.json" ]; then
        if grep -q '"name": *"red-frontier"' "$dir/package.json" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

if is_game_root "."; then
    log_success "Already inside Red Frontier repository: $(pwd -P)"
elif is_game_root "$SCRIPT_DIR"; then
    log_info "Navigating to repository root at: $SCRIPT_DIR"
    cd "$SCRIPT_DIR"
    log_success "Repository workspace active: $(pwd -P)"
elif is_game_root "$SCRIPT_DIR/.."; then
    PARENT_DIR="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
    log_info "Navigating to repository root at: $PARENT_DIR"
    cd "$PARENT_DIR"
    log_success "Repository workspace active: $(pwd -P)"
else
    DEST="${TARGET_DIR:-$DEFAULT_TARGET_DIR}"
    if is_game_root "$DEST"; then
        log_info "Found existing Red Frontier directory at '$DEST'. Entering..."
        cd "$DEST"
        log_success "Repository workspace active: $(pwd -P)"
    else
        log_info "Cloning Red Frontier from ${REPO_URL} into './${DEST}'..."
        git clone "$REPO_URL" "$DEST"
        cd "$DEST"
        log_success "Repository successfully cloned: $(pwd -P)"
    fi
fi

CURRENT_COMMIT="$(git log -1 --pretty=format:'%h — %s (%ci)' 2>/dev/null || echo 'HEAD')"
log_info "Checked out commit: ${DIM}${CURRENT_COMMIT}${RESET}"

# ------------------------------------------------------------------------------
# STEP 5: Project Dependencies (npm)
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "Project Dependencies (npm install)"

log_info "Running npm install to verify and fetch packages..."
if [ "$VERBOSE" = true ]; then
    npm install
else
    npm install --silent
fi

log_success "Project dependencies are satisfied."

# ------------------------------------------------------------------------------
# Summary Card & Next Steps
# ------------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}  ┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}${BOLD}  │                 ENVIRONMENT SETUP COMPLETED                  │${RESET}"
echo -e "${GREEN}${BOLD}  └──────────────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${BOLD}Environment Summary:${RESET}"
echo -e "    • Repository:  ${WHITE}$(pwd -P)${RESET}"
echo -e "    • Git Version: ${WHITE}$(git --version | awk '{print $3}')${RESET}"
echo -e "    • Node.js:     ${WHITE}$(node -v)${RESET} (${WHITE}$(which node)${RESET})"
echo -e "    • npm:         ${WHITE}v$(npm -v)${RESET} (${WHITE}$(which npm)${RESET})"
echo ""
echo -e "  ${BOLD}Next Available Commands:${RESET}"
echo -e "    ${MARS}${BOLD}1. Build the game:${RESET}"
echo -e "       ${WHITE}./update_and_build.sh${RESET}   ${DIM}(pulls newest changes and builds to dist/)${RESET}"
echo ""
echo -e "    ${MARS}${BOLD}2. Launch local preview server:${RESET}"
echo -e "       ${WHITE}./launch_preview.sh${RESET}     ${DIM}(serves production build at http://localhost:4173)${RESET}"
echo ""
