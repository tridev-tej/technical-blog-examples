# Bounded pagination in PowerShell

This local lab reads a five-record API and shows when pagination finishes, reaches a limit, or fails. You'll need PowerShell 7.6 and [Node.js from the official installer](https://nodejs.org/en/download). It uses built-in Node modules and needs no credentials.

Inspect the six files before running them. Save them together in a new `bounded-pagination-example` folder, preserving the filenames.

| File | Role |
| --- | --- |
| [api.mjs](./api.mjs) | Local API with normal and broken pagination cases |
| [Get-BoundedPage.ps1](./Get-BoundedPage.ps1) | Bounded reader and its helper functions |
| [Show-Examples.ps1](./Show-Examples.ps1) | Shows complete, limited and repeated-token reads |
| [Invoke-Case.ps1](./Invoke-Case.ps1) | Runs reader requests for the verifier |
| [Invoke-NumericProbe.ps1](./Invoke-NumericProbe.ps1) | Checks typed numeric budgets for the verifier |
| [verify.mjs](./verify.mjs) | Verifies results and request counts |

In a PowerShell terminal, create the folder, then save the files into it:

```powershell
New-Item -ItemType Directory -Path ./bounded-pagination-example
Set-Location ./bounded-pagination-example
```

Start the API in that terminal:

```powershell
node ./api.mjs
```

Leave it running. Open the same folder in a second PowerShell terminal, then paste the base URL printed by the first terminal:

```powershell
$Base = Read-Host 'Paste the base URL printed by api.mjs'
& ./Show-Examples.ps1 -Base $Base
```

The script prints complete, page-limited and repeated-token results. The repeated-token run also writes a separate error message.

Dot-source the reader to explore its functions and built-in help:

```powershell
. ./Get-BoundedPage.ps1
Get-Help Get-BoundedPage -Full
Get-Help Read-LabPage -Examples
```

Run the verifier from the second terminal. It starts and stops its own API listeners:

```powershell
$env:PWSH = (Get-Process -Id $PID).Path
node ./verify.mjs > ./results.jsonl
$LASTEXITCODE
Get-Content -LiteralPath ./results.jsonl -Tail 1
```

Expected exit code: `0`. Expected final line: `{"kind":"summary","cases":65,"passed":true}`.

Earlier runs used PowerShell 7.6.9 and Node.js 26.3.0 on macOS and Ubuntu. Windows has not been tested.

Press Ctrl+C in the first terminal to stop the API when you're done.

Covered by the repository's [MIT license](../../LICENSE).
