# 整理與我相關的 GitLab Issue

上班時段每 10 分鐘收集多個專案中「指派給我 / 我建立 / 含追蹤標籤」的 Issue，交給摘要 Agent 寫成本機稿件，再用既有通知提醒。產出在 `~/.agent-autoloop/work/gitlab-issues/briefs/`：`latest.md` 是依專案分「未結案 / 近期已結案」並附「待我確認」清單的 Markdown，`latest.html` 是同一份資料套進固定版面（`template.html`）的網頁版，24 小時內有回應的 Issue 會標紅。不建立、不修改、不回寫任何 Issue。

## 方式 A：ACP agent + skill

### 前置需求

- agent-autoloop 已安裝並 `agent-autoloop init` 完成，`agent-autoloop status` 看得到自己的 worker 名稱。
- Node.js 24 以上（收集器直接以 `node` 跑 `.ts`）。
- 摘要 Agent：預設用 Antigravity CLI（`agy`，ACP 模式），需先在該電腦用 `agy` 登入；改用 Codex / Claude Code 見下方。
- GitLab Personal Access Token，scope `read_api` 即可；收集器讀環境變數 **`GITLAB_TOKEN`**（見 `watch-gitlab-issues.ts` 開頭），必須注入**跑 `agent-autoloop up` 的那個環境**，另一個終端設了不會傳進去。
- 公司 GitLab 用自簽 CA 時，同一環境再設 `NODE_EXTRA_CA_CERTS=<公司 CA 的 .pem 路徑>`；不要關閉 TLS 驗證。
- 本人 GitLab 數字 ID：`GET <baseUrl>/api/v4/user` 回傳的 `id`（帶 `PRIVATE-TOKEN` header）。

### 安裝步驟

本目錄五個檔案的去向：

| 檔案 | 放到 |
| --- | --- |
| `watch-gitlab-issues.ts`、`sources.json`、`template.html` | `~/.agent-autoloop/work/gitlab-issues/` |
| `SKILL.md` | Antigravity：`~/.gemini/config/skills/gitlab-issue-brief/SKILL.md`；Codex：`~/.codex/skills/gitlab-issue-brief/SKILL.md`；Claude Code：`~/.claude/skills/gitlab-issue-brief/SKILL.md` |
| `rules.json` | 把 `sources`、`agents`、`rules` 三段**併入**自己的 `~/.agent-autoloop/rules.json`（不要整檔覆蓋） |

```powershell
# Windows（PowerShell）；$recipe 指向本目錄
$work = "$HOME\.agent-autoloop\work\gitlab-issues"
New-Item -ItemType Directory -Force $work, "$HOME\.gemini\config\skills\gitlab-issue-brief" | Out-Null
Copy-Item "$recipe\watch-gitlab-issues.ts", "$recipe\sources.json", "$recipe\template.html" $work
Copy-Item "$recipe\SKILL.md" "$HOME\.gemini\config\skills\gitlab-issue-brief\SKILL.md"
```

```sh
# macOS / Linux；$recipe 指向本目錄
work=~/.agent-autoloop/work/gitlab-issues
mkdir -p "$work" ~/.gemini/config/skills/gitlab-issue-brief
cp "$recipe"/watch-gitlab-issues.ts "$recipe"/sources.json "$recipe"/template.html "$work"/
cp "$recipe"/SKILL.md ~/.gemini/config/skills/gitlab-issue-brief/SKILL.md
```

接著：

1. 編輯 `$work/sources.json`：`baseUrl` 填公司 GitLab 根網址；`projects` 填 1–20 個專案路徑或數字 ID；`userId` 填本人數字 ID；`label` 填一個完整標籤（不能含逗號，不能是 `Any`/`None`）；`closedUpdatedDays` 是「近期已結案」回看天數（1–365）；`timezone` 是稿件顯示時區。
2. 把 `rules.json` 併入 `~/.agent-autoloop/rules.json`：兩個 agent 的 `worker` 由 `my-pc` 改成 `agent-autoloop status` 列出的自己的 worker 名稱；`cwd` 可保留 `~/...` 寫法，或改成絕對路徑（Windows JSON 用 `C:/Users/you/...` 或 `C:\\Users\\you\\...`）。頂層 `timezone` 若已有就不要重複。
3. 想用 Codex 當摘要 Agent：`gitlab-agent` 改成 `"use": "codex"`，把 `command` 與 `model` 兩行刪掉，`access` 保持 `edit`；Claude Code 則 `"use": "claude"`。SKILL.md 要放到對應 CLI 的 skills 目錄。
4. `agent-autoloop check`，再 `agent-autoloop rules explain` 看兩條規則都被認得。
5. 正常運作**不需要**建立 `gitlab-brief` 來源金鑰：收集器的回執由規則的 `emits` 授權。只有要手動強制重跑（見常見問題）才需要 `agent-autoloop key new source gitlab-brief`。

權限：`edit`，只為了讓摘要 Agent 寫 `briefs/` 下的稿件；Skill 本身禁止改目標程式或回寫 GitLab。收集器是固定程式，連網不受 `access` 限制。

### 手動測試一次

在已注入 `GITLAB_TOKEN`（與必要的 `NODE_EXTRA_CA_CERTS`）的同一個終端：

```powershell
# Windows
cd "$HOME\.agent-autoloop\work\gitlab-issues"; node .\watch-gitlab-issues.ts .\sources.json
```

```sh
# macOS / Linux
cd ~/.agent-autoloop/work/gitlab-issues && node ./watch-gitlab-issues.ts ./sources.json
```

成功時終端印出「GitLab 個人 Issue 資料已完整讀取」與一段 `brief.ready` 回執，並在 `gitlab-inputs/<64 位 id>.json` 留下快照；打開看 `issues[]` 的 `reasons`、`state`、`web_url` 是否合理。手動跑**不會**送事件給中台、也不會叫醒摘要 Agent，那要靠 `agent-autoloop up` 之後的 cron。401 查 token、403 查 scope 與專案權限、404 查專案路徑。

### 運作方式

- 規則一「收集」：cron `*/10 8-18 * * *` 在 `cwd` 跑收集器，stdout 裡的 ```` ```agent-autoloop ```` 回執被 worker 解析成 `gitlab-brief` 來源的 `brief.ready` 事件（`emits` 授權）。
- 規則二「整理」：收到 `brief.ready` 就在同一 `cwd` 以 `gitlab-issue-brief` Skill 派給摘要 Agent，讀 `gitlab-inputs/<id>.json`，寫 `briefs/<id>.md`、`<id>.html`，再原子覆寫 `latest.*` 與 `<日期>.*`，最後發一則通知。
- 24 小時內回應標記（HTML `R` 紅標、Markdown `🆕`、待我確認 `NEW`）只有真正留言才算回應，且最後留言者非本人：收集器對 `updated_at` 在 48 小時內的 Issue 多查一次 Notes API，把最後一則人寫留言的作者與時間寫進快照 `last_note`；`last_note.created_at` 在收集時間 24 小時內且 `last_note.author_id !== userId` 才標，`last_note` 為 `null` 或缺欄位（沒有留言、或超過 48 小時未查）一律不標。`updated_at` 只用於排序與顯示。
- 去重靠中台 events 表：事件 `id` 是快照內容的 sha256，同內容再收一次會被中台忽略，所以 10 分鐘一次也不會一直吵；只要任何 Issue 有變動，id 就不同，自動進新一輪。
- `template.html` 的版面是固定的；Agent 只替換 `<script id="data" type="application/json">` 那段 JSON，其餘一個位元組都不動，所以樣式一致、可自行調整模板。

### 常見問題

- **API 逾時／連線失敗**：每頁 30 秒逾時，失敗整輪放棄、不寫部分快照；查網路、公司 CA（`NODE_EXTRA_CA_CERTS`）與 `baseUrl`。超過 100 個唯一 Issue 或 512 KiB 也整輪失敗，請縮小專案或標籤範圍。
- **cron 時段外不重試**：收集失敗的重試若落在 `8-18` 之外，中台不補跑，等下一個排程時段；晚上沒動靜是正常的。
- **ACP 空回應**：Antigravity 偶爾回空的 end_turn，worker 會在同一會話再問一次，第二次仍空才算失敗；`agent-autoloop status` 看到同一輪問兩次不是錯。
- **想強制重建摘要**（內容沒變但改了 Skill 或模板）：刪 `briefs/` 無效，去重在中台不在本機。正規做法：
  1. `agent-autoloop key new source gitlab-brief` 取得來源金鑰（只顯示一次）。
  2. 複製 `gitlab-inputs/` 最新快照成新檔，檔名與內容 `id` 欄都換成一個新的隨機 64 位小寫十六進位。
  3. `agent-autoloop emit brief.ready --key <金鑰> --id <新 id> --subject <既有 subject>`；subject 取前一次收集器輸出的 `subject`（`gitlab-…`）。
  4. 看 `agent-autoloop status` 出現新一輪「整理個人相關 GitLab Issue」且 `done`，`briefs/latest.html` 的時間已更新。
  不要用 `local` 來源金鑰 emit，規則只收 `gitlab-brief`。
- **沒收到通知**：先 `agent-autoloop status` 看是否有「收集」與「整理」兩段；只有收集沒有整理多半是同內容被去重。桌面通知不可用時直接開 `briefs/latest.html`。

## 方式 B：Python 腳本版（不需要 ACP agent 與 skill）

`gitlab_issues.py` 把方式 A 的「收集 → 快照 → 摘要（MD/HTML）→ 通知回執」整條流程固化成一支腳本，由本機程式碼決定分組、排序、24 小時判定與寫檔，LLM 只負責從未結案 Issue 原文挑出「待我確認」候選（一次呼叫，失敗自動退回本機規則）。快照格式、`briefs/` 檔名與 `template.html` 版面都與方式 A 相同，兩種方式可以互換。

### 適用情境

- 只想要確定性的產出：同一份快照每次跑出一樣的稿件，不希望摘要 Agent 的措辭或分組每輪不同。
- 不想跑 ACP：這台電腦沒有 `agy`，或不想讓 Agent 以 `edit` 權限在工作目錄裡自由寫檔。
- 想把 LLM 用量降到最低：每輪最多一次便宜模型呼叫（預設 `claude-haiku-4-5-20251001`），或加 `--no-llm` 完全不呼叫。

### 需求

- Python 3.12（只用標準庫：`urllib`、`zoneinfo`，不需要 `pip install`）。
- 環境變數 **`GITLAB_TOKEN`**（scope `read_api`），同樣必須注入跑 `agent-autoloop up` 的那個環境；公司自簽 CA 改設 `SSL_CERT_FILE` 或 `GITLAB_CA_FILE` 指向 `.pem`。
- 「待我確認」要用 LLM 時：`claude`、`codex`、`agy` 三個 CLI 其一已在這台電腦登入（`--backend claude|codex|antigravity`，預設 `claude`）；不想用 LLM 就加 `--no-llm`，改用本機規則（指派給我、未結案、最後一則留言非本人）。
- `SKILL.md` 仍要在 `~/.gemini/config/skills/gitlab-issue-brief/SKILL.md`：腳本執行時從裡面讀出含「待我確認」的段落當 LLM 的 system prompt，不另外複製一份規則；`--no-llm` 時不需要。
- 本目錄的 `agentrunner/` 是 `agentrunner_chat.py` 依賴的套件副本（只含 `.py`，已排除 `__pycache__`），驅動 Claude / Codex / Antigravity CLI；請整個目錄跟著複製，`--no-llm` 時可以不帶。

### 安裝

把 `gitlab_issues.py`、`agentrunner_chat.py`、`agentrunner/`、`sources.json`、`template.html` 複製到工作目錄（預設 `~/.agent-autoloop/work/gitlab-issues`），或任何目錄再用 `--work-dir` 指定；`sources.json` 的填法與方式 A 第 1 步相同。

```powershell
# Windows（PowerShell）；$recipe 指向本目錄
$work = "$HOME\.agent-autoloop\work\gitlab-issues"
New-Item -ItemType Directory -Force $work, "$HOME\.gemini\config\skills\gitlab-issue-brief" | Out-Null
Copy-Item "$recipe\gitlab_issues.py", "$recipe\agentrunner_chat.py", "$recipe\sources.json", "$recipe\template.html" $work
Copy-Item -Recurse -Force "$recipe\agentrunner" "$work\agentrunner"
Copy-Item "$recipe\SKILL.md" "$HOME\.gemini\config\skills\gitlab-issue-brief\SKILL.md"
```

```sh
# macOS / Linux；$recipe 指向本目錄
work=~/.agent-autoloop/work/gitlab-issues
mkdir -p "$work" ~/.gemini/config/skills/gitlab-issue-brief
cp "$recipe"/gitlab_issues.py "$recipe"/agentrunner_chat.py "$recipe"/sources.json "$recipe"/template.html "$work"/
cp -R "$recipe"/agentrunner "$work"/agentrunner
cp "$recipe"/SKILL.md ~/.gemini/config/skills/gitlab-issue-brief/SKILL.md
```

### 手動跑一次

在已注入 `GITLAB_TOKEN` 的終端，先 `--dry-run` 看收集結果（只寫快照，不叫 LLM、不寫 `briefs/`）：

```sh
cd ~/.agent-autoloop/work/gitlab-issues
python gitlab_issues.py --dry-run
```

成功時 stdout 第一行是「做完了（dry-run）：快照 <id>，未結案 N 筆、近期已結案 M 筆」，再列各專案統計與規則版待我確認候選數。接著正式跑：

```sh
python gitlab_issues.py                 # 待我確認用 LLM（預設 claude haiku）
python gitlab_issues.py --no-llm        # 不叫 LLM，待我確認改用本機規則
python gitlab_issues.py --backend codex --model gpt-5.3-codex
python gitlab_issues.py --work-dir D:/x --model claude-haiku-4-5-20251001 --effort low --timeout 300
```

stdout 第一行是結論（`做完了：…`、`没事可做：快照 <id> 已處理`、`没跑成：<原因>` 並 exit 1），其餘進度訊息走 stderr。做完後 `briefs/latest.md`、`latest.html`、`<id>.md/.html`、`<日期>.md/.html` 都在，與方式 A 一樣。

### 接進 agent-autoloop：一條 command rule

只要一條 command rule，不需要 `emits`、不需要 `gitlab-agent`、不需要在規則裡指定 skill：

```json
{
  "agents": {
    "gitlab-py": {
      "name": "GitLab Issue 摘要（Python）",
      "worker": "my-pc",
      "use": "command",
      "command": ["python", "{cwd}/gitlab_issues.py", "--autoloop"]
    }
  },
  "rules": [
    {
      "name": "GitLab 個人 Issue 摘要",
      "when": { "cron": "*/10 8-18 * * *" },
      "to": "gitlab-py",
      "cwd": "~/.agent-autoloop/work/gitlab-issues",
      "tell": "needed"
    }
  ]
}
```

`worker` 改成 `agent-autoloop status` 列出的自己的 worker 名稱。`--autoloop` 讓腳本在結尾加印 ```` ```agent-autoloop ```` 回執區塊，worker 解析後送出 `key=gitlab-brief-<id>`、`fyi=true` 的 notice；同一快照只發一次。`--no-llm` 可以直接加在 `command` 陣列裡。

### 與方式 A 的差異

| | 方式 A：ACP agent + skill | 方式 B：Python 腳本版 |
| --- | --- | --- |
| 規則數 | 兩條（收集 `emits` → 整理 `skill`） | 一條 command rule |
| LLM 次數 | 每輪一次完整 Agent 會話（讀快照、寫稿、多輪工具呼叫） | 每輪最多一次單輪呼叫，只挑「待我確認」；`--no-llm` 零次 |
| 耗時 | 數分鐘（視 Agent 與模型） | 收集秒級；LLM 一次約數十秒 |
| 產出穩定性 | 分組、排序、措辭由 Agent 依 SKILL.md 產生 | 分組、排序、24h 判定、寫檔全由腳本決定，LLM 輸出經本機驗證 |
| 去重機制 | 中台 events 表（事件 `id` = 快照 sha256） | 本機 `briefs/seen.json` 記錄已處理 id |
| 強制重跑 | 需 `gitlab-brief` 來源金鑰、改快照 id、`agent-autoloop emit`（見方式 A 常見問題） | 刪 `briefs/seen.json` 中的該 id，或加 `--force` |
| 需要 `agy`/ACP | 是 | 否（`claude`/`codex`/`agy` CLI 其一，或 `--no-llm`） |
| Agent 權限 | `edit` | 無 Agent；腳本以 command 執行 |

官方依據：[Issues API](https://docs.gitlab.com/api/issues/)、[Projects API](https://docs.gitlab.com/api/projects/#retrieve-a-project)、[取得本人](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。更多背景見使用手冊「4.8.1 整理與我相關的 GitLab Issue」。
