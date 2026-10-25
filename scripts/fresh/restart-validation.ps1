param(
 [Parameter(Mandatory=$true)][string]$ReviewManifest,
 [ValidatePattern('^[a-z0-9-]+$')][string]$HistoryPrefix='reviewed-cumulative'
)
$ErrorActionPreference='Stop'
$testRoot='C:\Users\PC\.codex\worktrees\fresh-kollens\kolscan-bnb'
$nodeExe='C:\Program Files\nodejs\node.exe'
if([IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\') -ne $testRoot){throw 'Wrong local workspace'}

# Verify the exact effective database without exposing its connection string.
$envText=Get-Content -LiteralPath (Join-Path $testRoot '.env') -Raw
function Get-LocalSetting([string]$Name){
 $settingMatch=[regex]::Match($envText,'(?m)^\s*'+[regex]::Escape($Name)+'\s*=\s*(.*?)\s*$')
 if(!$settingMatch.Success){return $null}
 $settingValue=$settingMatch.Groups[1].Value.Trim()
 if($settingValue.Length -ge 2 -and (($settingValue.StartsWith('"') -and $settingValue.EndsWith('"')) -or ($settingValue.StartsWith("'") -and $settingValue.EndsWith("'")))){return $settingValue.Substring(1,$settingValue.Length-2)}
 return ($settingValue -replace '\s+#.*$','').Trim()
}
function Assert-LocalDatabase([string]$Connection){
 try{$databaseUri=[Uri]$Connection}catch{throw 'Invalid local database configuration'}
 if(!$databaseUri.IsAbsoluteUri -or $databaseUri.Scheme -notin @('postgres','postgresql') -or $databaseUri.Host -notin @('localhost','127.0.0.1') -or $databaseUri.Port -ne 5436 -or $databaseUri.AbsolutePath -ne '/kollens_fresh_20261022_24h'){throw 'Wrong local database; no processes changed'}
}
Assert-LocalDatabase (Get-LocalSetting 'DATABASE_URL')
if($env:DATABASE_URL){Assert-LocalDatabase $env:DATABASE_URL}
if((Get-LocalSetting 'FRESH_LOCAL_ONLY') -ne 'true' -or ($env:FRESH_LOCAL_ONLY -and $env:FRESH_LOCAL_ONLY -ne 'true')){throw 'Fresh local-only mode is required'}
foreach($configuredPort in @((Get-LocalSetting 'PORT'),$env:PORT)){if($configuredPort -and $configuredPort -ne '3302'){throw 'Wrong local API port'}}
$reviewFull=if([IO.Path]::IsPathRooted($ReviewManifest)){[IO.Path]::GetFullPath($ReviewManifest)}else{[IO.Path]::GetFullPath((Join-Path (Get-Location).Path $ReviewManifest))}
if(!$reviewFull.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $reviewFull -PathType Leaf)){throw 'Review manifest must be a saved file inside the Fresh workspace'}

$expected=@{trial='server/freshTrial.ts';api='server/index.ts';worker='server/worker.ts'}
$restartPath=Join-Path $testRoot '.cache/fresh/reviewed-restart.json'
$priorRestart=$null
if(Test-Path -LiteralPath $restartPath){$priorRestart=Get-Content -LiteralPath $restartPath -Raw | ConvertFrom-Json}
function Get-OwnedProcess([string]$Role){
 $pidPath=Join-Path $testRoot ".cache/fresh/$Role.pid"
 $taskPid=0
 if(!(Test-Path -LiteralPath $pidPath) -or ![int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(),[ref]$taskPid) -or $taskPid -le 0){throw "Invalid task-owned PID for $Role"}
 $taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskPid"
 if(!$taskProcess -or $taskProcess.Name -ne 'node.exe' -or !$taskProcess.CommandLine -or !$taskProcess.CommandLine.Contains('--env-file=.env') -or !$taskProcess.CommandLine.Contains($expected[$Role])){throw "Ownership mismatch for $Role"}
 if($priorRestart -and $priorRestart.processes -and $priorRestart.processes.$Role -and [int]$priorRestart.processes.$Role -ne $taskPid){throw "PID disagrees with reviewed ownership for $Role"}
 return $taskProcess
}
$owned=@{}
foreach($role in @('trial','api','worker')){$owned[$role]=Get-OwnedProcess $role}
$listener=Get-NetTCPConnection -LocalPort 3302 -State Listen -ErrorAction Stop
if(!$listener -or @($listener | Where-Object {$_.OwningProcess -ne $owned.api.ProcessId}).Count -gt 0){throw 'Local API listener ownership mismatch'}

function Invoke-ManifestReview([bool]$DryRun){
 $cliArguments=@('--env-file=.env','--import','tsx','server/freshTrialReview.ts','--review',$reviewFull)
 if($DryRun){$cliArguments+='--dry-run'}
 $cliOutput=@(& $nodeExe @cliArguments 2>&1)
 if($LASTEXITCODE -ne 0){throw 'Trial review was rejected; the API and capture worker remain running. Inspect the review manifest and CLI validation before retrying.'}
 try{$reviewResult=($cliOutput | Out-String) | ConvertFrom-Json}catch{throw 'Trial review did not return its expected JSON result; API and capture worker were not stopped'}
 foreach($required in @('beforeVerifiedSeconds','afterVerifiedSeconds','sourceDigest','segmentId','historyDirectory','dryRun')){if($null -eq $reviewResult.PSObject.Properties[$required]){throw "Trial review result is missing $required"}}
 if($reviewResult.sourceDigest -notmatch '^[a-f0-9]{64}$' -or !$reviewResult.segmentId -or [bool]$reviewResult.dryRun -ne $DryRun){throw 'Invalid reviewed trial identity'}
 if([double]$reviewResult.afterVerifiedSeconds -lt [double]$reviewResult.beforeVerifiedSeconds){throw 'Review unexpectedly reduced verified time; capture and API remain running'}
 return $reviewResult
}

# Reject an invalid manifest before disturbing even the monitor. The review CLI
# owns copying prior state/observations and preserving cumulative progress.
$null=Invoke-ManifestReview $true
$history=Join-Path $testRoot ('.cache/fresh/trial/history/'+$HistoryPrefix+'-'+(Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ssZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8))
$historyFull=[IO.Path]::GetFullPath($history)
if(!$historyFull.StartsWith($testRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'History path escaped workspace'}
New-Item -ItemType Directory -Path $historyFull | Out-Null
Copy-Item -LiteralPath $reviewFull -Destination (Join-Path $historyFull 'review-manifest.json')
foreach($priorReport in @('24h-reviewed-restart.json','reviewed-restart.json')){
 $priorPath=Join-Path $testRoot ('.cache/fresh/'+$priorReport)
 if(Test-Path -LiteralPath $priorPath){Copy-Item -LiteralPath $priorPath -Destination (Join-Path $historyFull $priorReport)}
}
$trialNow=Get-OwnedProcess 'trial'
if($trialNow.CreationDate -ne $owned.trial.CreationDate){throw 'Trial process ownership changed during review'}
Stop-Process -Id $trialNow.ProcessId
# Never move, delete, truncate or recreate trial/state.json or observations.jsonl.
$review=Invoke-ManifestReview $false
$review | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $historyFull 'review-result.json')

# Capture/API stay alive throughout review. The brief restart follows only an
# accepted manifest with all earned credit preserved.
foreach($role in @('worker','api')){
 $processNow=Get-OwnedProcess $role
 if($processNow.CreationDate -ne $owned[$role].CreationDate){throw "Ownership changed during review for $role"}
}
foreach($role in @('worker','api')){Stop-Process -Id $owned[$role].ProcessId}
foreach($role in @('api','worker','trial')){
 foreach($stream in @('stdout','stderr')){
  $log=Join-Path $testRoot ".cache/fresh/$role.$stream.log"
  if(Test-Path -LiteralPath $log){Copy-Item -LiteralPath $log -Destination (Join-Path $historyFull "$role.$stream.log")}
 }
}
$started=@{}
foreach($role in @('worker','api','trial')){
 if($role -eq 'trial'){
  $apiReady=$false
  for($attempt=0;$attempt -lt 20;$attempt++){
   try{$response=Invoke-WebRequest -Uri 'http://127.0.0.1:3302/api/leaderboard' -TimeoutSec 1;if($response.StatusCode -eq 200){$apiReady=$true;break}}catch{}
   Start-Sleep -Milliseconds 150
  }
  if(!$apiReady){throw 'Local API did not become ready; capture remains running, cumulative trial state is preserved'}
  foreach($startedRole in @('worker','api')){if(!(Get-Process -Id $started[$startedRole] -ErrorAction SilentlyContinue)){throw "New local $startedRole exited; cumulative trial state is preserved"}}
 }
 $child=Start-Process -FilePath $nodeExe -ArgumentList @('--env-file=.env','--import','tsx',$expected[$role]) -WorkingDirectory $testRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $testRoot ".cache/fresh/$role.stdout.log") -RedirectStandardError (Join-Path $testRoot ".cache/fresh/$role.stderr.log") -PassThru
 Set-Content -LiteralPath (Join-Path $testRoot ".cache/fresh/$role.pid") -Value $child.Id
 $started[$role]=$child.Id
}
$report=@{at=(Get-Date).ToUniversalTime().ToString('o');reviewManifest=$reviewFull;history=$historyFull;reviewHistory=$review.historyDirectory;processes=$started;
 database='kollens_fresh_20261022_24h';trackingBoundary=129180844;financialReset=$false;verifiedTimePreserved=$true;reviewedTimePreserved=$true;
 beforeVerifiedSeconds=[double]$review.beforeVerifiedSeconds;afterVerifiedSeconds=[double]$review.afterVerifiedSeconds;sourceDigest=$review.sourceDigest;segmentId=$review.segmentId}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $restartPath
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $historyFull 'completed-restart.json')
# The old guard exits on worker/trial replacement. Restart the existing guard
# separately with .cache/fresh/start-local-test-guard.ps1 when needed.
$report | ConvertTo-Json -Depth 8
