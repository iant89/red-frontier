#!/usr/bin/env bash
# ==============================================================================
# Red Frontier - Pull Latest Source & Build Game
#
# This script:
#   1. Pulls the latest commits from GitHub
#   2. Verifies and updates npm dependencies
#   3. Builds the production bundle (tsc && vite build)
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
print_info "Working directory: $REPO_ROOT"

# ------------------------------------------------------------------------------
# 2. Verify Prerequisites
# ------------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
    print_error "Git is not installed. Please run ./setup_ubuntu.sh first."
    exit 1
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    print_error "Node.js or npm is not installed. Please run ./setup_ubuntu.sh first."
    exit 1
fi

# ------------------------------------------------------------------------------
# 3. Pull Latest Source from GitHub
# ------------------------------------------------------------------------------
if [ -d ".git" ]; then
    print_info "Pulling latest source from GitHub..."

    # Check for uncommitted changes
    if ! git diff-index --quiet HEAD -- 2>/dev/null; then
        print_warning "You have uncommitted changes in your working tree."
        print_warning "Attempting git pull with automatic rebase/merge..."
    fi

    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"
    UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || echo "")"

    if [ -n "$UPSTREAM" ]; then
        print_info "Pulling from upstream tracked branch: $UPSTREAM"
        git pull || {
            print_warning "Standard git pull failed. Trying git pull --rebase..."
            git pull --rebase || print_warning "Pull could not be completed cleanly; continuing with current code."
        }
    elif [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "HEAD" ]; then
        # Check if remote branch exists on origin
        if git ls-remote --exit-code --heads origin "$CURRENT_BRANCH" >/dev/null 2>&1; then
            print_info "Pulling branch '$CURRENT_BRANCH' from origin..."
            git pull origin "$CURRENT_BRANCH" || print_warning "Pull failed; continuing with current code."
        else
            print_info "Remote branch origin/$CURRENT_BRANCH not found. Checking origin/main..."
            if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
                git pull origin main || print_warning "Could not pull origin/main; continuing with current code."
            fi
        fi
    else
        print_warning "Detached HEAD state. Fetching latest origin commits..."
        git fetch origin || true
    fi

    LATEST_COMMIT="$(git log -1 --pretty=format:'%h - %s (%ci)' 2>/dev/null || echo 'unknown')"
    print_success "Current commit: $LATEST_COMMIT"
else
    print_warning "Not a Git repository. Skipping git pull."
fi

# ------------------------------------------------------------------------------
# 4. Ensure Dependencies are Up to Date
# ------------------------------------------------------------------------------
if [ ! -d "node_modules" ]; then
    print_info "node_modules missing. Installing dependencies..."
    npm install
else
    print_info "Checking / updating project dependencies..."
    npm install
fi

# ------------------------------------------------------------------------------
# 5. Build the Game
# ------------------------------------------------------------------------------
echo ""
print_info "Building Red Frontier for production (tsc && vite build)..."
echo ""

npm run build

if [ -f "dist/index.html" ]; then
    echo ""
    echo -e "${GREEN}${BOLD}"
    echo "=========================================================="
    echo "   ✓ Red Frontier built successfully!                     "
    echo "=========================================================="
    echo -e "${NC}"
    if [ -f "dist/version.json" ]; then
        print_info "Build manifest: $(cat dist/version.json | tr -d '\n')"
    fi
    echo ""
    echo "To launch the game preview server, run:"
    echo "  ./launch_preview.sh"
    echo ""
else
    print_error "Build completed but dist/index.html was not generated."
    exit 1
fi
