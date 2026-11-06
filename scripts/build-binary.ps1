# Builds the single executable on Windows: build/agent-autoloop.exe, and a .sha256 beside it.
#
#   pwsh -NoProfile -File scripts/build-binary.ps1
#   pwsh -NoProfile -File scripts/build-binary.ps1 -Commit <sha> -Release v1.2.0 -Out C:\somewhere\agent-autoloop.exe
#
# The build itself is scripts/build-binary.ts, said once for all three platforms — the bundler's `--define`s, the list
# of files the binary carries, the version written into it. This is the way in on this platform and nothing more: a
# second copy of that contract, in another language, is a second contract.
#
# Nothing is installed: esbuild and postject come in through `npx --yes`, pinned, and package.json is untouched.
# The result is not signed. Windows SmartScreen will warn about it — INSTALL.md says what to do about that.
param(
  [string]$Commit,
  [string]$Release,
  [string]$Out
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$words = @()
if ($Commit) { $words += @("--commit", $Commit) }
if ($Release) { $words += @("--release", $Release) }
if ($Out) { $words += @("--out", $Out) }

& node --disable-warning=ExperimentalWarning (Join-Path $repo "scripts/build-binary.ts") @words
if ($LASTEXITCODE -ne 0) { throw "build-binary failed with $LASTEXITCODE" }
