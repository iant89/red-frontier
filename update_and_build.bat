@echo off
setlocal enabledelayedexpansion

rem ==============================================================================
rem Red Frontier - Pull Latest Source & Build Game (Windows 11)
rem
rem This script:
rem   1. Pulls the latest commits from GitHub
rem   2. Verifies and updates npm dependencies
rem   3. Builds the production bundle (tsc && vite build)
rem ==============================================================================

title Red Frontier - Update and Build

echo ==========================================================
echo       Red Frontier - Pull Latest Source & Build
echo ==========================================================
echo.

rem ------------------------------------------------------------------------------
rem 1. Resolve Repository Root
rem ------------------------------------------------------------------------------
set "REPO_ROOT="
if exist "%~dp0package.json" (
    set "REPO_ROOT=%~dp0"
) else if exist "%~dp0..\package.json" (
    set "REPO_ROOT=%~dp0.."
) else if exist "package.json" (
    set "REPO_ROOT=%CD%"
)

if not defined REPO_ROOT (
    echo [ERROR] Cannot locate Red Frontier repository root (package.json not found).
    pause
    exit /b 1
)

cd /d "%REPO_ROOT%"
echo [INFO] Working directory: %CD%

rem ------------------------------------------------------------------------------
rem 2. Verify Prerequisites
rem ------------------------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin"
    )
)

where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git is not installed or not in PATH. Please run setup_windows.bat first.
    pause
    exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
    )
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js/npm is not installed or not in PATH. Please run setup_windows.bat first.
    pause
    exit /b 1
)

rem ------------------------------------------------------------------------------
rem 3. Pull Latest Source from GitHub
rem ------------------------------------------------------------------------------
if exist ".git" (
    echo [INFO] Pulling latest source from GitHub...
    for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CURRENT_BRANCH=%%b"
    
    if defined CURRENT_BRANCH (
        if not "!CURRENT_BRANCH!"=="HEAD" (
            echo [INFO] Current branch: !CURRENT_BRANCH!
            git pull origin !CURRENT_BRANCH! 2>nul
            if errorlevel 1 (
                echo [INFO] Pulling from default origin/main...
                git pull origin main
            )
        ) else (
            echo [INFO] Detached HEAD. Fetching origin...
            git fetch origin
        )
    ) else (
        git pull origin main
    )

    for /f "tokens=*" %%c in ('git log -1 --pretty^=format:"%%h - %%s" 2^>nul') do (
        echo [OK] Latest commit: %%c
    )
) else (
    echo [INFO] Not a git repository, skipping pull.
)
echo.

rem ------------------------------------------------------------------------------
rem 4. Update Dependencies
rem ------------------------------------------------------------------------------
echo [INFO] Verifying project dependencies (npm install)...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install encountered an error.
    pause
    exit /b %errorlevel%
)
echo [OK] Dependencies are up to date.
echo.

rem ------------------------------------------------------------------------------
rem 5. Build the Game
rem ------------------------------------------------------------------------------
echo [INFO] Building Red Frontier (tsc && vite build)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed! Check the error output above.
    pause
    exit /b %errorlevel%
)

if not exist "dist\index.html" (
    echo.
    echo [ERROR] Build finished but dist\index.html was not generated.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo    [OK] Red Frontier built successfully!
echo ==========================================================
echo.
echo To launch the game preview server, run:
echo   launch_preview.bat
echo.
pause
