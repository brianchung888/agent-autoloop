# 整理與我相關的 GitLab Issue

上班時段每 10 分鐘收集多個專案中「指派給我 / 我建立 / 含追蹤標籤」的 Issue，交給摘要 Agent 寫成本機稿件，再用既有通知提醒。產出在 `~/.agent-autoloop/work/gitlab-issues/briefs/`：`latest.md` 是依專案分「未結案 / 近期已結案」並附「待我確認」清單的 Markdown，`latest.html` 是同一份資料套進固定版面（`template.html`）的網頁版，24 小時內有回應的 Issue 會標紅。不建立、不修改、不回寫任何 Issue。

## 前置需求

- agent-autoloop 已安裝並 `agent-autoloop init` 完成，`agent-autoloop status` 看得到自己的 worker 名稱。
- Node.js 24 以上（收集器直接以 `node` 跑 `.ts`）。
- 摘要 Agent：預設用 Antigravity CLI（`agy`，ACP 模式），需先在該電腦用 `agy` 登入；改用 Codex / Claude Code 見下方。
- GitLab Personal Access Token，scope `read_api` 即可；收集器讀環境變數 **`GITLAB_TOKEN`**（見 `watch-gitlab-issues.ts` 開頭），必須注入**跑 `agent-autoloop up` 的那個環境**，另一個終端設了不會傳進去。
- 公司 GitLab 用自簽 CA 時，同一環境再設 `NODE_EXTRA_CA_CERTS=<公司 CA 的 .pem 路徑>`；不要關閉 TLS 驗證。
- 本人 GitLab 數字 ID：`GET <baseUrl>/api/v4/user` 回傳的 `id`（帶 `PRIVATE-TOKEN` header）。

## 安裝步驟

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

## 手動測試一次

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

## 運作方式

- 規則一「收集」：cron `*/10 8-18 * * *` 在 `cwd` 跑收集器，stdout 裡的 ```` ```agent-autoloop ```` 回執被 worker 解析成 `gitlab-brief` 來源的 `brief.ready` 事件（`emits` 授權）。
- 規則二「整理」：收到 `brief.ready` 就在同一 `cwd` 以 `gitlab-issue-brief` Skill 派給摘要 Agent，讀 `gitlab-inputs/<id>.json`，寫 `briefs/<id>.md`、`<id>.html`，再原子覆寫 `latest.*` 與 `<日期>.*`，最後發一則通知。
- 去重靠中台 events 表：事件 `id` 是快照內容的 sha256，同內容再收一次會被中台忽略，所以 10 分鐘一次也不會一直吵；只要任何 Issue 有變動，id 就不同，自動進新一輪。
- `template.html` 的版面是固定的；Agent 只替換 `<script id="data" type="application/json">` 那段 JSON，其餘一個位元組都不動，所以樣式一致、可自行調整模板。

## 常見問題

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

官方依據：[Issues API](https://docs.gitlab.com/api/issues/)、[Projects API](https://docs.gitlab.com/api/projects/#retrieve-a-project)、[取得本人](https://docs.gitlab.com/api/users/#retrieve-the-current-user)。更多背景見使用手冊「4.8.1 整理與我相關的 GitLab Issue」。
