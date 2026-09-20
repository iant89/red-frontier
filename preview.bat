@echo off
setlocal enabledelayedexpansion

rem ==============================================================================
rem Red Frontier - Launch Preview Server (Windows 11)
rem
rem This script:
rem   1. Verifies that the production build exists (builds if missing)
rem   2. Opens the default browser to http://localhost:4173/
rem   3. Starts the Vite preview web server on port 4173
rem ==============================================================================

title Red Frontier - Preview Server

echo ==========================================================
echo          Red Frontier - Preview Server
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
    echo [ERROR] Cannot locate Red Frontier repository root.
    pause
    exit /b 1
)

cd /d "%REPO_ROOT%"

rem ------------------------------------------------------------------------------
rem 2. Verify Prerequisites
rem ------------------------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
    )
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js/npm is not found. Please run setup_windows.bat first.
    pause
    exit /b 1
)

rem ------------------------------------------------------------------------------
rem 3. Ensure Build Exists
rem ------------------------------------------------------------------------------
if not exist "node_modules\" (
    echo [INFO] Dependencies missing. Running npm install...
    call npm install
)

if not exist "dist\index.html" (
    echo [INFO] Production build not found. Building Red Frontier first...
    call npm run build
    if errorlevel 1 (
        echo [ERROR] Build failed. Unable to launch preview server.
        pause
        exit /b %errorlevel%
    )
)

rem ------------------------------------------------------------------------------
rem 4. Launch Browser & Start Server
rem ------------------------------------------------------------------------------
set "PORT=4173"
set "HOST=0.0.0.0"

echo.
echo ==========================================================
echo   Server URL:  http://localhost:%PORT%/
echo   Network URL: http://%HOST%:%PORT%/
echo ==========================================================
echo.
echo Opening default web browser...
start http://localhost:%PORT%/

echo Starting Vite preview server...
echo Press Ctrl+C in this window to stop the server.
echo.

call npm run preview -- --host %HOST% --port %PORT%
pause
