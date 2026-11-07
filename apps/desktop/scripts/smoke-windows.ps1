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

try {
  Invoke-SmokeProcess $installers[0].FullName "/S /D=$installation"
  if (-not (Test-Path "$installation/canopy.exe" -PathType Leaf)) { throw 'NSIS did not install the app' }
  $runtime = Join-Path $installation 'resources/runtime'
  $bun = Join-Path $runtime 'bun.exe'
  Invoke-SmokeProcess $bun '--version'
  foreach ($app in @('gateway', 'worker')) {
    $entry = Join-Path $runtime "canopy-$app.js"
    $actual = Invoke-SmokeProcess $bun "`"$entry`" --version" 60000
    if ($actual -ne $env:CANOPY_VERSION) { throw "$app version mismatch: $actual (expected $env:CANOPY_VERSION)" }
    Write-Output "Installed $app sidecar: $actual"
  }
} finally {
  $uninstaller = Join-Path $installation 'Uninstall Canopy.exe'
  if (Test-Path $uninstaller) { Invoke-SmokeProcess $uninstaller "/S _?=$installation" }
  Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
