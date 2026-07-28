$ErrorActionPreference = 'Stop'

# Installs the official Noetica desktop NSIS installer (same artifact as the GitHub release
# and winget). Pinned URL + sha256 per choco moderation rules — never 'latest', never SKIP.
$packageArgs = @{
  packageName    = 'noetica'
  fileType       = 'exe'
  url64bit       = 'https://github.com/SocioProphet/Noetica/releases/download/v0.4.24/Noetica_0.4.24_x64-setup.exe'
  checksum64     = 'c891867ccd8219e616dbe2eb3ebbb6e16f273a0414b73f89cf17e8a6f807f7a0'
  checksumType64 = 'sha256'
  silentArgs     = '/S'          # NSIS silent install (per-user scope, matching winget)
  validExitCodes = @(0)
  softwareName   = 'Noetica*'
}

Install-ChocolateyPackage @packageArgs
