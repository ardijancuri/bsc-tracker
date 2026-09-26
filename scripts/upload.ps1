param([Parameter(Mandatory=$true)][string]$Archive)

$ErrorActionPreference = 'Stop'
$server = '65.21.69.43'
$expectedFingerprint = 'QjaZ1AxoNaKCXM3m3dc79YSJ8nrHED6Tw8pKv5qPL0w'
$toolDir = 'C:\Program Files\Git\usr\bin'
$scanTool = Join-Path $toolDir 'ssh-keyscan.exe'
$scpTool = Join-Path $toolDir 'scp.exe'
if (-not (Test-Path $scanTool)) { $scanTool = 'ssh-keyscan.exe' }
if (-not (Test-Path $scpTool)) { $scpTool = 'scp.exe' }
$key = @(& $scanTool -T 8 -t ed25519 $server 2>$null | Where-Object { $_ -match '^\S+\s+ssh-ed25519\s+\S+' })
if ($LASTEXITCODE -ne 0 -or $key.Count -ne 1) { throw 'Could not retrieve exactly one ED25519 host key.' }
$encoded = ($key[0] -split '\s+')[2]
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $actual = [Convert]::ToBase64String($sha.ComputeHash([Convert]::FromBase64String($encoded))).TrimEnd('=') }
finally { $sha.Dispose() }
if ($actual -cne $expectedFingerprint) { throw 'VPS host fingerprint mismatch. Upload aborted.' }
$knownHosts = Join-Path ([System.IO.Path]::GetTempPath()) ("bscan-" + [guid]::NewGuid().ToString('N') + '.known_hosts')
try {
  Set-Content -LiteralPath $knownHosts -Value $key[0] -Encoding ascii
  & $scpTool -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$knownHosts" -o HostKeyAlgorithms=ssh-ed25519 -o UpdateHostKeys=no -o BatchMode=yes -i "$env:USERPROFILE\.ssh\codex_hams_vps" -o IdentitiesOnly=yes -o ConnectTimeout=10 $Archive "root@${server}:/opt/bscan/release.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "SCP exited with code $LASTEXITCODE" }
} finally { Remove-Item -LiteralPath $knownHosts -ErrorAction SilentlyContinue }
