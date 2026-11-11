function Test-PageBudget {
    <#
    .SYNOPSIS
    Checks a budget without coercing its original numeric value.
    .PARAMETER Value
    Numeric integer from 1 through Int32.MaxValue. Null, Boolean, enum, string,
    fractional and non-finite values are rejected.
    .OUTPUTS
    System.Boolean. True when the value is an accepted budget.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    Test-PageBudget -Value ([decimal]1)
    #>
    param($Value)

    if ($null -eq $Value) { return $false }
    if ($Value.GetType().IsEnum) { return $false }
    $numericTypes = @('SByte', 'Byte', 'Int16', 'UInt16', 'Int32', 'UInt32',
        'Int64', 'UInt64', 'Single', 'Double', 'Decimal')
    if ([Type]::GetTypeCode($Value.GetType()).ToString() -notin $numericTypes) {
        return $false
    }
    $number = [double]$Value
    if (-not [double]::IsFinite($number)) { return $false }
    return $Value -ge 1 -and $Value -le [int]::MaxValue -and
        $Value -eq [math]::Truncate($number)
}

function Get-PageEndpoint {
    <#
    .SYNOPSIS
    Validates the fixed destination before any request.
    .PARAMETER Endpoint
    Absolute HTTP loopback URL with no user information, query or fragment.
    .OUTPUTS
    System.String. The absolute URL. Invalid input throws.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    Get-PageEndpoint -Endpoint 'http://127.0.0.1:54321/normal'
    #>
    param($Endpoint)

    if ($Endpoint -isnot [string]) { throw 'Endpoint must be a URL string.' }
    $uri = $null
    if (-not [uri]::TryCreate($Endpoint, [UriKind]::Absolute, [ref]$uri)) {
        throw 'Endpoint must be absolute.'
    }
    if ($uri.Scheme -cne 'http' -or -not $uri.IsLoopback) {
        throw 'Use an HTTP loopback endpoint.'
    }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'Endpoint must not contain user information, query or fragment.'
    }
    return $uri.AbsoluteUri
}

function Test-PageItem {
    <#
    .SYNOPSIS
    Checks that a deserialized record has an integer id.
    .PARAMETER Item
    PSCustomObject whose id must be Int32 or Int64. Other properties are retained.
    .OUTPUTS
    System.Boolean. True when the record has the required shape.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    Test-PageItem -Item ([pscustomobject]@{ id = [int]1; label = 'kept' })
    #>
    param($Item)

    if ($Item -isnot [pscustomobject]) { return $false }
    return $Item.id -is [long] -or $Item.id -is [int]
}

function Assert-PageShape {
    <#
    .SYNOPSIS
    Validates every record and the continuation before a page changes state.
    .PARAMETER Page
    PSCustomObject with array items and a required nextToken: null or an ASCII
    token matching \A[A-Za-z0-9_-]{1,64}\z. Empty arrays may have a continuation.
    .OUTPUTS
    No output on success. Invalid pages throw.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $page = [pscustomobject]@{
        items = @([pscustomobject]@{ id = [int]1 })
        nextToken = $null
    }
    Assert-PageShape -Page $page
    #>
    param($Page)

    if ($Page -isnot [pscustomobject]) { throw 'Page must be an object.' }
    if ($null -eq $Page.PSObject.Properties['items']) { throw 'Missing items.' }
    if ($Page.items -isnot [array]) { throw 'items must be an array.' }
    foreach ($item in $Page.items) {
        if (-not (Test-PageItem $item)) { throw 'Each item needs an integer id.' }
    }
    if ($null -eq $Page.PSObject.Properties['nextToken']) { throw 'Missing nextToken.' }
    if ($null -eq $Page.nextToken) { return }
    if ($Page.nextToken -isnot [string]) { throw 'nextToken must be a string or null.' }
    if ($Page.nextToken -cnotmatch '\A[A-Za-z0-9_-]{1,64}\z') {
        throw 'Invalid continuation token.'
    }
}

function Read-LabPage {
    <#
    .SYNOPSIS
    Fetches and validates one page without retries or redirects.
    .PARAMETER Endpoint
    Fixed URL already validated by Get-PageEndpoint.
    .PARAMETER Cursor
    Empty string for the first page; otherwise a validated continuation token.
    The token is encoded as a cursor query value.
    .OUTPUTS
    PSCustomObject. A validated page. HTTP, decoding or schema failures throw.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $Base = Read-Host 'Paste the base URL printed by the running api.mjs'
    Read-LabPage -Endpoint "$Base/normal" -Cursor ''
    #>
    param([string]$Endpoint, [string]$Cursor)

    $url = $Endpoint
    if ($Cursor.Length -gt 0) {
        $url += '?cursor=' + [uri]::EscapeDataString($Cursor)
    }
    $settings = @{
        Uri = $url
        Method = 'Get'
        MaximumRetryCount = 0
        MaximumRedirection = 0
        NoProxy = $true
        ConnectionTimeoutSeconds = 2
        OperationTimeoutSeconds = 2
        ErrorAction = 'Stop'
    }
    $page = Invoke-RestMethod @settings
    Assert-PageShape $page
    return $page
}

function Set-PageStop {
    <#
    .SYNOPSIS
    Records the stop state and signals the caller to leave the loop.
    .PARAMETER State
    Per-call mutable hashtable whose Status and StopReason will be replaced.
    .PARAMETER Status
    Complete, Partial or Error, chosen by the caller's stop condition.
    .PARAMETER Reason
    EndOfData, PageBudget, ItemBudget, RepeatedToken, ReadFailed or InvalidArgument.
    .OUTPUTS
    System.Boolean. Always false; the supplied state is also updated.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $state = @{ Status = ''; StopReason = '' }
    Set-PageStop -State $state -Status 'Partial' -Reason 'PageBudget'
    $state
    #>
    param($State, [string]$Status, [string]$Reason)

    $State.Status = $Status
    $State.StopReason = $Reason
    return $false
}

function Test-RepeatedContinuation {
    <#
    .SYNOPSIS
    Checks whether a page points to an already requested cursor.
    .PARAMETER Page
    Validated page with a nextToken property. Null is terminal, not repeated.
    .PARAMETER Seen
    HashSet of requested cursors using StringComparer.Ordinal for case sensitivity.
    .OUTPUTS
    System.Boolean. True when the non-null continuation is in Seen.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $null = $seen.Add('A')
    Test-RepeatedContinuation -Page ([pscustomobject]@{ nextToken = 'A' }) -Seen $seen
    #>
    param($Page, $Seen)

    return $null -ne $Page.nextToken -and $Seen.Contains($Page.nextToken)
}

function Invoke-PageStep {
    <#
    .SYNOPSIS
    Attempts one bounded page step and updates this read's state.
    .PARAMETER State
    Per-call hashtable with Items list, Seen ordinal set, Cursor, counters,
    Status and StopReason. Registering the cursor precedes the GET.
    .PARAMETER Endpoint
    Fixed URL already validated by Get-PageEndpoint.
    .PARAMETER MaxPages
    Validated positive Int32-valued attempt limit. Checked after the item limit.
    .PARAMETER MaxItems
    Validated positive Int32-valued retained-record limit. A cyclic page is rejected
    before its records are appended; omitted records force ItemBudget.
    .OUTPUTS
    System.Boolean. True to continue; false when State contains the stop result.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $Base = Read-Host 'Paste the base URL printed by the running api.mjs'
    $state = @{
        Items = [Collections.Generic.List[object]]::new()
        Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        Cursor = ''; RequestsAttempted = 0; ItemsFetched = [long]0
        Status = 'Error'; StopReason = 'InvalidArgument'
    }
    while (Invoke-PageStep -State $state -Endpoint "$Base/normal" -MaxPages 2 -MaxItems 100) {}
    New-PageResult -State $state
    #>
    param($State, [string]$Endpoint, [int]$MaxPages, [int]$MaxItems)

    if ($State.Items.Count -ge $MaxItems) {
        return Set-PageStop $State 'Partial' 'ItemBudget'
    }
    if ($State.RequestsAttempted -ge $MaxPages) {
        return Set-PageStop $State 'Partial' 'PageBudget'
    }
    if (-not $State.Seen.Add($State.Cursor)) {
        return Set-PageStop $State 'Error' 'RepeatedToken'
    }
    $State.RequestsAttempted++
    try { $page = Read-LabPage $Endpoint $State.Cursor }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        return Set-PageStop $State 'Error' 'ReadFailed'
    }
    $State.ItemsFetched += $page.items.Count
    if (Test-RepeatedContinuation $page $state.Seen) {
        [Console]::Error.WriteLine('Continuation refers to an already requested cursor.')
        return Set-PageStop $State 'Error' 'RepeatedToken'
    }
    $take = [math]::Min($page.items.Count, $MaxItems - $State.Items.Count)
    for ($index = 0; $index -lt $take; $index++) {
        $State.Items.Add($page.items[$index])
    }
    if ($take -lt $page.items.Count) {
        return Set-PageStop $State 'Partial' 'ItemBudget'
    }
    if ($null -eq $page.nextToken) {
        return Set-PageStop $State 'Complete' 'EndOfData'
    }
    $State.Cursor = $page.nextToken
    return $true
}

function New-PageResult {
    <#
    .SYNOPSIS
    Builds the caller's envelope from the retained records and stop state.
    .PARAMETER State
    Per-call hashtable with Items list, RequestsAttempted, ItemsFetched, Status
    and StopReason. ItemsReturned is derived from the list count.
    .OUTPUTS
    PSCustomObject. Seven fields, with Items always an array. IsComplete is true
    only for the Complete state selected on EndOfData by the reader.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $state = @{
        Items = [Collections.Generic.List[object]]::new()
        RequestsAttempted = 0; ItemsFetched = [long]0
        Status = 'Error'; StopReason = 'InvalidArgument'
    }
    New-PageResult -State $state | ConvertTo-Json -Depth 20 -Compress
    #>
    param($State)

    return [pscustomobject]@{
        Items = [object[]]$State.Items.ToArray()
        RequestsAttempted = $State.RequestsAttempted
        ItemsFetched = $State.ItemsFetched
        ItemsReturned = $State.Items.Count
        Status = $State.Status
        StopReason = $State.StopReason
        IsComplete = $State.Status -ceq 'Complete'
    }
}

function Get-BoundedPage {
    <#
    .SYNOPSIS
    Reads local pages with explicit request, record and completion limits.
    .PARAMETER Endpoint
    Absolute HTTP loopback URL without user information, query or fragment.
    Response tokens cannot change this destination.
    .PARAMETER MaxPages
    Numeric integer from 1 through Int32.MaxValue; defaults to 10. Includes failed
    GET attempts. Invalid types or values return InvalidArgument before HTTP.
    .PARAMETER MaxItems
    Numeric integer from 1 through Int32.MaxValue; defaults to 100. Bounds retained
    records, not response bytes or deserialization memory. ItemBudget wins when
    both budgets are exhausted on a nonterminal page.
    .OUTPUTS
    PSCustomObject. Items, RequestsAttempted, ItemsFetched, ItemsReturned, Status,
    StopReason and IsComplete. Errors retain earlier accepted records and write
    diagnostics to stderr. A zero process exit does not establish completeness.
    .EXAMPLE
    . ./Get-BoundedPage.ps1
    $Base = Read-Host 'Paste the base URL printed by the running api.mjs'
    Get-BoundedPage -Endpoint "$Base/normal" -MaxPages 2 | ConvertTo-Json -Depth 20 -Compress
    #>
    param($Endpoint, $MaxPages = 10, $MaxItems = 100)

    $state = @{
        Items = [Collections.Generic.List[object]]::new()
        Seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        Cursor = ''
        RequestsAttempted = 0
        ItemsFetched = [long]0
        Status = 'Error'
        StopReason = 'InvalidArgument'
    }
    try {
        if (-not (Test-PageBudget $MaxPages)) { throw 'MaxPages must be a positive Int32-valued number.' }
        if (-not (Test-PageBudget $MaxItems)) { throw 'MaxItems must be a positive Int32-valued number.' }
        $endpointUrl = Get-PageEndpoint $Endpoint
    }
    catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        return New-PageResult $state
    }
    while (Invoke-PageStep $state $endpointUrl $MaxPages $MaxItems) {}
    return New-PageResult $state
}
