param([Parameter(Mandatory)][string]$ReleaseDirectory)

$ErrorActionPreference = 'Stop'
$release = (Resolve-Path $ReleaseDirectory).Path
$installers = @(Get-ChildItem "$release/Canopy-*-windows-x64.exe" -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows installer' }
$scratch = Join-Path $env:GITHUB_WORKSPACE '.tmp/windows-desktop-smoke'
$installation = Join-Path $scratch 'installed'
New-Item $scratch -ItemType Directory -Force | Out-Null

function Invoke-SmokeProcess([string]$File, [string]$Arguments, [int]$Timeout = 120000) {
  $info = [System.Diagnostics.ProcessStartInfo]::new($File, $Arguments)
  $info.UseShellExecute = $false
  # Keep stdin open: desktop sidecars deliberately stop on EOF.
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  # Exercise NSIS's Windows PowerShell check rather than the tasklist fallback.
  $info.Environment['PSModulePath'] = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
  $info.Environment['PSExecutionPolicyPreference'] = 'Bypass'
  $process = [System.Diagnostics.Process]::Start($info)
  $stdout = $process.StandardOutput.ReadToEndAsync()
  $stderr = $process.StandardError.ReadToEndAsync()
  try {
    if (-not $process.WaitForExit($Timeout)) {
      $process.Kill($true)
      $process.WaitForExit()
      throw "Timed out: $File"
    }
    $output = $stdout.GetAwaiter().GetResult().Trim()
    $errors = $stderr.GetAwaiter().GetResult().Trim()
    if ($process.ExitCode -ne 0) { throw "$File exited $($process.ExitCode): $errors" }
    return $output
  } finally {
    $process.Dispose()
  }
}

function Test-SingleProcessUpdate([string]$Bun) {
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  Invoke-SmokeProcess $powershell '-NoProfile -NonInteractive -C "Get-Command Get-CimInstance -ErrorAction Stop | Out-Null; if ((Get-ExecutionPolicy -Scope Process) -eq ''Restricted'') { exit 1 }"'
  $info = [System.Diagnostics.ProcessStartInfo]::new($Bun)
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.ArgumentList.Add('-e')
  $info.ArgumentList.Add('setInterval(() => {}, 1000)')
  $held = [System.Diagnostics.Process]::Start($info)
  try {
    if ($held.WaitForExit(250)) { throw 'Installed Bun exited before the update check' }
    $processes = @(Get-CimInstance -ClassName Win32_Process | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installation, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($processes.Count -ne 1 -or $processes[0].ProcessId -ne $held.Id) {
      throw 'Expected exactly one owned process in the installation directory'
    }
    # Omit --force-run so the smoke never launches the desktop UI.
    Invoke-SmokeProcess $installers[0].FullName "/S --updated /D=$installation"
    if (-not $held.WaitForExit(5000)) { throw 'NSIS did not stop the single installed process' }
    Invoke-SmokeProcess $Bun '--version'
    Write-Output 'Updated the installation with one remaining Bun process'
  } finally {
    if (-not $held.HasExited) {
      $held.Kill($true)
      $held.WaitForExit()
    }
    $held.Dispose()
  }
}

$failure = $null
try {
  Invoke-SmokeProcess $installers[0].FullName "/S /D=$installation"
  if (-not (Test-Path "$installation/canopy.exe" -PathType Leaf)) { throw 'NSIS did not install the app' }
  $runtime = Join-Path $installation 'resources/runtime'
  $bun = Join-Path $runtime 'bun.exe'
  Invoke-SmokeProcess $bun '--version'
  Test-SingleProcessUpdate $bun
  foreach ($app in @('gateway', 'worker')) {
    $entry = Join-Path $runtime "canopy-$app.js"
    $actual = Invoke-SmokeProcess $bun "`"$entry`" --version" 60000
    if ($actual -ne $env:CANOPY_VERSION) { throw "$app version mismatch: $actual (expected $env:CANOPY_VERSION)" }
    Write-Output "Installed $app sidecar: $actual"
  }
  Invoke-SmokeProcess $bun 'test ./apps/desktop/test/process-recovery.test.ts ./apps/worker/src/images/export-local-temp.test.ts' 60000
} catch {
  $failure = $_
} finally {
  $uninstaller = Join-Path $installation 'Uninstall Canopy.exe'
  try {
    if (Test-Path $uninstaller) { Invoke-SmokeProcess $uninstaller "/S _?=$installation" }
  } catch {
    if ($null -eq $failure) { $failure = $_ }
    else { Write-Warning "Smoke cleanup also failed: $_" }
  } finally {
    Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
  }
}
if ($null -ne $failure) { throw $failure }
