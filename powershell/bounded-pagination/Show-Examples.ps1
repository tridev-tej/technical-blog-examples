<#
.SYNOPSIS
Prints complete, page-limited and repeated-token results from the local fixture.
.PARAMETER Base
Base URL printed by the running api.mjs, with no trailing slash.
.OUTPUTS
Three JSON lines in call order. The repeat-case diagnostic goes to stderr.
.EXAMPLE
$Base = Read-Host 'Paste the base URL printed by the running api.mjs'
& ./Show-Examples.ps1 -Base $Base
#>
param([string]$Base)

. "$PSScriptRoot/Get-BoundedPage.ps1"
Get-BoundedPage "$Base/normal" | ConvertTo-Json -Depth 20 -Compress
Get-BoundedPage "$Base/normal" -MaxPages 2 | ConvertTo-Json -Depth 20 -Compress
Get-BoundedPage "$Base/repeat" | ConvertTo-Json -Depth 20 -Compress
