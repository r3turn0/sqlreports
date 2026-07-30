@echo off
REM Run the SQLReports generator from the current folder.
REM Usage:
REM   run-report.bat
REM   run-report.bat reports.json
REM   run-report.bat reports.json KPIReport_20260730.xlsx

SETLOCAL
cd /d %~dp0

IF NOT EXIST node_modules (
  echo Installing dependencies...
  npm install
)

IF "%1"=="" (
  node index.js
) ELSE (
  IF "%2"=="" (
    node index.js %1
  ) ELSE (
    node index.js %1 %2
  )
)

ENDLOCAL
