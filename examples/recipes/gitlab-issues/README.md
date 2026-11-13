# 整理與我相關的 GitLab Issue

上班時段每 10 分鐘收集多個專案中「指派給我 / 我建立 / 含追蹤標籤」的 Issue，由 `gitlab_issues.py` 在本機產出稿件並用既有通知提醒。產出在工作目錄的 `briefs/`：`latest.md` 是依專案分「未結案 / 近期已結案」並附「待我確認」清單的 Markdown，`latest.html` 是同一份資料套進固定版面（`template.html`）的網頁版：單一清單、不依專案分區，每筆以標籤顯示專案名、依更新時間由新到舊排序（專案篩選按鈕可只看單一專案），24 小時內有回應的 Issue 會標紅。分組、排序、24 小時判定與寫檔全由腳本決定；LLM 只負責從未結案 Issue 原文挑出「待我確認」候選（每輪最多一次呼叫，失敗自動退回本機規則，`--no-llm` 可完全不呼叫）。不建立、不修改、不回寫任何 Issue。

## 需求

- agent-autoloop 已安裝並 `agent-autoloop init` 完成，`agent-autoloop status` 看得到自己的 worker 名稱。
- Python 3.12 以上（只用標準庫 `urllib`、`zoneinfo`，不需要 `pip install`）。
- GitLab Personal Access Token，scope `read_api` 即可；腳本讀環境變數 **`GITLAB_TOKEN`**，必須注入**跑 `agent-autoloop up` 的那個環境**，另一個終端設了不會傳進去。
- 公司 GitLab 用自簽 CA 時，同一環境再設 `SSL_CERT_FILE` 或 `GITLAB_CA_FILE` 指向 `.pem`；不要關閉 TLS 驗證。
- 本人 GitLab 數字 ID：`GET <baseUrl>/api/v4/user` 回傳的 `id`（帶 `PRIVATE-TOKEN` header）。
- 「待我確認」要用 LLM 時：`claude`、`codex`、`agy` 三個 CLI 其一已在這台電腦登入（`--backend claude|codex|antigravity`，預設 `claude`，預設模型 `claude-haiku-4-5-20251001`）。`--no-llm` 時不需要。

## 安裝

把本目錄**全部檔案**複製到工作目錄（預設 `~/.agent-autoloop/work/gitlab-issues`，也可任何目錄再用 `--work-dir` 指定）。本目錄的檔案：`gitlab_issues.py`（腳本）、`agentrunner-windows-x86_64.exe`（驅動 Claude / Codex / Antigravity CLI 的工具執行檔，見下段）、`template.html`（網頁版面）、`sources.json`（來源設定）、`rules.json`（要併入中台的規則）、`SKILL.md`、`README.md`。`SKILL.md` 是「待我確認」的規則，腳本執行時從裡面讀出含「待我確認」的段落當 LLM 的 system prompt（尋找順序見常見問題）。


**LLM 怎麼叫**：腳本不 import 任何 agentrunner 的 Python 套件，而是以 subprocess 執行**與腳本同目錄的 `agentrunner-windows-x86_64.exe`**（`<exe> run --agent <backend> --max-turns 1 --quiet --output ndjson`，prompt 走 stdin）；要放在別處時設環境變數 `AGENTRUNNER_EXE` 指到它。後端 `claude` / `codex` / `antigravity` 的 CLI 路徑由 `gitlab_issues.py` 的 `BACKEND_BIN_DEFAULTS` 決定：`claude`、`codex` 預設帶 `--bin %APPDATA%\npm\claude.cmd` / `codex.cmd`（Windows 的 CreateProcess 找不到 PATH 上無副檔名的 npm wrapper，要指到 `.cmd`），`antigravity` 不帶 `--bin`、讓 exe 自己在 PATH 上找 `agy`；任一後端都可用環境變數 `AGENTRUNNER_<後端大寫>_BIN`（例 `AGENTRUNNER_CODEX_BIN`）覆寫，路徑不存在就不帶 `--bin`。只附 Windows x86_64 的執行檔；其他平台請自行從來源 repo 建置（Rust 專案，`rust/` 目錄）。來源：agentrunner 1.1.0（`agentrunner-windows-x86_64.exe --version` 印 `agentrunner 1.1.0`），公司內部 GitLab `gitscr1.moneydj.com/brianchung/agentrunner`，是 [Multica](https://github.com/multica-ai/multica) `server/pkg/agent` 的移植，授權沿用 Multica 修改版 Apache 2.0（單一組織內部使用不需商業授權；作為對外服務或嵌入商業產品需另取得授權，詳見來源 repo 的 `LICENSE`、`NOTICE`）。

```powershell
# Windows（PowerShell）；$recipe 指向本目錄
$work = "$HOME\.agent-autoloop\work\gitlab-issues"
New-Item -ItemType Directory -Force $work | Out-Null
Copy-Item -Recurse -Force "$recipe\*" $work
```

```sh
# macOS / Linux；$recipe 指向本目錄
work=~/.agent-autoloop/work/gitlab-issues
mkdir -p "$work"
cp -R "$recipe"/. "$work"/
```

接著編輯 `$work/sources.json`：`baseUrl` 填公司 GitLab 根網址；`projects` 填 1–20 個專案路徑或數字 ID；`userId` 填本人數字 ID，可以是單一整數或整數陣列（例如 `139` 或 `[139, 140]`，多個帳號都算「本人」）；`label` 填完整標籤，可以是單一字串或字串陣列（例如 `"Brian"` 或 `["Brian", "2026重點"]`，任一標籤命中就入選；每個標籤不能含逗號，不能是 `Any`/`None`）；`closedUpdatedDays` 是「近期已結案」回看天數（1–365）；`timezone` 是稿件顯示時區（IANA，例如 `Asia/Taipei`）。

## 手動跑一次

在已注入 `GITLAB_TOKEN` 的終端，先 `--dry-run` 看收集結果（只寫快照 `gitlab-inputs/<id>.json`，不叫 LLM、不寫 `briefs/`）：

```sh
cd ~/.agent-autoloop/work/gitlab-issues
python gitlab_issues.py --dry-run
```

成功時 stdout 第一行是「做完了（dry-run）：快照 <id>，未結案 N 筆、近期已結案 M 筆」，再列各專案統計與規則版待我確認候選數。401 查 token、403 查 scope 與專案權限、404 查專案路徑。接著正式跑：

```sh
python gitlab_issues.py                          # 待我確認用 LLM（預設 claude haiku）
python gitlab_issues.py --no-llm                 # 不叫 LLM，待我確認改用本機規則
python gitlab_issues.py --backend codex --model gpt-5.3-codex
python gitlab_issues.py --skill D:/x/SKILL.md    # 指定「待我確認」規則檔
python gitlab_issues.py --work-dir D:/x --effort low --timeout 300
```

stdout 第一行是結論（`做完了：…`、`没事可做：快照 <id> 已處理`、`没跑成：<原因>` 並 exit 1），其餘進度訊息走 stderr，不印 token。做完後 `briefs/latest.md`、`latest.html`、`<id>.md/.html`、`<日期>.md/.html` 都在。

## 接進 agent-autoloop

把 `rules.json` 的 `agents`、`rules` 兩段**併入**自己的 `~/.agent-autoloop/rules.json`（不要整檔覆蓋）：只有一條 command rule，cron `*/10 8-18 * * *` 在 `cwd` 跑 `python {cwd}/gitlab_issues.py --autoloop`。`worker` 由 `my-pc` 改成 `agent-autoloop status` 列出的自己的 worker 名稱；`cwd` 可保留 `~/...` 寫法，或改成絕對路徑（Windows JSON 用 `C:/Users/you/...`）。頂層 `timezone` 與 `sources.local` 若已有就不要重複。`--no-llm`、`--backend`、`--skill` 都可以直接加在 `command` 陣列裡。然後 `agent-autoloop check`，再 `agent-autoloop rules explain` 看規則被認得。

不需要 agent 權限（`access`）、不需要 `emits`、不需要來源金鑰：腳本以 command 執行，`--autoloop` 讓它在結尾加印 ```` ```agent-autoloop ```` 回執區塊，worker 解析後送出 `key=gitlab-brief-<id>`、`fyi=true` 的 notice，內含總覽、近期已結案、最新未結案前 5 筆與待我確認重點。

## 運作方式

- 收集：每個專案 × {opened, closed} × {每個 `userId` 各一個 assignee 查詢、各一個 author 查詢、每個 `label` 各一個 labels 查詢} 聯集（GitLab 的 `labels` 參數用逗號是 AND，所以多個標籤分開查再聯集）、分頁、每頁 30 秒逾時、不跟隨重導向；closed 只取 `updatedAfter`（UTC 日界 − `closedUpdatedDays`）之後更新的。快照 `gitlab-inputs/<id>.json` 的 `id` 是內容的 sha256（內容含正規化後的 `userIds`、`labels` 陣列，改設定就會得到新 id），已存在不覆寫；讀舊快照時單值的 `userId`/`label` 自動視為一個元素的陣列。
- 去重：`briefs/seen.json` 記錄已處理的快照 id；同一 id 且 `<id>.md/.html` 都在就「没事可做」，所以 10 分鐘一次也不會一直吵；任何 Issue 有變動 id 就不同，自動進新一輪。同一快照的 notice 只發一次。
- 強制重跑（內容沒變但改了 SKILL.md 或模板）：加 `--force`，或刪掉 `briefs/seen.json` 裡的該 id。
- 24 小時內回應標記（HTML `R` 紅標、Markdown `🆕`、待我確認 `NEW`）只看真正的留言，且最後留言者非本人：腳本對 `updated_at` 在 48 小時內的 Issue 多查一次 Notes API，把最後一則人寫留言的作者與時間寫進快照 `last_note`；`last_note.created_at` 在收集時間 24 小時內且 `last_note.author_id` 不在 `userId` 清單內才標，`last_note` 為 `null` 或缺欄位（沒有留言、或超過 48 小時未查）一律不標。`updated_at` 只用於排序與顯示。
- `template.html` 的版面是固定的；腳本只替換 `<script id="data" type="application/json">` 那段 JSON，其餘一個位元組都不動，所以樣式一致、可自行調整模板。
- 「我處理過了」勾選：`latest.html` 每筆 Issue（含「待我確認」項目）前有 checkbox；點標題連結會自動勾選（仍另開分頁），勾選後標題劃刪除線、整列淡色，可手動取消；篩選列「符合原因」群組除了全部／24h 內回應／我建立／指派給我，還有「逾期」（附筆數）：未結案、已勾「我處理過了」、且最後更新距頁面載入超過 7 天的 Issue，每筆標籤最前面會多一顆「逾期」警示標籤；勾選／取消「我處理過了」會立即重算；因為逾期的定義就是已處理，按下「逾期」按鈕時會忽略「隱藏已處理」（其他篩選下「隱藏已處理」仍會把逾期的 Issue 一起藏掉，屬預期行為）。`updated` 是不帶時區的當地時間字串，模板假設瀏覽器時區與 `timezone` 相同；另外還依 `trackLabel` 順序為每個追蹤標籤各放一顆按鈕（文字是標籤名、附命中筆數，`#data` 每筆第 6 元素 `hitLabels` 列出實際命中的標籤），每筆 Issue 的標籤也顯示命中的標籤名；篩選列的「隱藏已處理」切換與其他篩選同時生效（AND），「顯示 N / M 筆」旁會顯示「已處理 K」。狀態存在瀏覽器 `localStorage`（key `gitlab-brief:done`，值 `{ "<project path>#<iid>": { "doneAt", "seenNote" } }`），頁面每 10 分鐘重新產生也會保留；若該 Issue 之後有**非本人**的新留言（`#data` 裡的 `noteKey` 指紋變了），該筆自動回到未勾選。限制：只有 `updated_at` 在 48 小時內的 Issue 會補查留言，所以只有 48 小時內的新回應會觸發重設；本人留言不算新回應。用 `file://` 開啟時 localStorage 的作用域依瀏覽器而定，同一瀏覽器、同一路徑才共用；localStorage 不可用時退化成純顯示（勾選不保存）。
- 回前景時向本機 web server 查版本，有更新才重載；無 server 時每 60 秒：`latest.html` 載入時向 `http://127.0.0.1:3351/api/version/gitlab-issues/0` 取一次檔案 `mtime`（頁首小字會多出「· 檔案 HH:mm」）；之後分頁回到前景（`visibilitychange` 或 `focus`）且距上次檢查超過 60 秒，就再問一次版本（逾時 1.5 秒），`mtime` 變了才 `reload`，沒變就不動；問不到（server 沒開、逾時）或載入時就沒拿到版本，退回「載入超過 60 秒就 `reload`」；重載前把搜尋字、狀態／原因／專案／隱藏已處理篩選與捲動位置存進 `sessionStorage`（key `gitlab-brief:view`），載入後還原再刪掉；頁首「收集時間」旁的小字「頁面載入 HH:mm」可看出是不是新的。60 秒內重複切回不重載，sessionStorage 不可用時只是不還原，不影響勾選狀態。
- 寫檔順序：先 `briefs/<id>.md`、`<id>.html`，再 tmp+rename 連續換上 `latest.*` 與 `<日期>.*`，最後才更新 `seen.json`；任何一步失敗不更新 `seen.json`，下一輪重做。

## 常見問題

- **API 逾時／連線失敗**：每頁 30 秒逾時，失敗整輪放棄、不寫部分快照；查網路、公司 CA（`SSL_CERT_FILE`）與 `baseUrl`。超過 300 個唯一 Issue 或 512 KiB 也整輪失敗，請縮小專案或標籤範圍。
- **cron 時段外不重試**：失敗的重試若落在 `8-18` 之外，中台不補跑，等下一個排程時段；晚上沒動靜是正常的。
- **找不到 SKILL.md**：腳本依序找 `--skill` 參數 → `<work-dir>/SKILL.md` → 腳本同目錄的 `SKILL.md` → `~/.gemini/config/skills/gitlab-issue-brief/SKILL.md` → `~/.codex/skills/gitlab-issue-brief/SKILL.md` → `~/.claude/skills/gitlab-issue-brief/SKILL.md`；都沒有就在 stderr 警告並退回 `--no-llm` 規則（指派給我、未結案、最後一則留言非本人），不會失敗。
- **LLM 失敗或回傳不合法**：逾時（預設 300 秒）、不含 JSON 陣列或 ref 對不上都會在 stderr 警告並退回規則版；稿件照樣產出。
- **沒收到通知**：先 `agent-autoloop status` 看該輪是否 `done`；「没事可做」表示同內容已處理過。桌面通知不可用時直接開 `briefs/latest.html`。

官方依據：[Issues API](https://docs.gitlab.com/api/issues/)、[Projects API](https://docs.gitlab.com/api/projects/#retrieve-a-project)、[取得本人](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。
