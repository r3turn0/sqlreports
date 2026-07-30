# Run the SQLReports generator from the current folder.
# Usage:
#   .\run-report.ps1
#   .\run-report.ps1 -Definitions "reports.json"
#   .\run-report.ps1 -Definitions "reports.json" -Output "KPIReport_20260730.xlsx"

param(
    [string]$Definitions = "reports.json",
    [string]$Output = ""
)

$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

if (-not (Test-Path "$here\node_modules")) {
    Write-Host "Installing dependencies..."
    npm install
}

$command = @('node', 'index.js', $Definitions)
if ($Output) { $command += $Output }

Write-Host "Running report generator..."
& $command
