#!/usr/bin/env bash
# ==============================================================================
# Red Frontier - Ubuntu / Linux Setup Script
#
# This script:
#   1. Checks and installs system dependencies (Git, curl, Node.js LTS, npm)
#   2. Clones / downloads the Red Frontier repository if not already present
#   3. Installs all project dependencies via npm
# ==============================================================================

set -euo pipefail

# Terminal colors
BOLD='\033[1m'
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

REPO_URL="https://github.com/iant89/red-frontier.git"
REPO_DIR_NAME="red-frontier"
MIN_NODE_MAJOR=18

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

run_as_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@"
    elif command -v sudo >/dev/null 2>&1; then
        sudo "$@"
    else
        print_error "Root privileges are required to install system packages, but 'sudo' was not found."
        print_error "Please run this script as root or install sudo."
        return 1
    fi
}

echo -e "${CYAN}${BOLD}"
echo "=========================================================="
echo "          Red Frontier - Ubuntu / Linux Setup             "
echo "=========================================================="
echo -e "${NC}"

# ------------------------------------------------------------------------------
# 1. Check Operating System
# ------------------------------------------------------------------------------
print_info "Checking operating system..."
if [ -f /etc/os-release ]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    OS_ID="${ID:-unknown}"
    OS_NAME="${NAME:-Linux}"
    print_info "Detected OS: $OS_NAME ($OS_ID)"
else
    print_warning "Unable to detect OS from /etc/os-release. Assuming Debian/Ubuntu-compatible Linux."
fi

# ------------------------------------------------------------------------------
# 2. Check and Install Git
# ------------------------------------------------------------------------------
print_info "Checking for Git..."
if ! command -v git >/dev/null 2>&1; then
    print_info "Git is not installed. Installing Git via apt-get..."
    run_as_root apt-get update -y
    run_as_root apt-get install -y git
    print_success "Git installed successfully: $(git --version)"
else
    print_success "Git is already installed: $(git --version)"
fi

# ------------------------------------------------------------------------------
# 3. Check and Install curl and ca-certificates
# ------------------------------------------------------------------------------
print_info "Checking for curl and certificates..."
if ! command -v curl >/dev/null 2>&1; then
    print_info "curl is not installed. Installing curl and ca-certificates via apt-get..."
    run_as_root apt-get update -y
    run_as_root apt-get install -y curl ca-certificates gnupg
    print_success "curl installed successfully: $(curl --version | head -n 1)"
else
    print_success "curl is already installed: $(curl --version | head -n 1)"
fi

# ------------------------------------------------------------------------------
# 4. Check and Install Node.js & npm (requires Node >= 18)
# ------------------------------------------------------------------------------
print_info "Checking for Node.js and npm..."
NODE_NEEDS_INSTALL=0

if command -v node >/dev/null 2>&1; then
    CURRENT_NODE_VERSION="$(node -v | sed -E 's/^v//')"
    CURRENT_NODE_MAJOR="$(echo "$CURRENT_NODE_VERSION" | cut -d. -f1)"
    if [ "$CURRENT_NODE_MAJOR" -ge "$MIN_NODE_MAJOR" ]; then
        print_success "Node.js is installed: v$CURRENT_NODE_VERSION (satisfies >= v$MIN_NODE_MAJOR)"
    else
        print_warning "Node.js version v$CURRENT_NODE_VERSION is too old (Red Frontier requires >= v$MIN_NODE_MAJOR)."
        NODE_NEEDS_INSTALL=1
    fi
else
    print_info "Node.js is not installed."
    NODE_NEEDS_INSTALL=1
fi

if ! command -v npm >/dev/null 2>&1; then
    NODE_NEEDS_INSTALL=1
fi

if [ "$NODE_NEEDS_INSTALL" -eq 1 ]; then
    print_info "Installing Node.js LTS (v20.x) from NodeSource repository..."
    run_as_root apt-get update -y
    run_as_root apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | run_as_root bash -
    run_as_root apt-get install -y nodejs
    print_success "Node.js installed: $(node -v)"
    print_success "npm installed: v$(npm -v)"
else
    print_success "npm is already installed: v$(npm -v)"
fi

# ------------------------------------------------------------------------------
# 5. Locate or Clone Repository
# ------------------------------------------------------------------------------
print_info "Locating Red Frontier repository..."

is_red_frontier_repo() {
    local dir="$1"
    if [ -f "$dir/package.json" ]; then
        if grep -q '"name": *"red-frontier"' "$dir/package.json" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# Resolve script directory in case setup.sh is located inside the repo
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if is_red_frontier_repo "."; then
    print_success "Current directory is the Red Frontier repository."
elif is_red_frontier_repo "$SCRIPT_DIR"; then
    print_info "Moving into repository directory: $SCRIPT_DIR"
    cd "$SCRIPT_DIR"
    print_success "Found Red Frontier at: $(pwd)"
elif is_red_frontier_repo "$SCRIPT_DIR/.."; then
    REPO_PARENT="$(cd "$SCRIPT_DIR/.." && pwd)"
    print_info "Moving into repository directory: $REPO_PARENT"
    cd "$REPO_PARENT"
    print_success "Found Red Frontier at: $(pwd)"
elif is_red_frontier_repo "$REPO_DIR_NAME"; then
    print_info "Found existing '$REPO_DIR_NAME' folder. Entering..."
    cd "$REPO_DIR_NAME"
    print_success "Repository located at: $(pwd)"
else
    print_info "Downloading Red Frontier from $REPO_URL..."
    git clone "$REPO_URL" "$REPO_DIR_NAME"
    cd "$REPO_DIR_NAME"
    print_success "Repository cloned successfully into: $(pwd)"
fi

# ------------------------------------------------------------------------------
# 6. Install Project Dependencies
# ------------------------------------------------------------------------------
print_info "Installing project dependencies via npm..."
npm install

print_success "Project dependencies installed successfully!"

# ------------------------------------------------------------------------------
# 7. Complete Summary
# ------------------------------------------------------------------------------
echo -e "${GREEN}${BOLD}"
echo "=========================================================="
echo "   Red Frontier setup completed successfully!            "
echo "=========================================================="
echo -e "${NC}"
echo "Next steps:"
echo "  1. Pull latest changes & build the game:"
echo "     ./update_and_build.sh"
echo ""
echo "  2. Launch local preview server:"
echo "     ./launch_preview.sh"
echo ""
