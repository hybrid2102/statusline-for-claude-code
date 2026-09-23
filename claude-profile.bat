@echo off
REM Starts Claude Code on an alternative profile.
REM Double-click and type the name, or run:  claude-profile.bat work
REM "work" means the folder %USERPROFILE%\.claude-work
setlocal enabledelayedexpansion

set "NAME=%~1"
if not "%NAME%"=="" goto :have_name

echo Existing alternative profiles:
set "FOUND="
for /d %%D in ("%USERPROFILE%\.claude-*") do (
  set "FOLDER=%%~nxD"
  echo    !FOLDER:~8!
  set "FOUND=1"
)
if not defined FOUND echo    (none)
echo.
set /p "NAME=Profile name (e.g. work): "

:have_name
if "%NAME%"=="" (
  echo No name given.
  pause
  exit /b 1
)
REM the full folder name, ".claude-work", is accepted too
if /i "%NAME:~0,8%"==".claude-" set "NAME=%NAME:~8%"

set "CLAUDE_CONFIG_DIR=%USERPROFILE%\.claude-%NAME%"

REM A typo would otherwise start a brand-new empty profile, with no login and no status
REM line, without a word of warning.
if not exist "%CLAUDE_CONFIG_DIR%\" (
  echo.
  echo Profile "%NAME%" does not exist yet: it will be created from scratch.
  echo You will need to log in, and to run install.bat again for the status line.
  choice /c YN /m "Continue"
  if errorlevel 2 exit /b 1
)

echo.
echo Active profile: %CLAUDE_CONFIG_DIR%
echo.
claude
