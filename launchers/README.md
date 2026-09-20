# Red Frontier — Game Launchers & Setup Scripts

This directory contains standalone, user-facing scripts for setting up, updating, building, and playing **Red Frontier** on **Ubuntu (Linux)** and **Windows 11**.

> **Note**: These scripts are separated from `scripts/` (which contains internal development and testing utilities such as benchmarks and Playwright smoke suites).

---

## Script Index

| Purpose | Ubuntu / Linux | Windows 11 | Description |
|---|---|---|---|
| **1. Setup & Dependencies** | [`setup_ubuntu.sh`](setup_ubuntu.sh) *(or `setup.sh`)* | [`setup_windows.bat`](setup_windows.bat) *(or `setup.bat`)* | Verifies/installs Git, Node.js LTS (≥ 18), curl, and npm dependencies. Clones the game if not already present. |
| **2. Update & Build** | [`update_and_build.sh`](update_and_build.sh) *(or `build.sh`)* | [`update_and_build.bat`](update_and_build.bat) *(or `build.bat`)* | Pulls latest commits from GitHub, checks for package updates, and compiles the production bundle (`dist/`). |
| **3. Launch Preview** | [`launch_preview.sh`](launch_preview.sh) *(or `preview.sh`)* | [`launch_preview.bat`](launch_preview.bat) *(or `preview.bat`)* | Starts Vite preview server at `http://localhost:4173/` and opens the default browser for instant local gameplay. |

---

## Quick Usage

### On Ubuntu / Debian Linux
Run directly from the repository root:
```bash
# 1. First-time setup (installs Git, Node.js 20 LTS, npm packages)
./launchers/setup_ubuntu.sh

# 2. Pull latest source and build game
./launchers/update_and_build.sh

# 3. Launch local game server (playable at http://localhost:4173)
./launchers/launch_preview.sh
```

*(You can also `cd launchers` and run `./setup_ubuntu.sh`, `./update_and_build.sh`, `./launch_preview.sh` directly).*

#### Available Flags
- **`setup_ubuntu.sh`**: `-y` (unattended), `-d <dir>` (custom clone folder), `-s` (skip system pkgs), `-v` (verbose), `-h` (help)
- **`update_and_build.sh`**: `-b <branch>` (target branch), `-s` (skip pull), `-c` (clean rebuild), `-v` (verbose), `-h` (help)
- **`launch_preview.sh`**: `-p <port>` (custom port), `-h <host>` (custom bind host), `-b` (force rebuild), `--no-open` (do not launch browser), `-h` (help)

---

### On Windows 11
From Command Prompt (`cmd.exe`), PowerShell, or Windows Terminal:
```cmd
rem 1. First-time setup (verifies Git & Node.js via winget/PowerShell and installs dependencies)
launchers\setup_windows.bat

rem 2. Pull latest source and build game
launchers\update_and_build.bat

rem 3. Launch local game server (opens http://localhost:4173 in browser)
launchers\launch_preview.bat
```

*(You can also double-click the `.bat` files directly in Windows File Explorer).*

#### Available Flags
- **`setup_windows.bat`**: `/y` (unattended), `--skip-system` (npm only), `/help`
- **`update_and_build.bat`**: `/skip-pull` (skip git pull), `/clean` (clean rebuild), `/y` (unattended), `/help`
- **`launch_preview.bat`**: `/p <port>`, `/h <host>`, `/build` (rebuild first), `/no-open`, `/help`
