@echo off
setlocal
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell 7 is required. Install it and reopen your terminal. 1>&2
  exit /b 1
)
pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\windows\Start-LocalWebGPT.ps1" %*
exit /b %errorlevel%
