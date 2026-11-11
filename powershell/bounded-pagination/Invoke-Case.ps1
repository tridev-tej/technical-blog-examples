<#
.SYNOPSIS
Runs a JSON array of reader requests in one PowerShell process.
.PARAMETER RequestFile
Path to a UTF-8 JSON array of objects with Endpoint and optional MaxPages and
MaxItems. Each object is passed to Get-BoundedPage without a type-changing cast.
.OUTPUTS
One JSON envelope per request. Reader diagnostics go to stderr.
.EXAMPLE
$Base = Read-Host 'Paste the base URL printed by the running api.mjs'
@(@{ Endpoint = "$Base/normal"; MaxPages = 2 }) |
    ConvertTo-Json -Depth 10 -AsArray | Set-Content -LiteralPath ./requests.json
& ./Invoke-Case.ps1 -RequestFile ./requests.json
#>
param([string]$RequestFile)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Get-BoundedPage.ps1"
$requests = Get-Content -Raw -LiteralPath $RequestFile | ConvertFrom-Json -AsHashtable
foreach ($request in $requests) {
    Get-BoundedPage @request | ConvertTo-Json -Depth 20 -Compress
}
