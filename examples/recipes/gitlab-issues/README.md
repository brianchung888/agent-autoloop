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

把本目錄**全部檔案**複製到工作目錄（預設 `~/.agent-autoloop/work/gitlab-issues`，也可任何目錄再用 `--work-dir` 指定）。`agentrunner/` 是 `agentrunner_chat.py` 依賴的套件副本，驅動 Claude / Codex / Antigravity CLI；`SKILL.md` 是「待我確認」的規則，腳本執行時從裡面讀出含「待我確認」的段落當 LLM 的 system prompt（尋找順序見常見問題）。

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

接著編輯 `$work/sources.json`：`baseUrl` 填公司 GitLab 根網址；`projects` 填 1–20 個專案路徑或數字 ID；`userId` 填本人數字 ID；`label` 填一個完整標籤（不能含逗號，不能是 `Any`/`None`）；`closedUpdatedDays` 是「近期已結案」回看天數（1–365）；`timezone` 是稿件顯示時區（IANA，例如 `Asia/Taipei`）。

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

- 收集：每個專案 × {opened, closed} × {assignee, author, label} 三種查詢聯集、分頁、每頁 30 秒逾時、不跟隨重導向；closed 只取 `updatedAfter`（UTC 日界 − `closedUpdatedDays`）之後更新的。快照 `gitlab-inputs/<id>.json` 的 `id` 是內容的 sha256，已存在不覆寫。
- 去重：`briefs/seen.json` 記錄已處理的快照 id；同一 id 且 `<id>.md/.html` 都在就「没事可做」，所以 10 分鐘一次也不會一直吵；任何 Issue 有變動 id 就不同，自動進新一輪。同一快照的 notice 只發一次。
- 強制重跑（內容沒變但改了 SKILL.md 或模板）：加 `--force`，或刪掉 `briefs/seen.json` 裡的該 id。
- 24 小時內回應標記（HTML `R` 紅標、Markdown `🆕`、待我確認 `NEW`）只看真正的留言，且最後留言者非本人：腳本對 `updated_at` 在 48 小時內的 Issue 多查一次 Notes API，把最後一則人寫留言的作者與時間寫進快照 `last_note`；`last_note.created_at` 在收集時間 24 小時內且 `last_note.author_id != userId` 才標，`last_note` 為 `null` 或缺欄位（沒有留言、或超過 48 小時未查）一律不標。`updated_at` 只用於排序與顯示。
- `template.html` 的版面是固定的；腳本只替換 `<script id="data" type="application/json">` 那段 JSON，其餘一個位元組都不動，所以樣式一致、可自行調整模板。
- 「我處理過了」勾選：`latest.html` 每筆 Issue（含「待我確認」項目）前有 checkbox；點標題連結會自動勾選（仍另開分頁），勾選後標題劃刪除線、整列淡色，可手動取消；篩選列的「隱藏已處理」切換與其他篩選同時生效（AND），「顯示 N / M 筆」旁會顯示「已處理 K」。狀態存在瀏覽器 `localStorage`（key `gitlab-brief:done`，值 `{ "<project path>#<iid>": { "doneAt", "seenNote" } }`），頁面每 10 分鐘重新產生也會保留；若該 Issue 之後有**非本人**的新留言（`#data` 裡的 `noteKey` 指紋變了），該筆自動回到未勾選。限制：只有 `updated_at` 在 48 小時內的 Issue 會補查留言，所以只有 48 小時內的新回應會觸發重設；本人留言不算新回應。用 `file://` 開啟時 localStorage 的作用域依瀏覽器而定，同一瀏覽器、同一路徑才共用；localStorage 不可用時退化成純顯示（勾選不保存）。
- 分頁回前景自動重載：`latest.html` 載入超過 60 秒後，分頁再回到前景（`visibilitychange` 或 `focus`）就自動 `reload` 拿最新產出；重載前把搜尋字、狀態／原因／專案／隱藏已處理篩選與捲動位置存進 `sessionStorage`（key `gitlab-brief:view`），載入後還原再刪掉；頁首「收集時間」旁的小字「頁面載入 HH:mm」可看出是不是新的。60 秒內重複切回不重載，sessionStorage 不可用時只是不還原，不影響勾選狀態。
- 寫檔順序：先 `briefs/<id>.md`、`<id>.html`，再 tmp+rename 連續換上 `latest.*` 與 `<日期>.*`，最後才更新 `seen.json`；任何一步失敗不更新 `seen.json`，下一輪重做。

## 常見問題

- **API 逾時／連線失敗**：每頁 30 秒逾時，失敗整輪放棄、不寫部分快照；查網路、公司 CA（`SSL_CERT_FILE`）與 `baseUrl`。超過 100 個唯一 Issue 或 512 KiB 也整輪失敗，請縮小專案或標籤範圍。
- **cron 時段外不重試**：失敗的重試若落在 `8-18` 之外，中台不補跑，等下一個排程時段；晚上沒動靜是正常的。
- **找不到 SKILL.md**：腳本依序找 `--skill` 參數 → `<work-dir>/SKILL.md` → 腳本同目錄的 `SKILL.md` → `~/.gemini/config/skills/gitlab-issue-brief/SKILL.md` → `~/.codex/skills/gitlab-issue-brief/SKILL.md` → `~/.claude/skills/gitlab-issue-brief/SKILL.md`；都沒有就在 stderr 警告並退回 `--no-llm` 規則（指派給我、未結案、最後一則留言非本人），不會失敗。
- **LLM 失敗或回傳不合法**：逾時（預設 300 秒）、不含 JSON 陣列或 ref 對不上都會在 stderr 警告並退回規則版；稿件照樣產出。
- **沒收到通知**：先 `agent-autoloop status` 看該輪是否 `done`；「没事可做」表示同內容已處理過。桌面通知不可用時直接開 `briefs/latest.html`。

官方依據：[Issues API](https://docs.gitlab.com/api/issues/)、[Projects API](https://docs.gitlab.com/api/projects/#retrieve-a-project)、[取得本人](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。
