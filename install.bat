@echo off
REM Double-click to install or update the Claude Code status line.
REM Needs statusline.mjs and install.ps1 in this same folder.
setlocal
set "PS=powershell"
where pwsh >nul 2>nul && set "PS=pwsh"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "CODE=%ERRORLEVEL%"
echo.
pause
exit /b %CODE%
