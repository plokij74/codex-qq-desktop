param([Parameter(Mandatory=$true)][string]$Work,[Parameter(Mandatory=$true)][string]$Outside)
$ErrorActionPreference = 'Stop'
$checks = New-Object System.Collections.Generic.List[string]
function Check([string]$Name, [scriptblock]$Body) {
    try { & $Body; $checks.Add($Name + '=PASS') }
    catch { $checks.Add($Name + '=FAIL'); $checks.Add('detail=' + $_.Exception.Message) }
}
function Denied([scriptblock]$Body) {
    try { & $Body | Out-Null } catch {
        $e = $_.Exception
        while ($e) {
            if ($e -is [UnauthorizedAccessException]) { return }
            $e = $e.InnerException
        }
        throw
    }
    throw 'Unexpectedly allowed access'
}
Check 'provider-bootstrap' {
    [IO.Directory]::SetCurrentDirectory($Work)
    New-PSDrive -Name E3Workspace -PSProvider FileSystem -Root $Work -Scope Script | Out-Null
    Set-Location -LiteralPath 'E3Workspace:\'
    Set-Content -LiteralPath 'provider.txt' -Value 'inside'
    if ((Get-Content -LiteralPath 'provider.txt') -ne 'inside') { throw 'Content mismatch' }
}
Check 'native-nested-cwd' {
    New-Item -ItemType Directory -Path 'E3Workspace:\nested' | Out-Null
    Set-Location -LiteralPath 'E3Workspace:\nested'
    & "$env:SystemRoot\System32\cmd.exe" /d /c 'echo nested>native.txt'
    if ($LASTEXITCODE -ne 0) { throw 'Native command failed' }
    if ([IO.File]::ReadAllText(($Work + '\nested\native.txt')).Trim() -ne 'nested') { throw 'Native cwd mismatch' }
    Set-Location -LiteralPath 'E3Workspace:\'
}
Check 'provider-outside-read-denied' { Denied { Get-Content -LiteralPath $Outside } }
Check 'provider-outside-write-denied' { Denied { Set-Content -LiteralPath $Outside -Value 'changed' } }
Check 'dotnet-outside-read-denied' { Denied { [IO.File]::ReadAllText($Outside) } }
Check 'dotnet-outside-write-denied' { Denied { [IO.File]::WriteAllText($Outside, 'changed') } }
Check 'junction-provider-read-denied' { Denied { Get-Content -LiteralPath 'E3Workspace:\escape\canary.txt' } }
Check 'junction-provider-write-denied' { Denied { Set-Content -LiteralPath 'E3Workspace:\escape\canary.txt' -Value 'changed' } }
Check 'junction-dotnet-read-denied' { Denied { [IO.File]::ReadAllText(($Work + '\escape\canary.txt')) } }
Check 'junction-dotnet-write-denied' { Denied { [IO.File]::WriteAllText(($Work + '\escape\canary.txt'), 'changed') } }
[IO.File]::WriteAllLines(($Work + '\provider-results.txt'), $checks.ToArray())
if ($checks -match '=FAIL$') { exit 1 }
