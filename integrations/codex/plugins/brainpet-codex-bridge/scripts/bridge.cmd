@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "HELPER="

if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "HELPER=%SCRIPT_DIR%..\bin\windows-arm64\brainpet-hook.exe"
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "HELPER=%SCRIPT_DIR%..\bin\windows-x64\brainpet-hook.exe"
if defined PROCESSOR_ARCHITEW6432 if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "HELPER=%SCRIPT_DIR%..\bin\windows-arm64\brainpet-hook.exe"
if defined PROCESSOR_ARCHITEW6432 if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "HELPER=%SCRIPT_DIR%..\bin\windows-x64\brainpet-hook.exe"

if defined HELPER if exist "%HELPER%" (
  "%HELPER%" --agent codex
  exit /b 0
)

rem Published and local Bridge launchers fail open when the native helper is
rem unavailable. They never fall back to Node/npm on an end-user machine.
exit /b 0
