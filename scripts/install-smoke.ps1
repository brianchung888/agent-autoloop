# Someone's first hour on Windows, start to finish, in a throwaway home: install what's committed here with install.ps1,
# start it, run `try` with nobody at a terminal, answer, see it finish, uninstall, and check nothing's left. Only the
# Agent is a stand-in. It takes no service: a CI machine does not always have a session to run one in, and the desktop
# channel is off here for the same reason — Windows has no notifier of ours yet (plugins/desktop/channel.ts).
#
# What scripts/install-smoke.sh does, said in the terms this platform has.
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

$repo =(Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-autoloop-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$upJob = $null

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
  return (Join-Path $work "hub\app\bin\agent-autoloop.ts")
}

function Autoloop {
  & node --disable-warning=ExperimentalWarning (Program) @args
}

# The same thing, for a command that is meant to stop: what it says it says on stderr, and on Windows PowerShell every
# line a native command writes there is an error of its own — which, where errors stop the script, would end this one
# before the words could be read. So they are let through here and handed back as text.
function AutoloopSaying {
  $was = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    return (& node --disable-warning=ExperimentalWarning (Program) @args 2>&1 | Out-String)
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

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "install.ps1") `
    --no-service --command "node $agentJs {prompt}" --port $port 2>&1 |
    Tee-Object -FilePath (Join-Path $work "install.out")
  if ($LASTEXITCODE -ne 0) { Fail "install.ps1 failed" }

  $shim = Join-Path $env:USERPROFILE ".local\bin\agent-autoloop.cmd"
  if (-not (Test-Path $shim)) { Fail "install.ps1 didn't put the command in ~/.local/bin" }
  if (-not (Get-Content -LiteralPath $shim -Raw).Contains((Program))) { Fail "the shim doesn't name this install" }
  if (-not (Get-Content -LiteralPath (Join-Path $work "install.out") -Raw).Contains("up 启动中台")) {
    Fail "the next step printed isn't to start it"
  }

  $commit = (& git -C $repo rev-parse HEAD).Substring(0, 12)
  if (-not ((Autoloop "--version") -join "`n").Contains($commit)) { Fail "--version doesn't say $commit" }

  # Started the way a person would, in a process of its own that inherits this environment: HOME and all.
  $upJob = Start-Process -FilePath (Get-Command node).Source -PassThru -NoNewWindow `
    -ArgumentList "--disable-warning=ExperimentalWarning", "`"$(Program)`"", "up" `
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

  # Every other way a command stops is said the same way: a code left behind, not a process ended where it stands. This
  # one has talked to the hub and then turns the answer down, which is the path every `fail` in cli/main.ts takes.
  $refused = AutoloopSaying "answer" "999999" "1"
  $refusedCode = $LASTEXITCODE
  Write-Host $refused
  if ($refusedCode -ne 1) { Fail "answering a card that isn't there left with $refusedCode, not 1" }
  if ($refused -match "Assertion failed") { Fail "answering a card that isn't there aborted instead of leaving" }

  Autoloop "uninstall" "--yes" | Write-Host
  if (-not (Test-Path (Join-Path $work "hub\config.json"))) { Fail "uninstall deleted the data" }
  if (Test-Path (Join-Path $work "hub\app")) { Fail "uninstall left the program" }
  if (Test-Path $shim) { Fail "the command is still there" }
  $up = $false
  try {
    Invoke-WebRequest -Uri $healthz -UseBasicParsing -TimeoutSec 2 | Out-Null
    $up = $true
  } catch {}
  if ($up) { Fail "the hub is still running" }
  $left = Get-ChildItem -LiteralPath $env:USERPROFILE -Recurse -File -Force -ErrorAction SilentlyContinue
  if ($left) { Fail "left behind: $($left.FullName -join ', ')" }

  Write-Host "install-smoke: from install to uninstall, all good."
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
