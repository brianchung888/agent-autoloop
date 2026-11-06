# Installs Agent 自动化中台 on Windows: a clone in %USERPROFILE%\.agent-autoloop\app, with nothing to build and nothing
# else to install. The same decisions install.sh makes, said in the terms this platform has — a .cmd on PATH instead of a
# symlink, icacls instead of a mode, and the user's own PATH instead of a profile file.
#
# Written for Windows PowerShell 5.1 as well as PowerShell 7: it is what a new machine has, and this is the first thing
# anybody runs on one.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [init 的参数…]
#   powershell -ExecutionPolicy Bypass -File install.ps1 join <中台地址> --worker <名字> --key <密钥>
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Published = "https://github.com/KKKKhazix/agent-autoloop.git"
$Repo = if ($env:AGENT_AUTOLOOP_REPO) { $env:AGENT_AUTOLOOP_REPO } else { $Published }
$Root = if ($env:AGENT_AUTOLOOP_HOME) { $env:AGENT_AUTOLOOP_HOME } else { Join-Path $env:USERPROFILE ".agent-autoloop" }
$App = Join-Path $Root "app"
$Program = Join-Path $App "bin\agent-autoloop.ts"

function Quit([string]$Words) {
  Write-Host $Words
  exit 1
}

function NeedNode([string]$Words) {
  Write-Host $Words
  Write-Host @"
用 winget 的话：
  winget install OpenJS.NodeJS
用 nvm-windows 的话：
  nvm install 24
  nvm use 24
装好后重开一个终端，再运行一遍这个安装命令。
"@
  exit 1
}

function Have([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# Every argument its own argument: nothing here is built into a line for a shell to read.
function RunGit {
  # git says things on its error output that are not errors (a warning about a local clone, say). What went wrong is
  # what it leaves behind, so only that is read; while it runs, a line is a line.
  $before = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & git @args 2>&1 | ForEach-Object { "$_" }
  } finally {
    $ErrorActionPreference = $before
  }
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') 没成功：$(@($output) -join [Environment]::NewLine)" }
  return $output
}

if (-not (Have "git")) { Quit "需要 git。" }
if (-not (Have "node")) { NeedNode "需要 Node.js 24 或更新，这台电脑上没找到。" }
# Asked here rather than by running something in node: PowerShell does not pass a quote on to a program as it was typed.
$said = (& node -v) | Out-String
$major = [regex]::Match($said, '^v?(\d+)').Groups[1].Value
if (-not $major -or [int]$major -lt 24) { NeedNode "需要 Node.js 24 或更新，现在是 $($said.Trim())。" }

New-Item -ItemType Directory -Force -Path $Root | Out-Null
# What a mode does on POSIX: everyone else out, and what is written inside inherits it. host/permissions.ts says the same.
& icacls $Root /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "没能把 $Root 的权限锁到当前用户，同一台电脑上的其他用户可能读得到里面的东西。"
  # And written down where `doctor` reads it, in the shape host/permissions.ts writes: a line scrolling past during an
  # install is not a thing anybody can go back and look at. Whatever runs next says the same again, and wins.
  $mark = [pscustomobject]@{
    at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    trouble = "icacls 没能锁定 $Root"
  } | ConvertTo-Json
  # No mark of its own at the start of the file: node reads this back as JSON and a mark is not part of it.
  [System.IO.File]::WriteAllText((Join-Path $Root "permissions.json"), $mark, [System.Text.UTF8Encoding]::new($false))
}

# A copy follows where it came from, and what came from the public repository follows its newest release, which has passed
# every check. cli/update.ts decides the same way, or an update would fail on a copy this had moved.
$from = $Repo
if (Test-Path (Join-Path $App ".git")) {
  $origin = & git -C $App config --get remote.origin.url 2>$null
  if ($LASTEXITCODE -eq 0 -and $origin) { $from = $origin.Trim() }
}
$release = ""
if ($from -eq $Published) {
  # On a line of its own: getting no answer must not look like there being no releases.
  $tags = RunGit "ls-remote" "--refs" "--tags" $Published "v*"
  $versions = @()
  foreach ($line in @($tags)) {
    $found = [regex]::Match([string]$line, 'refs/tags/(v(\d+)\.(\d+)\.(\d+))$')
    if ($found.Success) {
      $versions += [pscustomobject]@{
        Tag = $found.Groups[1].Value
        Major = [int]$found.Groups[2].Value
        Minor = [int]$found.Groups[3].Value
        Patch = [int]$found.Groups[4].Value
      }
    }
  }
  if ($versions.Count) {
    $release = (@($versions | Sort-Object Major, Minor, Patch)[-1]).Tag
  }
}

if (-not (Test-Path (Join-Path $App ".git"))) {
  if ($release) {
    RunGit "-c" "advice.detachedHead=false" "clone" "--quiet" "--depth" "1" "--branch" $release "--" $Repo $App | Out-Null
  } else {
    RunGit "-c" "advice.detachedHead=false" "clone" "--quiet" "--depth" "1" "--" $Repo $App | Out-Null
  }
} elseif ($release) {
  RunGit "-C" $App "fetch" "--quiet" "--depth" "1" "origin" "refs/tags/$($release):refs/tags/$($release)" | Out-Null
  RunGit "-C" $App "checkout" "--quiet" "--detach" $release | Out-Null
} else {
  RunGit "-C" $App "pull" "--ff-only" "--quiet" | Out-Null
}

# Only a folder on PATH makes `agent-autoloop` work. There are no links to make here: a .cmd naming this program is what
# Windows runs, and one naming a different program is somebody else's to keep.
$ShimFolder = Join-Path $env:USERPROFILE ".local\bin"
$Shim = Join-Path $ShimFolder "agent-autoloop.cmd"
$Wanted = @"
@echo off
rem agent-autoloop, written by install.ps1. Deleting this file is how it leaves PATH. (ASCII on purpose: a .cmd is read
rem in whatever code page the console has, and this file has to be the same in all of them.)
setlocal
node --disable-warning=ExperimentalWarning "$Program" %*
exit /b %ERRORLEVEL%
"@

$placed = $false
if (-not (Test-Path $Shim) -or (Get-Content -LiteralPath $Shim -Raw).Contains($Program)) {
  New-Item -ItemType Directory -Force -Path $ShimFolder | Out-Null
  Set-Content -LiteralPath $Shim -Value $Wanted -Encoding ASCII
  $placed = $true
}

# The user's own PATH, which is theirs to change without an administrator. setx would cut it short at 1024 characters.
# This is the one thing here that outlives the folders above, so there is a way to say no to it: a smoke test installs
# into a throwaway profile, and the PATH it would be writing to is the real one either way.
if ($placed -and -not $env:AGENT_AUTOLOOP_NO_PATH) {
  $mine = [Environment]::GetEnvironmentVariable("PATH", "User")
  $already = @()
  if ($mine) { $already = $mine.Split(";") | Where-Object { $_ } }
  if ($already -notcontains $ShimFolder) {
    $joined = (@($already) + $ShimFolder) -join ";"
    [Environment]::SetEnvironmentVariable("PATH", $joined, "User")
    Write-Host "把 $ShimFolder 加进了你的 PATH。这个终端还没生效，重开一个才算。"
  }
}
# This session's own PATH either way: what runs below should find the name it is about to tell the person to type.
if ($placed -and ($env:PATH -split ";") -notcontains $ShimFolder) { $env:PATH = "$ShimFolder;$($env:PATH)" }

$code = 0
if ($args.Count -gt 0 -and $args[0] -eq "join") {
  & node --disable-warning=ExperimentalWarning $Program @args
  $code = $LASTEXITCODE
} elseif (Test-Path (Join-Path $Root "config.json")) {
  Write-Host "更新好了。"
  if ($args -notcontains "--no-service") {
    & node --disable-warning=ExperimentalWarning $Program service install
    $code = $LASTEXITCODE
  }
} else {
  & node --disable-warning=ExperimentalWarning $Program init @args
  $code = $LASTEXITCODE
}

# Whether typing the name runs this program, which is what every message printed above assumes. Finding nothing is an
# answer, not a failure: where.exe says so on its error output, and that is not something to stop for.
$before = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $found = & where.exe agent-autoloop 2>$null
} finally {
  $ErrorActionPreference = $before
}
$ours = $false
foreach ($place in @($found)) {
  if ($place -and (Test-Path -LiteralPath $place) -and (Get-Content -LiteralPath $place -Raw).Contains($Program)) {
    $ours = $true
    break
  }
}
if (-not $ours) {
  Write-Host ""
  Write-Host "直接打 agent-autoloop 运行不了这个程序：要么这个终端的 PATH 还是旧的（重开一个就好），要么排在前面的是另一个同名程序。"
  Write-Host "也可以每次写完整路径："
  Write-Host "  node --disable-warning=ExperimentalWarning `"$Program`""
}
exit $code
