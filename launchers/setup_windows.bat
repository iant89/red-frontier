@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ==============================================================================
rem  RED FRONTIER — Windows 11 Automated Environment Setup
rem
rem  Mars · 2066 — Real-Time Strategy · Survival · Automation
rem  Repository: https://github.com/iant89/red-frontier
rem ==============================================================================
rem  This script prepares a Windows 11 system to build and play Red Frontier.
rem  It verifies Git and Node.js LTS (>= v18), installs missing tools via
rem  winget (or PowerShell fallback), updates the session PATH, clones the
rem  repository if needed, and installs npm project dependencies.
rem ==============================================================================

chcp 65001 >nul 2>&1
title Red Frontier — Windows 11 Setup

rem ------------------------------------------------------------------------------
rem Parse Command-Line Arguments
rem ------------------------------------------------------------------------------
set "NON_INTERACTIVE=0"
set "SKIP_SYSTEM=0"
set "SHOW_HELP=0"

for %%a in (%*) do (
    if /i "%%a"=="/y" set "NON_INTERACTIVE=1"
    if /i "%%a"=="-y" set "NON_INTERACTIVE=1"
    if /i "%%a"=="--yes" set "NON_INTERACTIVE=1"
    if /i "%%a"=="--skip-system" set "SKIP_SYSTEM=1"
    if /i "%%a"=="/help" set "SHOW_HELP=1"
    if /i "%%a"=="/?" set "SHOW_HELP=1"
    if /i "%%a"=="-h" set "SHOW_HELP=1"
    if /i "%%a"=="--help" set "SHOW_HELP=1"
)

if "%SHOW_HELP%"=="1" (
    echo.
    echo Red Frontier — Windows 11 Setup Utility
    echo.
    echo Usage:
    echo   setup_windows.bat [/y] [--skip-system] [/help]
    echo.
    echo Options:
    echo   /y, --yes        Run unattended without confirmation pauses
    echo   --skip-system    Skip Git/Node.js system checks (npm install only)
    echo   /?, --help       Display this documentation
    echo.
    exit /b 0
)

rem ------------------------------------------------------------------------------
rem Header Banner
rem ------------------------------------------------------------------------------
echo.
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                      R E D   F R O N T I E R                 │
echo   │             Automated Environment Setup & Installer          │
echo   │          Ares Expeditionary Command · Mars RTS 2066          │
echo   └──────────────────────────────────────────────────────────────┘
echo.

rem ------------------------------------------------------------------------------
rem STEP 1: System Discovery
rem ------------------------------------------------------------------------------
echo [STEP 1/5] System & Platform Discovery
echo ────────────────────────────────────────────────────────────────
for /f "tokens=4-5 delims=[.] " %%i in ('ver') do set "WIN_VER=%%i.%%j"
echo   [i] Operating System: Microsoft Windows (%WIN_VER%)
echo   [i] Architecture:     %PROCESSOR_ARCHITECTURE%
echo   [i] Host Name:        %COMPUTERNAME%
echo.

rem ------------------------------------------------------------------------------
rem STEP 2: Git Toolchain Verification
rem ------------------------------------------------------------------------------
echo [STEP 2/5] Git Version Control Toolchain
echo ────────────────────────────────────────────────────────────────

if "%SKIP_SYSTEM%"=="1" (
    echo   [i] Skipping system toolchain checks (--skip-system).
    goto :check_node
)

rem Pre-populate common install directories into PATH
if exist "%ProgramFiles%\Git\cmd\git.exe" (
    set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin"
)
if exist "%LocalAppData%\Programs\Git\cmd\git.exe" (
    set "PATH=%PATH%;%LocalAppData%\Programs\Git\cmd;%LocalAppData%\Programs\Git\bin"
)

where git >nul 2>&1
if errorlevel 1 (
    echo   [i] Git is not found in PATH. Initiating installation...
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo   [i] Installing Git for Windows via Windows Package Manager (winget)...
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements --silent
    ) else (
        echo   [i] winget not detected. Downloading official installer via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = 'https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe'; $out = Join-Path $env:TEMP 'git-setup.exe'; Write-Host '  [i] Downloading Git package...'; (New-Object Net.WebClient).DownloadFile($url, $out); Write-Host '  [i] Running installer...'; Start-Process $out -ArgumentList '/VERYSILENT','/NORESTART' -Wait"
    )

    rem Refresh PATH after install
    if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin"
    )
    if exist "%LocalAppData%\Programs\Git\cmd\git.exe" (
        set "PATH=%PATH%;%LocalAppData%\Programs\Git\cmd;%LocalAppData%\Programs\Git\bin"
    )

    where git >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [x] ERROR: Git installation could not be completed automatically.
        echo       Please download and install Git manually from: https://git-scm.com/
        echo.
        if "%NON_INTERACTIVE%"=="0" pause
        exit /b 1
    )
    echo   [√] Git installed successfully.
)

for /f "tokens=*" %%v in ('git --version 2^>nul') do echo   [√] Git verified: %%v
echo.

:check_node
rem ------------------------------------------------------------------------------
rem STEP 3: Node.js LTS Runtime & npm
rem ------------------------------------------------------------------------------
echo [STEP 3/5] Node.js LTS Runtime & npm Package Manager
echo ────────────────────────────────────────────────────────────────

if exist "%ProgramFiles%\nodejs\node.exe" (
    set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
)
if exist "%LocalAppData%\Programs\nodejs\node.exe" (
    set "PATH=%PATH%;%LocalAppData%\Programs\nodejs;%APPDATA%\npm"
)

set "INSTALL_NODE=0"

where node >nul 2>&1
if errorlevel 1 (
    set "INSTALL_NODE=1"
) else (
    for /f "tokens=*" %%v in ('node -e "const [m]=process.versions.node.split('.'); console.log(parseInt(m) >= 18 ? 'VALID' : 'OLD')" 2^>nul') do (
        if "%%v"=="OLD" (
            echo   [!] Installed Node.js is below minimum required version 18.
            set "INSTALL_NODE=1"
        )
    )
)

if "%INSTALL_NODE%"=="1" (
    echo   [i] Installing Node.js LTS (v20+)...
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo   [i] Installing OpenJS Node.js LTS via winget...
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements --silent
    ) else (
        echo   [i] Downloading Node.js LTS installer via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'; $out = Join-Path $env:TEMP 'nodejs-setup.msi'; Write-Host '  [i] Downloading Node.js package...'; (New-Object Net.WebClient).DownloadFile($url, $out); Write-Host '  [i] Installing MSI package...'; Start-Process msiexec.exe -ArgumentList '/i', $out, '/passive', '/norestart' -Wait"
    )

    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
    )

    where node >nul 2>&1
    if errorlevel 1 (
        echo.
        echo   [x] ERROR: Node.js installation could not be completed automatically.
        echo       Please download and install Node.js LTS from: https://nodejs.org/
        echo.
        if "%NON_INTERACTIVE%"=="0" pause
        exit /b 1
    )
    echo   [√] Node.js installed successfully.
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do echo   [√] Node.js runtime verified: %%v (satisfies ^>= v18)
for /f "tokens=*" %%v in ('npm -v 2^>nul') do echo   [√] npm package manager verified: v%%v
echo.

rem ------------------------------------------------------------------------------
rem STEP 4: Repository Workspace Resolution
rem ------------------------------------------------------------------------------
echo [STEP 4/5] Repository Workspace & Source Tree
echo ────────────────────────────────────────────────────────────────

set "FOUND_REPO=0"

if exist "package.json" (
    findstr /C:"\"name\": \"red-frontier\"" package.json >nul 2>&1
    if not errorlevel 1 set "FOUND_REPO=1"
)

if "%FOUND_REPO%"=="1" (
    echo   [√] Already inside Red Frontier repository: %CD%
) else if exist "%~dp0package.json" (
    cd /d "%~dp0"
    echo   [√] Repository located at script root: %CD%
) else if exist "%~dp0..\package.json" (
    cd /d "%~dp0.."
    echo   [√] Repository located at parent directory: %CD%
) else if exist "red-frontier\package.json" (
    cd red-frontier
    echo   [√] Entered existing red-frontier folder: %CD%
) else (
    echo   [i] Cloning Red Frontier from https://github.com/iant89/red-frontier.git...
    git clone https://github.com/iant89/red-frontier.git red-frontier
    if errorlevel 1 (
        echo.
        echo   [x] ERROR: Git clone failed. Please check network connectivity.
        echo.
        if "%NON_INTERACTIVE%"=="0" pause
        exit /b 1
    )
    cd red-frontier
    echo   [√] Repository cloned successfully into: %CD%
)

for /f "tokens=*" %%c in ('git log -1 --pretty^=format:"%%h — %%s (%%cd)" --date^=short 2^>nul') do (
    echo   [i] Checked out commit: %%c
)
echo.

rem ------------------------------------------------------------------------------
rem STEP 5: Project Dependencies (npm)
rem ------------------------------------------------------------------------------
echo [STEP 5/5] Project Dependencies (npm install)
echo ────────────────────────────────────────────────────────────────
echo   [i] Installing and verifying npm packages...

call npm install --silent
if errorlevel 1 (
    echo.
    echo   [x] ERROR: npm install encountered an issue.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b %errorlevel%
)
echo   [√] Project dependencies are satisfied.
echo.

rem ------------------------------------------------------------------------------
rem Summary & Next Steps
rem ------------------------------------------------------------------------------
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                 ENVIRONMENT SETUP COMPLETED                  │
echo   └──────────────────────────────────────────────────────────────┘
echo.
echo   Environment Summary:
echo     • Workspace:   %CD%
for /f "tokens=*" %%v in ('git --version 2^>nul') do echo     • Git:         %%v
for /f "tokens=*" %%v in ('node -v 2^>nul') do echo     • Node.js:     %%v
for /f "tokens=*" %%v in ('npm -v 2^>nul') do echo     • npm:         v%%v
echo.
echo   Next Available Commands:
echo     1. Build the game:
echo        launchers\update_and_build.bat   (pulls newest changes and builds to dist\)
echo.
echo     2. Launch local preview server:
echo        launchers\launch_preview.bat     (serves production build at http://localhost:4173)
echo.

if "%NON_INTERACTIVE%"=="0" pause
exit /b 0
