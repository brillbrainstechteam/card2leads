$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = "C:\Users\PRERNA\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$out = Join-Path $root "server-runtime.out.log"
$err = Join-Path $root "server-runtime.err.log"

Set-Location $root

while ($true) {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $out -Value "[$timestamp] Starting EasySave server"
  & $node "server.js" 1>> $out 2>> $err
  $code = $LASTEXITCODE
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $err -Value "[$timestamp] EasySave server exited with code $code. Restarting in 3 seconds."
  Start-Sleep -Seconds 3
}
