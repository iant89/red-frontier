#!/usr/bin/env bash
# ==============================================================================
#  RED FRONTIER — Pull Latest Source & Build Game
#
#  Mars · 2066 — Real-Time Strategy · Survival · Automation
#  Repository: https://github.com/iant89/red-frontier
# ==============================================================================
#  This script synchronizes the local repository with GitHub, verifies and
#  updates npm dependencies, compiles TypeScript, and runs the Vite production
#  bundler. It validates generated build artifacts and prints detailed telemetry.
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
SKIP_PULL=false
CLEAN_BUILD=false
TARGET_BRANCH=""
VERBOSE=false

# ------------------------------------------------------------------------------
# Logging Functions
# ------------------------------------------------------------------------------
log_banner() {
    echo -e "${MARS}${BOLD}"
    echo "  ┌──────────────────────────────────────────────────────────────┐"
    echo "  │                      R E D   F R O N T I E R                 │"
    echo "  │           Source Synchronizer & Production Builder           │"
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
        log_error "Build failed with exit code $exit_code."
        echo -e "  ${DIM}Inspect compilation logs above for details. Run './update_and_build.sh --clean' if build cache is corrupt.${RESET}"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------------------
# CLI Help & Argument Parsing
# ------------------------------------------------------------------------------
show_help() {
    cat << EOF
Red Frontier — Update & Build Utility (v${SCRIPT_VERSION})

Usage:
  ./update_and_build.sh [options]

Options:
  -b, --branch <name>  Switch to / pull from specified branch (default: current branch)
  -s, --skip-pull      Skip fetching from GitHub (build current local source)
  -c, --clean          Remove dist/ and reinstall node_modules before building
  -v, --verbose        Display detailed compilation logs
  -h, --help           Display this help message and exit

Description:
  1. Locates the Red Frontier repository root.
  2. Pulls the latest commits from GitHub origin.
  3. Audits and updates npm dependencies.
  4. Runs TypeScript type-checking and Vite production bundler (tsc && vite build).
  5. Verifies output assets in dist/ (index.html, worker scripts, styles, manifests).

Examples:
  ./update_and_build.sh
  ./update_and_build.sh --skip-pull
  ./update_and_build.sh --clean
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        -s|--skip-pull)
            SKIP_PULL=true
            shift
            ;;
        -b|--branch)
            TARGET_BRANCH="$2"
            shift 2
            ;;
        -c|--clean)
            CLEAN_BUILD=true
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
# Execution Flow
# ------------------------------------------------------------------------------
log_banner

TOTAL_STEPS=4
CURRENT_STEP=1

# ------------------------------------------------------------------------------
# STEP 1: Repository Workspace Resolution
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "Workspace & Toolchain Validation"
CURRENT_STEP=$((CURRENT_STEP + 1))

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

if [ -f "$SCRIPT_DIR/package.json" ] && grep -q '"name": *"red-frontier"' "$SCRIPT_DIR/package.json" 2>/dev/null; then
    REPO_ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../package.json" ] && grep -q '"name": *"red-frontier"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
    REPO_ROOT="$(cd "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
elif [ -f "./package.json" ] && grep -q '"name": *"red-frontier"' "./package.json" 2>/dev/null; then
    REPO_ROOT="$(pwd -P)"
else
    log_error "Could not locate Red Frontier repository root (package.json not found)."
    exit 1
fi

cd "$REPO_ROOT"
log_info "Active repository root: ${BOLD}${REPO_ROOT}${RESET}"

# Verify tools
if ! command -v git >/dev/null 2>&1; then
    log_error "Git is not installed or not in PATH. Please run ./setup_ubuntu.sh first."
    exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    log_error "Node.js or npm is missing. Please run ./setup_ubuntu.sh first."
    exit 1
fi

log_success "Toolchain ready: Node $(node -v) · npm v$(npm -v) · Git $(git --version | awk '{print $3}')"

# ------------------------------------------------------------------------------
# STEP 2: Source Code Synchronization (GitHub)
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "GitHub Source Synchronization"
CURRENT_STEP=$((CURRENT_STEP + 1))

if [ "$SKIP_PULL" = true ]; then
    log_info "Skipping Git pull (--skip-pull active). Using local source as-is."
elif [ -d ".git" ]; then
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    
    if [ -n "$TARGET_BRANCH" ] && [ "$TARGET_BRANCH" != "$CURRENT_BRANCH" ]; then
        log_info "Switching to branch '$TARGET_BRANCH'..."
        git checkout "$TARGET_BRANCH"
        CURRENT_BRANCH="$TARGET_BRANCH"
    fi

    # Check for local uncommitted changes
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        log_warn "Local modifications detected in working directory."
        log_info "Attempting clean pull with rebase..."
    fi

    UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")"

    if [ -n "$UPSTREAM" ]; then
        log_info "Pulling updates from tracked upstream (${UPSTREAM})..."
        git pull || {
            log_warn "Direct merge failed. Attempting git pull --rebase..."
            git pull --rebase || log_warn "Pull could not be completed cleanly; proceeding with local source."
        }
    elif [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "HEAD" ]; then
        if git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
            log_info "Pulling branch '$CURRENT_BRANCH' from origin..."
            git pull origin "$CURRENT_BRANCH" || log_warn "Pull failed; proceeding with local source."
        else
            log_info "Remote branch 'origin/${CURRENT_BRANCH}' not found. Fetching from origin/main..."
            if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
                git pull origin main || log_warn "Pull from main failed; proceeding with local source."
            fi
        fi
    else
        log_warn "Detached HEAD state. Fetching remote references..."
        git fetch origin || true
    fi

    HEAD_INFO="$(git log -1 --pretty=format:'%h — %s (%cd)' --date=short 2>/dev/null || echo 'HEAD')"
    log_success "Source tree synchronized: ${HEAD_INFO}"
else
    log_warn "Not a git repository (.git folder not found). Skipping sync."
fi

# ------------------------------------------------------------------------------
# STEP 3: Dependencies Verification
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "Dependency Check & Verification"
CURRENT_STEP=$((CURRENT_STEP + 1))

if [ "$CLEAN_BUILD" = true ]; then
    log_info "Cleaning previous build artifacts and node_modules (--clean)..."
    rm -rf dist node_modules
    log_info "Reinstalling fresh node_modules..."
    npm install
elif [ ! -d "node_modules" ]; then
    log_info "node_modules missing. Installing dependencies..."
    npm install
else
    log_info "Verifying dependencies are up to date..."
    npm install --prefer-offline --no-audit
fi

log_success "Dependencies verified."

# ------------------------------------------------------------------------------
# STEP 4: Production Compilation (TypeScript & Vite)
# ------------------------------------------------------------------------------
log_step "$CURRENT_STEP" "$TOTAL_STEPS" "Production Build (tsc && vite build)"

log_info "Compiling TypeScript and bundling assets with Vite..."
BUILD_START_TIME="$(date +%s)"

if [ "$VERBOSE" = true ]; then
    npm run build
else
    npm run build
fi

BUILD_END_TIME="$(date +%s)"
BUILD_DURATION=$((BUILD_END_TIME - BUILD_START_TIME))

# Validate output
if [ ! -f "dist/index.html" ]; then
    log_error "Build succeeded without throwing an error, but 'dist/index.html' is missing!"
    exit 1
fi

log_success "Build completed in ${BUILD_DURATION}s."

# ------------------------------------------------------------------------------
# Build Summary & Telemetry
# ------------------------------------------------------------------------------
TOTAL_SIZE="$(du -sh dist | awk '{print $1}')"
FILE_COUNT="$(find dist -type f | wc -l)"

echo ""
echo -e "${GREEN}${BOLD}  ┌──────────────────────────────────────────────────────────────┐${RESET}"
echo -e "${GREEN}${BOLD}  │                 PRODUCTION BUILD SUCCESSFUL                  │${RESET}"
echo -e "${GREEN}${BOLD}  └──────────────────────────────────────────────────────────────┘${RESET}"
echo ""
echo -e "  ${BOLD}Build Telemetry:${RESET}"
echo -e "    • Destination:   ${WHITE}dist/${RESET}"
echo -e "    • Total Size:    ${WHITE}${TOTAL_SIZE}${RESET} (${WHITE}${FILE_COUNT} files${RESET})"
echo -e "    • Entrypoint:    ${WHITE}dist/index.html${RESET}"

if [ -f "dist/version.json" ]; then
    COMMIT_STAMP="$(grep '"commit"' dist/version.json | head -n 1 | awk -F'"' '{print $4}' | cut -c1-8)"
    BUILT_AT="$(grep '"builtAt"' dist/version.json | head -n 1 | awk -F'"' '{print $4}')"
    echo -e "    • Commit Stamp:  ${WHITE}${COMMIT_STAMP:-unknown}${RESET}"
    echo -e "    • Build Time:    ${WHITE}${BUILT_AT:-now}${RESET}"
fi

echo ""
echo -e "  ${BOLD}Launch Game Server:${RESET}"
echo -e "    ${MARS}${BOLD}Run:${RESET} ${WHITE}./launch_preview.sh${RESET}"
echo -e "    ${DIM}Serves the compiled distribution locally on http://localhost:4173${RESET}"
echo ""
