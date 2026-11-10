# 整理與我相關的 GitLab Issue

此 recipe 定期收集指定多個專案中「指派給 userId **或** 作者是 userId **或** 含指定 label」的 Issue，聯集去重並保留符合原因；整理為本機 Markdown，再透過既有通知提醒。不建立 Issue、不改程式、不提交或推送、不留言或關閉 Issue。GitHub recipe 保持原用途。

## 啟用

1. 接單主機需 Node.js 24 以上、Codex 或 Claude Code，以及公司 GitLab 網路與可信 CA。先確認公司資料可交給所選 Agent 與中台保存。使用可讀目標專案的本人 API token，依公司政策給 `read_api` 與最低專案權限；Git SSH 登入不是 REST API 授權。
2. 將 token 由服務或秘密管理工具注入**執行收集器的接單服務環境** `GITLAB_TOKEN`，重新啟動該服務。另一個終端設定的環境不會傳入已啟動的背景服務；不要把值放進設定檔、命令參數、日誌或提示詞。Windows 可在同一 PowerShell 由秘密工具設定 `$env:GITLAB_TOKEN` 後啟動前景 `agent-autoloop up`；背景服務仍須在其啟動設定注入。POSIX 同理。
3. 將本目錄 `SKILL.md` 複製至 `~/.codex/skills/gitlab-issue-brief/`；Claude Code 使用 `~/.claude/skills/gitlab-issue-brief/`。
4. 設定／資料根為 `~/.agent-autoloop`（本機 `C:/Users/brianchung/.agent-autoloop`），rules 在此，摘要目錄由 `$autoloopHome` 下的 `work/gitlab-issues` 建立。本機三檔已複製者可略過複製，保留並編輯現有 sources。以下原始碼位置只用來取得尚未發布範例，**不是安裝目錄**：此工作區為 `C:/Users/brianchung/SynologyDrive/projects/agent-autoloop/agent-autoloop-main`，其他電腦須替換；此新版未發布／未推送，本機沒有 `.agent-autoloop/app`，不能假設已安裝版本含此範例。從家目錄執行時不能直接用 `./examples/...`，PowerShell 應先設 `$autoloopSource` 並以 `Test-Path` 檢查，再用 `Copy-Item -LiteralPath (Join-Path $autoloopSource 'examples/watch-gitlab-issues.ts') -Destination $briefWork`；可直接採用使用手冊 4.8.1 的完整安裝區塊。POSIX 相對路徑指令須在原始碼根目錄執行。建立接單主機的摘要工作目錄，例如 `~/.agent-autoloop/work/gitlab-issues`，複製本目錄 `sources.json` 與原始碼的 `examples/watch-gitlab-issues.ts` 到該目錄。此目錄只放收集器、設定與摘要，不是目標專案目錄；既有 sources 或自訂 Skill 不可直接覆蓋；同內容可略過，升級收集器先核對差異再複製。
5. 修改 `sources.json`：`baseUrl` 為公司 GitLab 根網址（若安裝在子路徑則包含子路徑），`projects` 為 1–20 個專案路徑或數字 ID 字串的陣列，例如 `["brianchung/agent-autoloop", "your-group/your-second-repo"]`，第二項須替換成實際 repo；共用 userId/label/天數/時區、合併一份摘要，無需每 repo 一個 worker。舊 `project` 單值仍相容，但兩欄同時出現會拒絕執行。`userId` 將示意數字 `12345` 換為本人 GitLab 數字 ID，`label` 換為完整單一標籤。userid 同時套用指派與作者條件，非帳號字串；可用已授權的 `GET /api/v4/user` 查本人 ID，不猜 username。label 以回傳值精確比對；拒絕逗號與保留字 `Any` / `None`（不分大小寫），避免被 API 解讀成多標籤或特殊查詢。`closedUpdatedDays` 可設 1–365 天，預設 7；`timezone` 為摘要日期與所有人看時間的顯示時區；不並列 UTC，原始快照與 API 篩選不變。
6. 將 `rules.json` 的 `sources`、`agents`、`rules` **合併**到既有 `~/.agent-autoloop/rules.json`，保留其他設定。兩個 `worker` 改成 `status` 所列的實際接單主機名，兩個 `cwd` 都改成同一摘要工作目錄的絕對路徑。Windows JSON 可用 `C:/work/gitlab-brief`，反斜線寫法則是 `C:\\work\\gitlab-brief`；POSIX 用 `/home/you/.agent-autoloop/work/gitlab-issues`。中台與接單主機均須能正確解讀路徑。`gitlab-agent.use` 可改為 `claude`。
7. 合併頂層 `timezone: "Asia/Taipei"` 前檢查對既有排程的影響；cron 預設 `*/30 * * * *`，每小時 00 與 30 分檢查一次，可依需求更改。權限：`edit`，僅為讓摘要 Agent 寫本機稿；固定收集程式的網路請求不受 Agent access 限制。Claude 對命令仍有自己的限制，見 [access 說明](../../../docs/plugins.md#access-实际能做什么)。

```powershell
agent-autoloop check
agent-autoloop rules explain
```

不需要來源 webhook adapter、GitLab webhook 或公開中台連接埠，也不需另外建立來源密鑰；排程回執由規則的 `emits` 授權。

## 手動預覽與正式排程

在已注入 token 的同一環境，切到摘要工作目錄：

```powershell
node ./watch-gitlab-issues.ts ./sources.json
```

這會真的讀 API、寫 `gitlab-inputs/<64位id>.json` 並在終端列出一個 `brief.ready` 回執；**手動列印不會送中台，也不會啟動摘要 Agent**。檢查快照的篩選、狀態、連結與符合原因；勿將公司快照貼到公開日誌。開啟接單服務後，由 cron 執行相同程式，worker 接收回執才送出事件並派給摘要 Agent。事件與快照 ID 相同，可對照 `status` 中真正的輪次再執行 `agent-autoloop why <輪次>`；不是 GitLab 網頁有 Issue 就代表中台已收到事件。

完整稿在工作目錄 `briefs/<id>.md`；核對期間/收集時間、專案清單、三類聯集原因、Issue 狀態/更新時間及來源連結；稿件先按專案再分狀態，空專案也會明列。通知沿用中台已有通道，只提醒數量與本機稿件位置；Windows 桌面通知不可用時自己查 `agent-autoloop status`，或依既有通道設定接收。此流程不改目標程式，驗收看摘要與來源，不要求建立新 Issue 或產生程式碼 diff。

## 範圍、去重與限制

- 先以 Projects API 解析各專案的 id 與名稱，路徑／數字 ID 別名只查同一專案一次；空專案也保留在摘要範圍。不自動探索所有可見 repo。每個專案分別查三個條件的所有 `opened` Issue（不限建立日），及 `updated_after` 以後的 `closed` Issue；三類聯集按 `project_id + iid` 合併，依回傳 assignees/author/labels 再核實。未結案不以近期更新過濾，避免漏掉老但仍待追蹤的項目。已結案下界是本次 UTC 日期零點往前 N 天，寫入快照；`timezone` 用於摘要日期，並非此 API 下界時區。
- 這是讀取當下現況，不是完整歷史；頁面讀取期間可能有變動，也不保證捕捉兩輪間曾開關或取消指派的每個轉換。沒有讀留言、討論、提及或參與者；本案例的「相關」只指已確認的三類，不擴大成所有參與。
- 每頁最多 100 筆，逐頁讀完，所有專案合併總計最多 100 個唯一符合 Issue / 512 KiB 完整快照（非各 repo 額度）；超限或任一專案讀取失敗時整輪失敗，不寫部分快照、不發部分事件。先縮小專案/標籤或近期已結案天數；若光未結案就超過限制，縮短天數無效，需拆成獨立工作目錄/規則。不能用建立日期切開而漏掉舊 open。
- 快照 ID 雜湊包含主機/正規化專案集合、本人/標籤、日期期間、日期範圍與排序後內容；每 30 分鐘檢查不代表每次都叫醒摘要 Agent；同日同條件同內容重跑會由中台 source + ID 去重，內容更新產生新 ID，下個摘要日期也可再次整理。專案清單排序及路徑/數字別名不影響 ID/subject。每個 ID 各存不可變快照，排隊中的兩輪不會讀錯檔。通知 key 與稿件也使用安全 ID；事件不含 token 或 Issue 正文。中台歷史被清除或來源改名會改變去重範圍。
- 摘要只說目前狀態及有依據的「待我確認」，沒有前次比較基線不稱為本期變更，不自動判定業務優先序。快照及稿件含內部資料，限制工作目錄存取；需自行訂定保留政策，勿在仍有排隊任務時刪除快照。

## 排錯與驗證界線

`check` 失敗先修 JSON/路徑/worker；它不驗 token 或公司連線。401 查 token，403 查 API scope/專案權限，404 查路徑/數字 ID 與存取權，429 依公司政策降低頻率。每頁連線/讀取 30 秒，失敗不發事件、不覆寫既有快照；不自動重試或跟隨 redirect。憑證錯誤安裝公司 CA，必要時在同一服務環境設定 `NODE_EXTRA_CA_CERTS`，不要關閉 TLS 驗證。只有本機 fixture 允許 HTTP loopback。資料不完整/欄位錯誤應查公司 GitLab 版本，不當成空清單。

無通知先看 `status` 是否有兩段輪次、`why` 的規則與回執；同日未變資料被去重屬正常。稿件缺漏時核對事件 ID 對應的快照，勿以最新檔代替。只有手動預覽而沒有 cron 派工時，不會產生 Markdown。此功能使用本機 mock API 驗證；公司版本、真 token、真 Issue 與實際 Agent 摘要仍須在部署環境驗證，未宣稱已部署成功。

官方依據：[Issues API](https://docs.gitlab.com/api/issues/)、[Projects API](https://docs.gitlab.com/api/projects/#retrieve-a-project)、[取得本人](https://docs.gitlab.com/api/users/#retrieve-the-current-user)、[REST 認證](https://docs.gitlab.com/api/rest/authentication/)。完整公司情境與可改設定見使用手冊「4.8.1 整理與我相關的 GitLab Issue」。
