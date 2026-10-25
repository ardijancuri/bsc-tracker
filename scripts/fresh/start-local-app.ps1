#requires -Version 7.4
param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
$taskRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$expectedRoot='C:\Users\PC\.codex\worktrees\fresh-kollens\kolscan-bnb'
if($taskRoot -ne $expectedRoot){throw 'This launcher only owns the isolated Fresh Kollens checkout'}
$nodeExe='C:\Program Files\nodejs\node.exe'
$pgBin='C:\Program Files\PostgreSQL\18\bin'
$pgData=Join-Path $taskRoot '.cache/fresh/pg'
$runtimeFile=Join-Path $taskRoot '.cache/fresh/local-app-runtime.json'
$runtime=Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
if($runtime.database -ne 'kollens_fresh_20261022_24h' -or $runtime.validationCancelled -ne $true){throw 'Unexpected local ownership record'}
if((Get-Content -LiteralPath (Join-Path $pgData 'PG_VERSION')).Trim() -ne '18'){throw 'The existing PostgreSQL18 data directory is required; no database is initialized'}
$stamp=[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
function Listener([int]$port){return @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)}
function Owned([int]$port,[string]$role,[string]$entry){
 if($port -eq 0){return $null}
 $sockets=Listener $port
 if(!$sockets.Count){return $null}
 $ids=@($sockets|Select-Object -ExpandProperty OwningProcess -Unique)
 if($ids.Count -ne 1){throw "Ambiguous local listener on $port"}
 $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($ids[0])"
 if(!$p -or [int]$runtime.processes.$role -ne $p.ProcessId -or !$p.CommandLine.Contains($entry)){throw "The listener on $port is not the recorded task-owned $role"}
 return $p.ProcessId
}
Push-Location -LiteralPath $taskRoot
try{
 & $nodeExe --env-file=.env --input-type=module -e 'const d=new URL(process.env.DATABASE_URL),r=new URL(process.env.BSC_RPC_HTTP);if(d.hostname!=="127.0.0.1"||d.port!=="5436"||d.pathname!=="/kollens_fresh_20261022_24h"||r.hostname!=="127.0.0.1"||r.port!=="18545"||process.env.FRESH_LOCAL_ONLY!=="true")throw Error("wrong_isolated_local_configuration");'
 if($LASTEXITCODE -ne 0){throw 'Local configuration guard failed'}
 if($CheckOnly){Write-Output 'Existing local paths/configuration verified. No services changed.';return}
 $pg=Listener 5436
 if($pg.Count){
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($pg[0].OwningProcess)"
  if(!$p -or $p.Name -ne 'postgres.exe' -or !$p.CommandLine.Replace('\','/').Contains($pgData.Replace('\','/'))){throw 'Port5436 is not the owned PostgreSQL data directory'}
 }else{
  & (Join-Path $pgBin 'pg_ctl.exe') start -D $pgData -l (Join-Path $taskRoot ".cache/fresh/postgres-$stamp.log") -o '-p 5436 -h 127.0.0.1 -c max_wal_size=256MB -c min_wal_size=80MB -c log_min_messages=warning' -w -t 30
  if($LASTEXITCODE -ne 0){throw 'Existing PostgreSQL data could not be started; no reset attempted'}
 }
 $tunnel=Listener 18545
 if(!$tunnel.Count){
  & 'C:\Users\PC\.codex\skills\vps-connect\scripts\connect.ps1' -CheckOnly
  if($LASTEXITCODE -ne 0){throw 'Pinned VPS host-key preflight failed'}
  $sshArgs=@('-N','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','ConnectTimeout=10','-o','ExitOnForwardFailure=yes','-o','StrictHostKeyChecking=yes','-o',"UserKnownHostsFile=$($taskRoot.Replace('\','/'))/.cache/fresh/known_hosts",'-o','HostKeyAlgorithms=ssh-ed25519','-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-i','C:/Users/PC/.ssh/codex_hams_vps','-L','127.0.0.1:18545:127.0.0.1:8545','-L','127.0.0.1:18546:127.0.0.1:8546','root@65.21.69.43')
  $p=Start-Process -FilePath 'C:\Program Files\Git\usr\bin\ssh.exe' -ArgumentList $sshArgs -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot ".cache/fresh/tunnel-$stamp.log") -RedirectStandardError (Join-Path $taskRoot ".cache/fresh/tunnel-$stamp.err.log") -PassThru
  $runtime.processes|Add-Member -NotePropertyName tunnel -NotePropertyValue $p.Id -Force
  Set-Content -LiteralPath (Join-Path $taskRoot '.cache/fresh/tunnel.pid') -Value $p.Id
 }else{
  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($tunnel[0].OwningProcess)"
  if(!$p -or $p.Name -ne 'ssh.exe' -or !$p.CommandLine.Contains('127.0.0.1:18545:127.0.0.1:8545') -or !$p.CommandLine.Contains('root@65.21.69.43')){throw 'Unrecognized process owns the node tunnel port'}
  $runtime.processes|Add-Member -NotePropertyName tunnel -NotePropertyValue $p.ProcessId -Force
 }
 function StartOwned([string]$role,[int]$port,[string[]]$arguments,[string]$entry){
  $owned=Owned $port $role $entry
  if($owned){return $owned}
  if($role -eq 'worker' -and $runtime.processes.worker){
   $old=Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$runtime.processes.worker)"
   if($old){if(!$old.CommandLine.Contains('server/worker.ts')){throw 'Recorded worker PID is now another process'};return $old.ProcessId}
  }
  $p=Start-Process -FilePath $nodeExe -ArgumentList $arguments -WorkingDirectory $taskRoot -WindowStyle Hidden -Environment @{TELEGRAM_BOT_TOKEN='';X_TOKEN_POSTS_ENABLED='false'} -RedirectStandardOutput (Join-Path $taskRoot ".cache/fresh/$role-$stamp.log") -RedirectStandardError (Join-Path $taskRoot ".cache/fresh/$role-$stamp.err.log") -PassThru
  $runtime.processes|Add-Member -NotePropertyName $role -NotePropertyValue $p.Id -Force
  $runtime|Add-Member -NotePropertyName ($role+'LogsStamp') -NotePropertyValue $stamp -Force
  return $p.Id
 }
 [void](StartOwned 'api' 3302 @('--env-file=.env','--import','tsx','server/index.ts') 'server/index.ts')
 # Complete API schema startup before starting collection. Never run a trial,
 # a wakefulness guard, a scheduled review or a database initializer here.
 $ready=$false
 for($attempt=0;$attempt -lt 60;$attempt++){
  try{$response=Invoke-RestMethod -Uri 'http://127.0.0.1:3302/api/health' -TimeoutSec 2;if($response.ok){$ready=$true;break}}catch{}
  Start-Sleep -Milliseconds 250
 }
 if(!$ready){throw 'The owned API did not become ready; inspect its local log'}
 [void](StartOwned 'worker' 0 @('--env-file=.env','--import','tsx','server/worker.ts') 'server/worker.ts')
 [void](StartOwned 'vite' 5173 @('node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5173','--strictPort') 'vite/bin/vite.js')
 $runtime|Add-Member -NotePropertyName ordinaryLauncherAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
 $runtime|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $runtimeFile
 Write-Output 'Ordinary Fresh local app restored: UI5173/API3302/PostgreSQL5436/node18545. Existing data preserved; no trial or real message transport started.'
}finally{Pop-Location}
