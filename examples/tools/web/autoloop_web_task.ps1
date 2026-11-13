<#
autoloop_web_task.ps1 — 把 autoloop_web.py 註冊成「登入即啟動、無視窗」的排程工作 agent-autoloop-web

用法:
    pwsh -File autoloop_web_task.ps1            # 註冊（已存在則覆蓋）並立刻啟動
    pwsh -File autoloop_web_task.ps1 -Remove    # 停掉並反註冊
    pwsh -File autoloop_web_task.ps1 -Script D:\x\autoloop_web.py -Port 3352

無視窗做法：優先用 pythonw.exe（GUI subsystem，本來就沒主控台）；找不到 pythonw 才退回 python.exe，
並用 conhost --headless 包起來（Windows 11 有），再不行就只能 python.exe（會閃一下視窗）。
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [string]$TaskName = "agent-autoloop-web",
    [string]$Script = (Join-Path $PSScriptRoot "autoloop_web.py"),
    [int]$Port = 0
)
$ErrorActionPreference = "Stop"

if ($Remove) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已反註冊 $TaskName"
    } else { Write-Host "$TaskName 本來就不存在" }
    # 順手把還在跑的 server 殺掉（只殺指令列含本腳本路徑的 python）
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" |
        Where-Object { $_.CommandLine -and $_.CommandLine -like "*autoloop_web.py*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host "已停掉 pid $($_.ProcessId)" }
    exit 0
}

if (-not (Test-Path $Script)) { throw "找不到 $Script" }
$Script = (Resolve-Path $Script).Path
$scriptArgs = "`"$Script`""
if ($Port -gt 0) { $scriptArgs += " --port $Port" }

$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue)?.Source
$py  = (Get-Command python.exe  -ErrorAction SilentlyContinue)?.Source
if ($pyw) {
    $exe = $pyw; $argLine = $scriptArgs; $mode = "pythonw.exe（無主控台）"
} elseif ($py) {
    $conhost = Join-Path $env:SystemRoot "System32\conhost.exe"
    if (Test-Path $conhost) {
        $exe = $conhost; $argLine = "--headless `"$py`" $scriptArgs"; $mode = "python.exe 透過 conhost --headless（隱藏視窗）"
    } else {
        $exe = $py; $argLine = $scriptArgs; $mode = "python.exe（找不到 pythonw 與 conhost，可能會有視窗）"
    }
} else { throw "找不到 python / pythonw" }

$action    = New-ScheduledTaskAction -Execute $exe -Argument $argLine -WorkingDirectory (Split-Path $Script)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
             -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) { try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}; Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "agent-autoloop 工作流狀態網頁 http://127.0.0.1:3351/" | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$st = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host "已註冊 $TaskName；啟動方式：$mode"
Write-Host "執行檔：$exe"
Write-Host "參數：$argLine"
Write-Host "狀態：$((Get-ScheduledTask -TaskName $TaskName).State)；最近執行結果：$($st.LastTaskResult)"
Write-Host "反註冊：pwsh -File `"$PSCommandPath`" -Remove"
