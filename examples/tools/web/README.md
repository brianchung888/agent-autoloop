# 本機工作流狀態網頁

這是輔助工具，不是工作流 recipe：它不被 hub 排程驅動，只讀 hub 的 `status --json` 與各工作流的產出，提供本機網頁與手動觸發。放在 `examples/tools/web/`。

在瀏覽器看各個 agent-autoloop 工作流的上次結論、下次排程、產出檔與 log，並可按「現在跑」立刻觸發一輪。`autoloop_web.py` 是純 Python 標準庫的小 server，只綁 `127.0.0.1`，預設 http://127.0.0.1:3351/ ；它不碰規則、不碰紀錄，只呼叫 `agent-autoloop status --json` 與 `agent-autoloop emit`，再把 config 列出的檔案讀給瀏覽器。搭配 [整理個人相關 GitLab Issue](../../recipes/gitlab-issues/README.md) 時，`latest.html` 透過 `/api/version/<id>/<n>` 判斷有沒有新版，不用自己定時重載。

## 需求

- agent-autoloop 已安裝、hub 在跑（`agent-autoloop status` 正常），本機已有 `local` 來源金鑰（`agent-autoloop key list` 可見），`emit` 才不必帶 `--key`。
- Python 3.12 以上（只用標準庫，不需要 `pip install`）。
- 常駐用的 `autoloop_web_task.ps1` 只支援 Windows（`Register-ScheduledTask`）；macOS / Linux 直接 `python autoloop_web.py` 或自行接 launchd / systemd。

## 安裝

```powershell
# Windows（PowerShell）；$tool 指向本目錄
Copy-Item "$tool\web.example.json" "$HOME\.agent-autoloop\web.json"
```

```sh
# macOS / Linux；$tool 指向本目錄
cp "$tool"/web.example.json ~/.agent-autoloop/web.json
```

接著編輯 `~/.agent-autoloop/web.json`：`autoloopExe` 填 `agent-autoloop` 執行檔完整路徑；`workflows` 照自己的規則填（範例裡的 `my-workflow` 只是示範目錄型產出與 log，用不到就刪掉）；`<work-dir>`、`<docs-dir>` 一類占位全部換成實際路徑。

## 手動跑一次

```sh
python autoloop_web.py                              # 讀 ~/.agent-autoloop/web.json，預設埠 3351
python autoloop_web.py --port 3352 --config D:/x/web.json
```

stderr 第一行是「autoloop-web 聽在 http://127.0.0.1:3351/ （config …；N 個工作流）」。開首頁看三張卡有沒有讀到狀態；卡片顯示「status 裡找不到規則「…」」表示 `ruleName` 和 `agent-autoloop status --json` 的 `lines[].id` 對不上。

## 常駐（Windows）

`autoloop_web_task.ps1` 用 `Register-ScheduledTask` 註冊一個「登入即啟動、無視窗」的排程工作 `agent-autoloop-web`：優先用 `pythonw.exe`（沒有主控台），找不到才退回 `python.exe` 包 `conhost --headless`。

```powershell
pwsh -File autoloop_web_task.ps1                       # 註冊（已存在則覆蓋）並立刻啟動
pwsh -File autoloop_web_task.ps1 -Port 3352            # 換埠
pwsh -File autoloop_web_task.ps1 -Script D:\x\autoloop_web.py
pwsh -File autoloop_web_task.ps1 -Remove               # 停掉並反註冊
```

改了 `autoloop_web.py` 或 `web.json` 之後重啟：`Stop-ScheduledTask agent-autoloop-web; Start-ScheduledTask agent-autoloop-web`。pythonw 下沒有主控台，server 訊息寫到 `~/.agent-autoloop/logs/web.log`（每次啟動覆寫）；要看即時訊息就改用終端手動跑。

## web.json 格式

| 欄位 | 說明 |
|---|---|
| `port` | 埠號，`--port` 可覆寫 |
| `autoloopExe` | `agent-autoloop` 執行檔完整路徑（可用 `~`） |
| `hubLog` | 中台 `up.log`，給 `/log/hub` 用；不填則該路由 404 |
| `workflows[].id` | URL 用的識別字 |
| `workflows[].name` | 卡片標題 |
| `workflows[].ruleName` | cron 規則名，對應 `status --json` 的 `lines[].id` / `runs[].rule`；同 `group` 的規則（例如「（手動）」那條）會一起算 |
| `workflows[].emitType` | 「現在跑」送的事件類型（`agent-autoloop emit <emitType>`） |
| `workflows[].workDir` | `outputs` / `logs` 相對路徑的基準 |
| `workflows[].outputs[]` | `{label, path}`；`path` 是檔案或目錄，相對 `workDir` 或絕對。目錄型列最近 30 篇 `*-Article*.md`（沒有就列所有 `.md`） |
| `workflows[].logs[]` | `{label, path}`，同上 |

## 路由

| 路由 | 說明 |
|---|---|
| `GET /` | 首頁，每個工作流一張卡；每 60 秒 fetch `/api/status` 更新 |
| `GET /api/status` | `status --json` 整理後的 JSON，快取 10 秒 |
| `POST /run/<id>` | `agent-autoloop emit <emitType>`；同一工作流 10 秒內第二次回 429 |
| `GET /out/<id>/<n>[/<sub>]` | 第 n 個產出：`.html` 原樣、`.md` 極簡轉換（`?raw=1` 原始檔）、目錄列清單、其他純文字 |
| `GET /log/<id>/<n>?n=200` | 該 log 最後 N 行，每 10 秒自動刷新（`&raw=1` 純文字） |
| `GET /log/hub?n=200` | 中台 `up.log`，同上 |
| `GET /api/version/<id>/<n>` | 該產出的 `mtime`、大小；`latest.html` 用它判斷要不要重載 |
| `GET /favicon.ico` | 分頁小圖（SVG，`Cache-Control: max-age=86400`）；server 自產的頁面 `<head>` 也內嵌同一張 |

## 安全

- 只綁 `127.0.0.1`，不接受區網或外部連線；要給別台看請自己加反向代理與認證，本 server 沒有任何認證。
- 路徑穿越防護：URL 含 `.` 或 `..` 片段一律 403；`/out`、`/log` 的目標解析（`resolve()`）後必須等於 config 列出的檔案、或落在列出的目錄之下，否則 403。config 沒列的檔案讀不到。
- CORS：只有 `/api/status` 與 `/api/version/<id>/<n>` 兩個 JSON 路由帶 `Access-Control-Allow-Origin: *`，讓 `file://` 開的 `latest.html` 也能 fetch；其他路由（含 `POST /run`）沒有 CORS 標頭，別的網頁無法跨來源觸發。
- `POST /run` 只做 10 秒冷卻，沒有 CSRF token；同一台機器上的任何程式都能打 `127.0.0.1:3351`，這和直接執行 `agent-autoloop emit` 是同一個信任邊界。

## 常見問題

- **卡片顯示「無法讀取」**：`autoloopExe` 路徑錯、hub 沒在跑、或 `status --json` 超過 30 秒；手動跑 `agent-autoloop status --json` 看。
- **「現在跑」回 500**：`emit` 失敗，回應框裡是 `agent-autoloop emit` 的原始輸出，常見是沒有 `local` 來源金鑰或規則沒有對應 `emitType` 的 `on`。
- **產出 404「檔案不存在」**：config 的 `path` 對，但該輪還沒產出；403 表示路徑解析後跑出允許範圍。
- **分頁沒有 icon**：`/out/<id>/<n>` 是原樣送出檔案，icon 由檔案自己的 `<link rel="icon">` 決定；gitlab-issues 的 `template.html` 已內嵌，舊產出要 `gitlab_issues.py --force` 重產。
