<#
.SYNOPSIS
Exercises typed budgets that JSON cannot represent faithfully.
.PARAMETER RequestFile
Path to a UTF-8 text file containing the local normal-fixture endpoint.
.OUTPUTS
Fourteen JSON envelopes: twelve rejected budgets, then Decimal 1 page and item
controls. Rejection diagnostics go to stderr; only the controls issue GETs.
.EXAMPLE
$Base = Read-Host 'Paste the base URL printed by the running api.mjs'
Set-Content -LiteralPath ./endpoint.txt -Value "$Base/normal" -NoNewline
& ./Invoke-NumericProbe.ps1 -RequestFile ./endpoint.txt
#>
param([string]$RequestFile)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Get-BoundedPage.ps1"
$endpoint = Get-Content -Raw -LiteralPath $RequestFile
foreach ($value in @([double]::NaN, [double]::PositiveInfinity, [double]::NegativeInfinity,
        [decimal]::Parse('1.0000000000000000000000000001', [Globalization.CultureInfo]::InvariantCulture),
        [decimal]::Parse('2147483647.0000000001', [Globalization.CultureInfo]::InvariantCulture))) {
    foreach ($key in @('MaxPages', 'MaxItems')) {
        $arguments = @{ Endpoint = $endpoint; MaxPages = 10; MaxItems = 100 }
        $arguments[$key] = $value
        Get-BoundedPage @arguments | ConvertTo-Json -Depth 20 -Compress
    }
}
foreach ($value in @([DayOfWeek]::Monday, [decimal]1)) {
    foreach ($key in @('MaxPages', 'MaxItems')) {
        $arguments = @{ Endpoint = $endpoint; MaxPages = 10; MaxItems = 100 }
        $arguments[$key] = $value
        Get-BoundedPage @arguments | ConvertTo-Json -Depth 20 -Compress
    }
}
