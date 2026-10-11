@echo off
setlocal
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  echo PowerShell 7 is required. Install it and reopen your terminal. 1>&2
  exit /b 1
)
if exist "%~dp0scripts\windows\Stop-LocalWebGPT.ps1" (
  pwsh.exe -NoLogo -NoProfile -File "%~dp0scripts\windows\Stop-LocalWebGPT.ps1" %*
) else (
  pwsh.exe -NoLogo -NoProfile -File "%~dp0Stop-LocalWebGPT.ps1" %*
)
exit /b %errorlevel%
