# Someone's first hour on Windows, start to finish, in a throwaway home: install what's committed here with install.ps1,
# start it, run `try` with nobody at a terminal, answer, see it finish, uninstall, and check nothing's left. Only the
# Agent is a stand-in. It takes no service: a CI machine does not always have a session to run one in, and the desktop
# channel is off here for the same reason — Windows has no notifier of ours yet (plugins/desktop/channel.ts).
#
# What scripts/install-smoke.sh does, said in the terms this platform has.
#
#   pwsh -NoProfile -File scripts/install-smoke.ps1
#   pwsh -NoProfile -File scripts/install-smoke.ps1 -Binary build/agent-autoloop.exe
#
# `-Binary` runs the same hour against a packaged build. There is no installer there and nothing to install: the binary
# is the whole program, so "installing" it is putting the file somewhere and running `init`. Everything after that is
# the same hour, and that is the point of it being the same script — a packaged build has to be the same program.
param(
  [string]$Binary
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# `doctor` leaves with a code of its own, which is a report and not an error here. On the shells where a native
# command's exit code is turned into one, that would throw before the report could be read. (Unknown on 5.1, where
# assigning it is harmless.)
$PSNativeCommandUseErrorActionPreference = $false
# Everything this reads back was written by node, which writes UTF-8. Without this the console's own code page decodes
# it, and every message checked for below arrives as something else.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 这份自检断言的是这个程序原来那些字，也就是简体的那一份（i18n/zh-CN.ts）。程序和 install.ps1 默认都说正體，
# 所以这里说一次要哪一种；两种话都断言一遍不会多验出什么，只会把每一句写两遍。
$env:AGENT_AUTOLOOP_LANG = "zh-CN"

$repo =(Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-autoloop-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$upJob = $null
$packaged = [bool]$Binary
$program = $null
if ($packaged) { $program = (Resolve-Path -LiteralPath $Binary).Path }

function Fail([string]$Words) {
  Write-Host "install-smoke: $Words" -ForegroundColor Red
  throw $Words
}

function WaitFor([string]$What, [scriptblock]$Ready) {
  for ($i = 0; $i -lt 150; $i++) {
    try {
      if (& $Ready) { return }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  Fail $What
}

function Program {
  if ($packaged) { return $program }
  return (Join-Path $work "hub\app\bin\agent-autoloop.ts")
}

# How this build is started: a packaged one is the whole command line, a source one is this node and the entry script
# (host/self.ts says the same thing inside the program). The leading comma is what keeps a one-word answer an array:
# a function returning @(x) hands back x itself, and `up` would then be started with the executable as an argument.
function Started {
  if ($packaged) { return ,@((Program)) }
  return ,@((Get-Command node).Source, "--disable-warning=ExperimentalWarning", (Program))
}

# Whatever has to come before a subcommand. Empty for a packaged build, which is why this is not a range: $w[1..0]
# counts backwards and would hand back the executable twice.
function Before($words) {
  if ($words.Count -le 1) { return @() }
  return $words[1..($words.Count - 1)]
}

function Autoloop {
  $words = Started
  & $words[0] @(@(Before $words) + $args)
}

# The same thing, for a command that is meant to stop: what it says it says on stderr, and on Windows PowerShell every
# line a native command writes there is an error of its own — which, where errors stop the script, would end this one
# before the words could be read. So they are let through here and handed back as text.
function AutoloopSaying {
  $was = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $words = Started
    return (& $words[0] @(@(Before $words) + $args) 2>&1 | Out-String)
  } finally {
    $ErrorActionPreference = $was
  }
}

New-Item -ItemType Directory -Force (Join-Path $work "home") | Out-Null
$env:USERPROFILE = Join-Path $work "home"
$env:AGENT_AUTOLOOP_HOME = Join-Path $work "hub"
$env:AGENT_AUTOLOOP_REPO = $repo
# The user's PATH is the real one whatever profile this runs in, and nothing here is about PATH: the shim being written
# is, and that is checked below.
$env:AGENT_AUTOLOOP_NO_PATH = "1"
Remove-Item Env:AGENT_AUTOLOOP_RULES -ErrorAction SilentlyContinue
Remove-Item Env:AGENT_AUTOLOOP_PUBLIC_URL -ErrorAction SilentlyContinue
Remove-Item Env:AGENT_AUTOLOOP_COMMIT -ErrorAction SilentlyContinue
Remove-Item Env:AGENT_AUTOLOOP_RELEASE -ErrorAction SilentlyContinue

# The Agent: it asks once, and once it has been answered it says what was chosen. The same one install-smoke.sh uses.
# Run by node, not by a .cmd of its own: a batch file is a script for the command interpreter and cannot be started as a
# program, which is why plugins/claude/agent.ts names only real executables among the places it looks.
$agentJs = Join-Path $work "agent.mjs"
Set-Content -LiteralPath $agentJs -Encoding UTF8 -Value @'
import { readFileSync } from "node:fs";
const context = readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, "utf8");
if (context.includes("card.answered")) console.log("你选了绿色，试跑通过");
else
  console.log(
    `问了一个问题\n\n\`\`\`agent-autoloop\n` +
      JSON.stringify({
        ask: [
          { title: "试跑：选一个颜色", text: "这是一次试跑，选哪个都行。", options: ["蓝色", "绿色"], key: "try-color" },
        ],
      }) +
      "\n```",
  );
'@

try {
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $probe.Start()
  $port = $probe.LocalEndpoint.Port
  $probe.Stop()

  $shim = Join-Path $env:USERPROFILE ".local\bin\agent-autoloop.cmd"
  if ($packaged) {
    # Nothing to install: the file is the program. It is copied somewhere of its own first, because that is what a
    # person downloading it does — and because a binary sitting in the source tree is the one case the mode check had
    # better not be fooled by (phase3-poc-report.md 三.1 步骤 5).
    $here = Join-Path $work "bin"
    New-Item -ItemType Directory -Force $here | Out-Null
    Copy-Item -LiteralPath $program -Destination (Join-Path $here "agent-autoloop.exe")
    $program = (Join-Path $here "agent-autoloop.exe")
    $set = (Autoloop "init" "--no-service" "--command" "node $agentJs {prompt}" "--port" $port) -join "`n"
    Write-Host $set
    if ($LASTEXITCODE -ne 0) { Fail "init failed" }
    if (-not $set.Contains("up 启动中台")) { Fail "the next step printed isn't to start it" }
    # The one thing a packaged build must never say: run a `.ts`. There are none in it (计划 plan-c 3.4).
    if ($set -match "\.ts(\s|$)") { Fail "init told them to run a .ts, and a binary has none" }
    if (-not $set.Contains($program)) { Fail "the next step doesn't name this executable" }
  } else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "install.ps1") `
      --no-service --command "node $agentJs {prompt}" --port $port 2>&1 |
      Tee-Object -FilePath (Join-Path $work "install.out")
    if ($LASTEXITCODE -ne 0) { Fail "install.ps1 failed" }

    if (-not (Test-Path $shim)) { Fail "install.ps1 didn't put the command in ~/.local/bin" }
    if (-not (Get-Content -LiteralPath $shim -Raw).Contains((Program))) { Fail "the shim doesn't name this install" }
    if (-not (Get-Content -LiteralPath (Join-Path $work "install.out") -Raw).Contains("up 启动中台")) {
      Fail "the next step printed isn't to start it"
    }
  }

  # Which code this is, out of a checkout or out of the binary's own insides — a bug report nobody can place is the
  # failure here (计划 plan-c 3.6).
  $commit = (& git -C $repo rev-parse HEAD).Substring(0, 12)
  $said = (Autoloop "--version") -join "`n"
  if (-not $said.Contains($commit)) {
    if ($packaged) { Fail "the binary says '$said', not ${commit} - it wasn't built from this tree, or it says dev" }
    Fail "--version doesn't say $commit"
  }

  # Started the way a person would, in a process of its own that inherits this environment: HOME and all.
  $words = Started
  $upArgs = @()
  foreach ($word in (Before $words)) { $upArgs += "`"$word`"" }
  $upArgs += "up"
  $upJob = Start-Process -FilePath $words[0] -PassThru -NoNewWindow `
    -ArgumentList $upArgs `
    -RedirectStandardOutput (Join-Path $work "up.log") -RedirectStandardError (Join-Path $work "up.err")
  $healthz = "http://127.0.0.1:$port/healthz"
  WaitFor "up didn't start" { (Invoke-WebRequest -Uri $healthz -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 }

  $tried = (Autoloop "try") -join "`n"
  Write-Host $tried
  if ($LASTEXITCODE -ne 0) { Fail "try failed" }
  $card = [regex]::Match($tried, 'agent-autoloop answer (\d+)').Groups[1].Value
  if (-not $card) { Fail "try didn't say how to answer" }

  Autoloop "answer" $card "2" | Write-Host
  WaitFor "status never showed it finished" { ((Autoloop "status") -join "`n").Contains("试跑通过") }
  $status = (Autoloop "status") -join "`n"
  Write-Host $status
  if (-not $status.Contains("最近 7 天 2 轮")) { Fail "status doesn't count the two rounds" }

  # doctor: the one command that talks to the hub more than once and then leaves with a code of its own. Ending the
  # process outright there makes libuv abort on Windows (uv/src/win/async.c:76), which is exit 127 and no report at
  # all. And it has to say the one thing this platform cannot do, rather than a green tick for a channel that reaches
  # nobody: the desktop channel is running here and skipping every card.
  $checked = (Autoloop "doctor") -join "`n"
  $itsCode = $LASTEXITCODE
  Write-Host $checked
  if ($itsCode -ne 1) {
    Fail "doctor left with $itsCode; 1 is what it says about the service nobody installed in this smoke test"
  }
  if ($checked -match "Assertion failed") { Fail "doctor aborted instead of leaving" }
  if (-not $checked.Contains("桌面通知不可用")) { Fail "doctor doesn't say that notifications don't arrive here" }
  if ($checked -match "连不上中台") { Fail "doctor can't reach the hub that is running" }
  # The Skill an Agent is told to read has to be a file that is there. A packaged build carries it and writes it out
  # under this install's own HOME (计划 plan-c 3.5); PoC had it naming the executable's parent folder, where nothing was.
  # 两种中文都认：这一句（cli.doctor.onlyDesktopTail）正體写「接法見」、简体写「接法见」，而手册本身也是按语言放
  # 出去的（host/skill.ts）。断言只认一种，就等于这一关只在一种语言下有效——换一种就静悄悄地什么都没查。
  $manual = [regex]::Match($checked, '接法[见見] (.+SKILL\.md)').Groups[1].Value
  if (-not $manual) { Fail "doctor doesn't say where the Skill is" }
  if (-not (Test-Path -LiteralPath $manual)) { Fail "doctor points at a Skill that isn't there: $manual" }
  if ($packaged -and -not $manual.StartsWith($env:AGENT_AUTOLOOP_HOME)) {
    Fail "a packaged build should write the Skill under its own HOME, not $manual"
  }

  # Every other way a command stops is said the same way: a code left behind, not a process ended where it stands. This
  # one has talked to the hub and then turns the answer down, which is the path every `fail` in cli/main.ts takes.
  $refused = AutoloopSaying "answer" "999999" "1"
  $refusedCode = $LASTEXITCODE
  Write-Host $refused
  if ($refusedCode -ne 1) { Fail "answering a card that isn't there left with $refusedCode, not 1" }
  if ($refused -match "Assertion failed") { Fail "answering a card that isn't there aborted instead of leaving" }

  Autoloop "uninstall" "--yes" | Write-Host
  if (-not (Test-Path (Join-Path $work "hub\config.json"))) { Fail "uninstall deleted the data" }
  if ($packaged) {
    # The Skill it wrote out is the program's own material and goes with it; the file somebody downloaded is theirs.
    if (Test-Path (Join-Path $work "hub\skills\agent-autoloop")) { Fail "uninstall left the Skill it wrote out" }
    if (-not (Test-Path -LiteralPath $program)) { Fail "uninstall deleted the binary the person downloaded" }
  } else {
    if (Test-Path (Join-Path $work "hub\app")) { Fail "uninstall left the program" }
    if (Test-Path $shim) { Fail "the command is still there" }
  }
  $up = $false
  try {
    Invoke-WebRequest -Uri $healthz -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true
  } catch {}
  if ($up) { Fail "the hub is still running" }
  $left = Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -File -Force -ErrorAction SilentlyContinue
  if ($left) { Fail "left behind: $($left.FullName -join ', ')" }

  if ($packaged) { Write-Host "install-smoke: the binary, from first run to uninstall, all good." }
  else { Write-Host "install-smoke: from install to uninstall, all good." }
} finally {
  if ($upJob -and -not $upJob.HasExited) { Stop-Process -Id $upJob.Id -Force -ErrorAction SilentlyContinue }
  foreach ($log in @("up.log", "up.err")) {
    $file = Join-Path $work $log
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length) {
      Write-Host "--- $log"
      Get-Content -LiteralPath $file | Write-Host
    }
  }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
