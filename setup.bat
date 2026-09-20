@echo off
setlocal enabledelayedexpansion

rem ==============================================================================
rem Red Frontier - Windows 11 Setup Script
rem
rem This script:
rem   1. Checks and installs system dependencies (Git, Node.js LTS, npm)
rem   2. Clones / downloads the Red Frontier repository if not already present
rem   3. Installs all project dependencies via npm
rem ==============================================================================

title Red Frontier - Windows 11 Setup

echo ==========================================================
echo           Red Frontier - Windows 11 Setup
echo ==========================================================
echo.

rem ------------------------------------------------------------------------------
rem 1. Check & Install Git
rem ------------------------------------------------------------------------------
echo [INFO] Checking for Git...

where git >nul 2>nul
if errorlevel 1 (
    rem Check common Git default install paths before attempting install
    if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin"
    ) else if exist "%LocalAppData%\Programs\Git\cmd\git.exe" (
        set "PATH=%PATH%;%LocalAppData%\Programs\Git\cmd;%LocalAppData%\Programs\Git\bin"
    )
)

where git >nul 2>nul
if errorlevel 1 (
    echo [INFO] Git is not installed. Attempting installation...
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo [INFO] Installing Git for Windows via winget...
        winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    ) else (
        echo [INFO] winget not detected. Downloading Git installer via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = 'https://github.com/git-for-windows/git/releases/latest/download/Git-64-bit.exe'; $out = Join-Path $env:TEMP 'git-setup.exe'; Write-Host 'Downloading Git...'; (New-Object Net.WebClient).DownloadFile($url, $out); Write-Host 'Running installer...'; Start-Process $out -ArgumentList '/VERYSILENT','/NORESTART' -Wait"
    )

    rem Refresh PATH for Git in the active session
    if exist "%ProgramFiles%\Git\cmd\git.exe" (
        set "PATH=%PATH%;%ProgramFiles%\Git\cmd;%ProgramFiles%\Git\bin"
    ) else if exist "%LocalAppData%\Programs\Git\cmd\git.exe" (
        set "PATH=%PATH%;%LocalAppData%\Programs\Git\cmd;%LocalAppData%\Programs\Git\bin"
    )

    where git >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Git installation could not be completed automatically.
        echo Please download and install Git manually from: https://git-scm.com/download/win
        pause
        exit /b 1
    )
    echo [OK] Git installed successfully.
) else (
    for /f "tokens=*" %%v in ('git --version 2^>nul') do echo [OK] Git is already installed: %%v
)
echo.

rem ------------------------------------------------------------------------------
rem 2. Check & Install Node.js and npm (requires Node >= 18)
rem ------------------------------------------------------------------------------
echo [INFO] Checking for Node.js and npm...

where node >nul 2>nul
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
    )
)

set "NEED_NODE_INSTALL=0"
where node >nul 2>nul
if errorlevel 1 (
    set "NEED_NODE_INSTALL=1"
) else (
    rem Check if Node major version is >= 18
    for /f "tokens=*" %%v in ('node -e "const [m] = process.versions.node.split('.'); console.log(parseInt(m) >= 18 ? 'OK' : 'OLD')" 2^>nul') do (
        if "%%v"=="OLD" set "NEED_NODE_INSTALL=1"
    )
)

if "%NEED_NODE_INSTALL%"=="1" (
    echo [INFO] Node.js is missing or below required version 18. Installing Node.js LTS...
    where winget >nul 2>nul
    if not errorlevel 1 (
        echo [INFO] Installing Node.js LTS via winget...
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    ) else (
        echo [INFO] Downloading Node.js LTS installer via PowerShell...
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $url = 'https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'; $out = Join-Path $env:TEMP 'nodejs-setup.msi'; Write-Host 'Downloading Node.js...'; (New-Object Net.WebClient).DownloadFile($url, $out); Write-Host 'Running installer...'; Start-Process msiexec.exe -ArgumentList '/i', $out, '/passive', '/norestart' -Wait"
    )

    rem Refresh PATH for Node in current session
    if exist "%ProgramFiles%\nodejs\node.exe" (
        set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
    )

    where node >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] Node.js installation could not be completed automatically.
        echo Please download and install Node.js LTS manually from: https://nodejs.org/
        pause
        exit /b 1
    )
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do echo [OK] Node.js is ready: %%v
for /f "tokens=*" %%v in ('npm -v 2^>nul') do echo [OK] npm is ready: v%%v
echo.

rem ------------------------------------------------------------------------------
rem 3. Locate or Clone Repository
rem ------------------------------------------------------------------------------
echo [INFO] Locating Red Frontier repository...

set "IN_REPO=0"
if exist "package.json" (
    findstr /C:"\"name\": \"red-frontier\"" package.json >nul 2>nul
    if not errorlevel 1 set "IN_REPO=1"
)

if "%IN_REPO%"=="1" (
    echo [OK] Current directory is the Red Frontier repository: %CD%
) else if exist "%~dp0package.json" (
    cd /d "%~dp0"
    echo [OK] Entered repository at: %CD%
) else if exist "%~dp0..\package.json" (
    cd /d "%~dp0.."
    echo [OK] Entered repository at: %CD%
) else if exist "red-frontier\package.json" (
    cd red-frontier
    echo [OK] Entered existing red-frontier folder: %CD%
) else (
    echo [INFO] Downloading Red Frontier from https://github.com/iant89/red-frontier.git...
    git clone https://github.com/iant89/red-frontier.git red-frontier
    if errorlevel 1 (
        echo [ERROR] Failed to clone the repository. Please check your internet connection.
        pause
        exit /b 1
    )
    cd red-frontier
    echo [OK] Successfully cloned and entered repository: %CD%
)
echo.

rem ------------------------------------------------------------------------------
rem 4. Install Project Dependencies
rem ------------------------------------------------------------------------------
echo [INFO] Installing project dependencies via npm...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install encountered an error.
    pause
    exit /b %errorlevel%
)
echo [OK] Project dependencies installed successfully.
echo.

rem ------------------------------------------------------------------------------
rem 5. Done
rem ------------------------------------------------------------------------------
echo ==========================================================
echo    Red Frontier setup completed successfully!
echo ==========================================================
echo.
echo Next steps:
echo   1. Pull latest source and build the game:
echo      update_and_build.bat
echo.
echo   2. Launch local preview server:
echo      launch_preview.bat
echo.
pause
