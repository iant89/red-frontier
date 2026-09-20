@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem ==============================================================================
rem  RED FRONTIER — Local Game Preview Server (Windows 11)
rem
rem  Mars · 2066 — Real-Time Strategy · Survival · Automation
rem  Repository: https://github.com/iant89/red-frontier
rem ==============================================================================
rem  This script verifies the production distribution in dist\ (building it if
rem  missing), launches the default web browser to the game URL, and starts
rem  the Vite preview web server on port 4173.
rem ==============================================================================

chcp 65001 >nul 2>&1
title Red Frontier — Preview Server

rem ------------------------------------------------------------------------------
rem Configuration & Arguments
rem ------------------------------------------------------------------------------
set "PORT=4173"
set "HOST=0.0.0.0"
set "AUTO_OPEN=1"
set "FORCE_BUILD=0"
set "SHOW_HELP=0"

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="/p" (
    set "PORT=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--port" (
    set "PORT=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="/h" (
    set "HOST=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="--host" (
    set "HOST=%~2"
    shift
    shift
    goto :parse_args
)
if /i "%~1"=="/build" (
    set "FORCE_BUILD=1"
    shift
    goto :parse_args
)
if /i "%~1"=="--build" (
    set "FORCE_BUILD=1"
    shift
    goto :parse_args
)
if /i "%~1"=="/no-open" (
    set "AUTO_OPEN=0"
    shift
    goto :parse_args
)
if /i "%~1"=="--no-open" (
    set "AUTO_OPEN=0"
    shift
    goto :parse_args
)
if /i "%~1"=="/help" set "SHOW_HELP=1"
if /i "%~1"=="/?" set "SHOW_HELP=1"
if /i "%~1"=="--help" set "SHOW_HELP=1"
shift
goto :parse_args

:args_done
if "%SHOW_HELP%"=="1" (
    echo.
    echo Red Frontier — Game Preview Server Utility
    echo.
    echo Usage:
    echo   launch_preview.bat [/port 4173] [/build] [/no-open] [/help]
    echo.
    echo Options:
    echo   /p, --port ^<number^>    Specify custom port (default: 4173)
    echo   /h, --host ^<address^>   Specify host interface (default: 0.0.0.0)
    echo   /build, --build        Recompile game before launching
    echo   /no-open, --no-open    Do not launch browser window
    echo   /?, --help             Display this documentation
    echo.
    exit /b 0
)

rem ------------------------------------------------------------------------------
rem Header Banner
rem ------------------------------------------------------------------------------
echo.
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                      R E D   F R O N T I E R                 │
echo   │               Local Game Preview Web Server                  │
echo   │          Ares Expeditionary Command · Mars RTS 2066          │
echo   └──────────────────────────────────────────────────────────────┘
echo.

rem ------------------------------------------------------------------------------
rem Workspace Resolution & Toolchain
rem ------------------------------------------------------------------------------
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
    echo   [x] ERROR: Cannot locate Red Frontier repository root.
    echo.
    pause
    exit /b 1
)

cd /d "%REPO_ROOT%"

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"

where node >nul 2>&1
if errorlevel 1 (
    echo   [x] ERROR: Node.js is missing from PATH. Run setup_windows.bat first.
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo   [x] ERROR: npm is missing from PATH. Run setup_windows.bat first.
    pause
    exit /b 1
)

rem ------------------------------------------------------------------------------
rem Ensure Build Exists
rem ------------------------------------------------------------------------------
if not exist "node_modules\" (
    echo   [!] node_modules missing. Installing dependencies...
    call npm install
)

if "%FORCE_BUILD%"=="1" (
    echo   [i] Recompiling game (--build requested)...
    call npm run build
) else if not exist "dist\index.html" (
    echo   [!] Production build not found in dist\. Compiling game now...
    call npm run build
    if errorlevel 1 (
        echo   [x] ERROR: Build failed. Cannot launch server.
        pause
        exit /b %errorlevel%
    )
)

rem ------------------------------------------------------------------------------
rem Server Dashboard & Launch
rem ------------------------------------------------------------------------------
echo   ┌──────────────────────────────────────────────────────────────┐
echo   │                 RED FRONTIER IS READY TO PLAY                │
echo   └──────────────────────────────────────────────────────────────┘
echo.
echo   Access Endpoints:
echo     • Local Web:    http://localhost:%PORT%/
echo     • Network:      http://%HOST%:%PORT%/
echo.
echo   Controls:
echo     • Press Ctrl + C in this terminal window to stop the server.
echo.

if "%AUTO_OPEN%"=="1" (
    echo   [i] Launching default web browser...
    start http://localhost:%PORT%/
)

echo   [i] Starting Vite preview server on %HOST%:%PORT%...
echo ────────────────────────────────────────────────────────────────
echo.

call npm run preview -- --host %HOST% --port %PORT%
exit /b %errorlevel%
