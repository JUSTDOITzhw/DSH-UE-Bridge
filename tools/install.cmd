@echo off
rem dsh-ue-bridge installer — double-click this, or run it from a terminal.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 18+ is required but was not found on PATH.
  echo   Install it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 127
)

node "%~dp0install.mjs" %*
set CODE=%ERRORLEVEL%

echo.
if not "%CODE%"=="0" (
  echo   [install failed — exit %CODE%]
) else (
  echo   [done]
)
pause
exit /b %CODE%
