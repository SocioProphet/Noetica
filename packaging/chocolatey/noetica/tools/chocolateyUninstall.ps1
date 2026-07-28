$ErrorActionPreference = 'Stop'

# Silently run the NSIS uninstaller registered by the desktop installer.
[array]$key = Get-UninstallRegistryKey -SoftwareName 'Noetica*'

if ($key.Count -eq 1) {
  $key | ForEach-Object {
    Uninstall-ChocolateyPackage -PackageName 'noetica' `
      -FileType 'exe' `
      -SilentArgs '/S' `
      -ValidExitCodes @(0) `
      -File "$($_.UninstallString.Trim('"'))"
  }
} elseif ($key.Count -eq 0) {
  Write-Warning "Noetica not found in the registry — nothing to uninstall."
} else {
  Write-Warning "Multiple 'Noetica*' entries found — uninstall manually from Apps & Features."
}

Write-Host "User data is preserved (models/config under `$env:USERPROFILE\.noetica)."
