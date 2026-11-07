param([Parameter(Mandatory)][string]$ReleaseDirectory)

$ErrorActionPreference = 'Stop'
$release = (Resolve-Path $ReleaseDirectory).Path
$publisher = (Get-Content "$PSScriptRoot/../package.json" -Raw | ConvertFrom-Json).build.win.azureSignOptions.publisherName
$installers = @(Get-ChildItem "$release/Canopy-*-windows-x64.exe" -File)
if ($installers.Count -ne 1) { throw 'Expected exactly one Windows installer' }
$application = Join-Path $release 'win-unpacked/canopy.exe'
$runtime = Join-Path $release 'win-unpacked/resources/runtime/bun.exe'
foreach ($required in @($application, $runtime)) {
  if (-not (Test-Path $required -PathType Leaf)) { throw "Missing packaged executable: $required" }
}

# Includes the app, bundled Bun, Electron helpers and any future executable sidecars.
$executables = @($installers) + @(Get-ChildItem "$release/win-unpacked" -Filter '*.exe' -File -Recurse)
foreach ($executable in $executables) {
  $signature = Get-AuthenticodeSignature -LiteralPath $executable.FullName
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature on $($executable.Name): $($signature.Status)"
  }
  $signer = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if ($signer -cne $publisher) { throw "Unexpected publisher on $($executable.Name): $signer" }
  Write-Output "Valid signature: $($executable.Name), publisher: $signer"
}
