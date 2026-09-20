@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ==============================================================================
rem  RED FRONTIER — Pull Latest Source & Build Game (Windows 11)
rem
rem  Mars · 2066 — Real-Time Strategy · Survival · Automation
rem  Repository: https://github.com/iant89/red-frontier
rem ==============================================================================
rem  This script synchronizes the local repository with GitHub, audits and
rem  updates npm dependencies, compiles TypeScript, and runs the Vite production
rem  bundler. It validates generated build artifacts and prints detailed telemetry.
rem ==============================================================================

chcp 65001 >nul 2>&1
title Red Frontier — Update & Build

rem ------------------------------------------------------------------------------
rem Parse Command-Line Arguments
rem ------------------------------------------------------------------------------
set "SKIP_PULL=0"
set "CLEAN_BUILD=0"
set "NON_INTERACTIVE=0"
set "SHOW_HELP=0"

for %%a in (%*) do (
    if /i "%%a"=="/skip-pull" set "SKIP_PULL=1"
    if /i "%%a"=="--skip-pull" set "SKIP_PULL=1"
    if /i "%%a"=="/clean" set "CLEAN_BUILD=1"
    if /i "%%a"=="--clean" set "CLEAN_BUILD=1"
    if /i "%%a"=="/y" set "NON_INTERACTIVE=1"
    if /i "%%a"=="-y" set "NON_INTERACTIVE=1"
    if /i "%%a"=="/help" set "SHOW_HELP=1"
    if /i "%%a"=="/?" set "SHOW_HELP=1"
    if /i "%%a"=="--help" set "SHOW_HELP=1"
)

if "%SHOW_HELP%"=="1" (
    echo.
    echo Red Frontier — Update ^& Build Utility
    echo.
    echo Usage:
    echo   update_and_build.bat [/skip-pull] [/clean] [/y] [/help]
    echo.
    echo Options:
    echo   /skip-pull, --skip-pull  Skip GitHub sync (build current local source)
    echo   /clean, --clean          Remove dist\ and reinstall node_modules first
    echo   /y, --yes                Run unattended without final pause
    echo   /?, --help               Display this documentation
    echo.
    exit /b 0
)

rem ------------------------------------------------------------------------------
rem Header Banner
rem ------------------------------------------------------------------------------
echo.
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                      R E D   F R O N T I E R                 │
echo   │           Source Synchronizer & Production Builder           │
echo   │          Ares Expeditionary Command · Mars RTS 2066          │
echo   └──────────────────────────────────────────────────────────────┘
echo.

rem ------------------------------------------------------------------------------
rem STEP 1: Workspace Resolution & Toolchain Check
rem ------------------------------------------------------------------------------
echo [STEP 1/4] Workspace & Toolchain Validation
echo ────────────────────────────────────────────────────────────────

set "REPO_ROOT="
if exist "%~dp0package.json" (
    findstr /C:"\"name\": \"red-frontier\"" "%~dp0package.json" >nul 2>&1
    if not errorlevel 1 set "REPO_ROOT=%~dp0"
)
if not defined REPO_ROOT (
    if exist "%~dp0..\package.json" (
        findstr /C:"\"name\": \"red-frontier\"" "%~dp0..\package.json" >nul 2>&1
        if not errorlevel 1 set "REPO_ROOT=%~dp0.."
    )
)
if not defined REPO_ROOT (
    if exist "package.json" (
        findstr /C:"\"name\": \"red-frontier\"" "package.json" >nul 2>&1
        if not errorlevel 1 set "REPO_ROOT=%CD%"
    )
)

if not defined REPO_ROOT (
    echo.
    echo   [x] ERROR: Cannot locate Red Frontier repository root (package.json not found).
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

cd /d "%REPO_ROOT%"
echo   [i] Active repository root: %CD%

rem Toolchain checks
if exist "%ProgramFiles%\Git\cmd\git.exe" set "PATH=%PATH%;%ProgramFiles%\Git\cmd"
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

where git >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [x] ERROR: Git is missing from PATH. Run setup_windows.bat first.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo   [x] ERROR: Node.js is missing from PATH. Run setup_windows.bat first.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
for /f "tokens=*" %%v in ('npm -v 2^>nul') do set "NPM_VER=%%v"
for /f "tokens=*" %%v in ('git --version 2^>nul') do set "GIT_VER=%%v"
echo   [√] Toolchain ready: Node %NODE_VER% · npm v%NPM_VER% · %GIT_VER%
echo.

rem ------------------------------------------------------------------------------
rem STEP 2: GitHub Synchronization
rem ------------------------------------------------------------------------------
echo [STEP 2/4] GitHub Source Synchronization
echo ────────────────────────────────────────────────────────────────

if "%SKIP_PULL%"=="1" (
    echo   [i] Skipping GitHub sync (--skip-pull requested).
) else if exist ".git" (
    set "CURRENT_BRANCH="
    for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURRENT_BRANCH=%%b"

    if defined CURRENT_BRANCH (
        if not "!CURRENT_BRANCH!"=="HEAD" (
            echo   [i] Pulling updates for branch '!CURRENT_BRANCH!'...
            git pull origin !CURRENT_BRANCH! 2>nul
            if errorlevel 1 (
                echo   [!] Branch-specific pull failed. Fetching from origin/main...
                git pull origin main
            )
        ) else (
            echo   [i] Detached HEAD state. Fetching origin commits...
            git fetch origin
        )
    ) else (
        git pull origin main
    )

    for /f "tokens=*" %%c in ('git log -1 --pretty^=format:"%%h — %%s (%%cd)" --date^=short 2^>nul') do (
        echo   [√] Source tree synchronized: %%c
    )
) else (
    echo   [!] Not a git repository. Skipping sync.
)
echo.

rem ------------------------------------------------------------------------------
rem STEP 3: Dependencies Verification
rem ------------------------------------------------------------------------------
echo [STEP 3/4] Dependency Check & Verification
echo ────────────────────────────────────────────────────────────────

if "%CLEAN_BUILD%"=="1" (
    echo   [i] Cleaning dist\ and node_modules\ (--clean)...
    if exist "dist\" rmdir /s /q dist
    if exist "node_modules\" rmdir /s /q node_modules
    echo   [i] Reinstalling dependencies...
    call npm install
) else if not exist "node_modules\" (
    echo   [i] node_modules missing. Installing dependencies...
    call npm install
) else (
    echo   [i] Verifying dependencies are up to date...
    call npm install --prefer-offline --no-audit
)

if errorlevel 1 (
    echo.
    echo   [x] ERROR: npm install failed.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b %errorlevel%
)
echo   [√] Dependencies verified.
echo.

rem ------------------------------------------------------------------------------
rem STEP 4: Production Build
rem ------------------------------------------------------------------------------
echo [STEP 4/4] Production Build (tsc && vite build)
echo ────────────────────────────────────────────────────────────────
echo   [i] Compiling TypeScript and bundling assets with Vite...
echo.

call npm run build
if errorlevel 1 (
    echo.
    echo   [x] ERROR: Build failed! Review compiler diagnostics above.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b %errorlevel%
)

if not exist "dist\index.html" (
    echo.
    echo   [x] ERROR: Build succeeded without errors, but dist\index.html was not generated.
    echo.
    if "%NON_INTERACTIVE%"=="0" pause
    exit /b 1
)

rem ------------------------------------------------------------------------------
rem Summary & Telemetry
rem ------------------------------------------------------------------------------
echo.
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                 PRODUCTION BUILD SUCCESSFUL                  │
echo   └──────────────────────────────────────────────────────────────┘
echo.
echo   Build Telemetry:
echo     • Destination:   dist\
echo     • Entrypoint:    dist\index.html
if exist "dist\version.json" (
    for /f "tokens=2 delims=:, " %%c in ('findstr /C:"\"commit\"" dist\version.json 2^>nul') do (
        echo     • Commit Stamp:  %%~c
    )
    for /f "tokens=2 delims=:, " %%t in ('findstr /C:"\"builtAt\"" dist\version.json 2^>nul') do (
        echo     • Build Time:    %%~t
    )
)
echo.
echo   Launch Game Server:
echo     Run: launch_preview.bat
echo     Serves the compiled distribution locally on http://localhost:4173
echo.

if "%NON_INTERACTIVE%"=="0" pause
exit /b 0
