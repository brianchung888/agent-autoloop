# Agent Autoloop

**讓你的命令列 Agent 在背景自己接手工作、自己追蹤到底；平時不煩你，遇到無法確定的事才發卡片找你決定。**

**正體中文** | [简体中文](README.zh-CN.md) | [English](README.en.md)

[上手](#上手) · [情境範本](#拿來即用的情境範本) · [外掛](#外掛體系四個方向都能自由替換) · [核心](#核心的四個機制) · [文件](#更多文件)

![架構圖](docs/architecture.svg)

## 它解決什麼問題？

平時我們用 Claude Code、Codex 這類命令列 Agent，大多是「人守著終端機操作」：你輸入一句話，盯著它跑，等它問你下一步；一旦關掉視窗或者人走開，事情就斷了。

**Agent Autoloop** 是一個極輕量的自動化中台。它把任務排程做成一個零外部相依套件的**核心**，把事件來源、Agent、通知通道，甚至程式碼上線流程全部拆成可隨時插拔的**外掛**。

- **一台電腦、一條命令就能跑。** 裝在你的 Mac 或 Linux 上，不用買雲端伺服器，也不用開放對外連接埠。
- **一行設定接新 Agent。** 不需要 SDK，也不需要改 Agent 原始碼，能接收提示詞並輸出最後一則回覆的命令列工具都能接。
- **沒有後台管理介面。** 需要你決定時把卡片推到飛書、釘釘、企微、Slack、Discord 或桌面通知；想看整體進度，敲一行命令。

## 上手

支援 macOS、Linux 和 Windows 11。執行前需要裝好 Node 24、Git（macOS / Linux 還要 curl，Windows 用 PowerShell 自帶的 irm），以及任意一個你已經登入好的命令列 Agent，不需要 GitHub 帳號。也可以直接把[安裝說明](INSTALL.md)丟給你的 Agent，讓它替你裝好。介面預設正體中文，可用 `agent-autoloop lang zh-CN` 或 `AGENT_AUTOLOOP_LANG` 切換簡體。

> **Windows：原生支援，不需要 WSL2。** 用 PowerShell 裝，不要管理員權限：`irm https://raw.githubusercontent.com/brianchung888/agent-autoloop/main/install.ps1 | iex`。有四處降級：桌面通知一律跳過（卡片還在 `agent-autoloop status` 和別的通道裡）；常駐用的是排程工作，停了之後最多等 5 分鐘才自己回來；檔案權限用 `icacls` 鎖到目前使用者，鎖不上（網路磁碟、FAT32、網域原則）不攔著啟動，`agent-autoloop doctor` 會報一條降級；Agent 得是真正的執行檔，npm 裝的 `.cmd` 包裝指令碼起不了。細節見 [INSTALL](INSTALL.md)。

```bash
curl -fsSL https://raw.githubusercontent.com/brianchung888/agent-autoloop/main/install.sh | sh
```

安裝和 `agent-autoloop update` 都裝最新的 [Release](https://github.com/brianchung888/agent-autoloop/releases)，那是通過全部檢查的版本。

> **不想裝 Node？** 每個 Release 還附一個單一執行檔，三個平台各一個，旁邊各有一份 `.sha256`：下載、核對雜湊值、`agent-autoloop init`，沒有別的前置。代價是下載約 96 MB（裡面就是一整個 Node）、Windows 上沒有簽章所以 SmartScreen 會先攔一下，而且第三方 `.ts` 外掛要帶 `runtime: "process"`。原始碼安裝仍然是預設方式；兩種裝法共用同一個資料目錄，可以來回換。細節見 [INSTALL 的單一執行檔一節](INSTALL.md#单一二进位这台电脑上没有-node)。

裝好後用你本機的 Agent 真實走一遍「提問 → 退出等回覆 → 決定 → 接著完成」：

```bash
agent-autoloop try
```

以下為終端機輸出範例（文字已轉為正體中文）：

```text
事件發出去了，Agent 開始工作……

Agent 結束了這一輪，問了你一個問題。它現在不佔用行程、不花 Token。

【等你決定】#1 試跑：選一個顏色
這是一次試跑，選哪個都行。
  1. 藍色
  2. 綠色
回答：agent-autoloop answer 1 <序號>
答完執行 agent-autoloop status，能看到它接著把工作完成。
```

互動終端機裡直接輸入數字按 Enter；非互動終端機執行 `agent-autoloop answer 1 2` 選擇「綠色」。再跑 `agent-autoloop status`，就能看到它接上剛才的工作階段並顯示「你選了綠色，試跑通過」，還有今天和最近 7 天的輪數、Token 和費用（[統計方式](skills/agent-autoloop/SKILL.md#看情况回答)）。

## 一件事怎麼轉起來

編號和上面的架構圖一一對應：

1. **新事件進來。** 早上 9 點的排程工作、GitHub 上新提的 Issue、業務系統報的錯，都變成一條標準事件送進核心。
2. **按規則派工。** 核心照你寫的規則，決定交給哪個 Agent、在哪個目錄工作。同一件事排隊時又來的訊息，會合併成一輪處理。
3. **完成一輪就退出。** Agent 把結果寫在最後一條回覆裡，行程直接結束。
4. **無法確定才問你。** 碰到刪資料、重新啟動服務、花錢、對外發訊息這類事，核心透過飛書或桌面通知發一張卡片給你。等你回覆期間，它不佔用背景行程，也不消耗 Token。
5. **點一下，繼續工作。** 你選完，它接上原來的對話，把剩下的工作完成。

能自己搞定的事走圖上方的自動閉環：直接辦完，或者約個時間（比如半小時後）再醒來複查，全程不打擾你。

## 日常怎麼配？

### 寫一份規則（`rules.json`）

不需要寫銜接程式碼。開啟 `~/.agent-autoloop/rules.json`，在 `rules` 裡寫清楚**什麼事、交給誰、在哪個目錄工作**。`to` 填 `agents` 裡已有的名字。比如每天早上 9 點寫早報：

```json
{
  "name": "早報",
  "when": { "cron": "0 9 * * *" },
  "to": "codex",
  "cwd": "~/notes",
  "prompt": "整理昨天的筆記和提交，寫今天的早報。"
}
```

外部事件寫法一樣，只是要先接好來源。比如有人提新 Issue 時交給 Codex，先按[說明](skills/agent-autoloop/SKILL.md#接一个事件插件)在 `sources` 裡登記 `github`：

```json
{
  "name": "處理 issue",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

儲存後幾秒內自動生效，可以執行 `agent-autoloop check` 檢查；`agent-autoloop rules explain` 看生效的規則和下次排程時間，`agent-autoloop emit <類型> --dry-run` 預演一條事件會派給誰（不連線中台、不寫日誌）。就算改錯了，或者檔案被刪、讀不到，系統也會繼續按舊規則跑，並發送卡片提醒你。

### Agent 怎麼跟中台配合？

中台對 Agent 只有一個約定：**在最後一條回覆裡交代結果**。事情辦完了，正常輸出一句結論就行。需要向你請示時，在回覆末尾附一段 `agent-autoloop` 程式碼區塊：

````text
訂單已經核對完畢，庫存充足。

```agent-autoloop
{
  "ask": [{
    "title": "要怎麼出貨？",
    "text": "兩種方式今天都能發出。",
    "options": ["宅配", "自取"],
    "key": "shipping"
  }]
}
```
````

除了提問（`ask`），還能發通知（`notice`）、關閉已解決的卡片（`resolve`）、預約複查（`later`）和觸發新事件（`events`）。通告不需要回答，但結案時可以順手寫一句處理說明，這句話會留在卡片上；只是告訴一聲的通告標成 `fyi`，不帶按鈕。萬一 JSON 寫錯了，中台只讓它在原工作階段裡重寫最後這段回覆，不會把已經完成的業務重做一遍；重寫也失敗時，保留原結論並通知你回條沒有生效（通用命令沒有工作階段，直接走這一步）。接著舊工作階段跑也一樣：工作階段接不上才開新的；接上了、工作到一半斷了，就算沒跑成，過幾分鐘回到原工作階段重試，不開新工作階段重做。同一事項的新事件預設開新工作階段；規則寫 `"resume": true` 就接著上一輪的工作階段。

## 拿來即用的情境範本

每套範本都帶規則、任務 Skill 和啟用說明。

| 想做什麼 | 已經封裝好的流程 |
|---|---|
| [每日早報](examples/recipes/morning-brief/README.md) | 預設每天 8 點整理本機筆記和 Git 提交，寫入 `briefs/YYYY-MM-DD.md` |
| [跟進 GitHub Issue](examples/recipes/github-issues/README.md) | 每 5 分鐘查新 Issue，在本機改程式碼並通知你檢視；不提交、不推送、不回覆 Issue |
| [整理個人相關 GitLab Issue](examples/recipes/gitlab-issues/README.md) | 多 repo 的指派給我／我建立／指定標籤聯集；合併本機摘要並通知 |
| [線上告警排查](examples/recipes/ops-alerts/README.md) | 接收報錯、對照程式碼查原因，需要重新啟動時發卡片詢問，回答後繼續 |
| [使用者回饋處理](examples/recipes/feedback/README.md) | 重新讀取回饋目前狀態、修復、交付核實、準備回覆；需要決定時飛書問你，回答後繼續 |
| [網站巡檢](examples/recipes/website-watch/README.md) | 每 5 分鐘檢查狀態和關鍵內容，首次異常交給 Agent，持續異常不重複通知，恢復後更新原卡片 |
| [飛書週報與業務摘要](examples/recipes/feishu-brief/README.md) | 週日 18 點按你的權限讀彙報和指定表格，產生本機摘要；飛書只發簡短摘要，完整稿留在本機 |
| [PR 自動交付](skills/agent-autoloop/SKILL.md#交付流水线) | 打上 `deliver` 標籤後，審查、等 CI、合併、等發布並核對線上版本 |

**啟用：** 開啟對應說明，把任務 Skill 放進所用 Agent 的 skills 目錄，把範例規則合入 `~/.agent-autoloop/rules.json`，替換電腦名和路徑，再執行 `agent-autoloop check`。

回饋處理、網站巡檢和飛書摘要預設使用北京時間，只發給本人的飛書私人對話。範例資料都是虛構的；指令碼和回條只用本機 HTTP 與假飛書 CLI 驗證過，沒有在真實帳號上跑過完整業務。

更多範本：[Claude 委託 Codex 處理網頁](examples/recipes/browser-handoff/README.md)、[每週程式碼清理](examples/skills/weekly-sweep/SKILL.md)、[交付 PR](examples/skills/ship-pr/SKILL.md)。

## 外掛體系：四個方向都能自由替換

內建外掛隨程式安裝，填好設定即可啟用；第三方外掛用 `agent-autoloop add <Git 位址>` 安裝。

| 方向 | 內建 | 設定 |
|---|---|---|
| **事件**：怎麼發現新工作 | [GitHub Webhook](plugins/github/source.ts)、[GitLab Webhook](plugins/gitlab/source.ts)、[HTTP 介面](docs/protocol.md#来源把世界变成事件)、[排程規則](skills/agent-autoloop/SKILL.md#改规则)、[Issue 輪詢指令碼](examples/watch-github-issues.sh) | [說明](skills/agent-autoloop/SKILL.md#接一个事件插件) |
| **Agent**：誰來工作 | [Claude Code](plugins/claude/agent.ts)、[Codex](plugins/codex/agent.ts)、[ACP](plugins/acp/agent.ts)、[DeepSeek Harness](plugins/dsh/agent.ts)、[通用命令](plugins/command/agent.ts) | [說明](skills/agent-autoloop/SKILL.md#接一个-agent) |
| **通道**：去哪找你決定 | [桌面通知](plugins/desktop/channel.ts)（預設開啟）、[飛書](plugins/feishu/channel.ts)、[釘釘 / 企微 / Slack / Discord](plugins/webhook/templates.ts) | [說明](skills/agent-autoloop/SKILL.md#接一个通道) |
| **交付**：把 CI/CD 也做成外掛 | [`delivery`](plugins/delivery/delivery.ts) | [說明](skills/agent-autoloop/SKILL.md#交付流水线) |

**實測情況：** Claude Code、Codex 和 ACP（官方 Codex ACP 轉接器）跑通了多輪問答和跨行程工作階段延續；飛書跑通了傳送、按鈕回呼和卡片更新；四種 Webhook 範本只在本機模擬服務上驗證過，GitLab Webhook 按官方文件的格式測試，沒連過真實 GitLab。這些文字通道靠回答連結決定，要把 `hub.publicUrl` 配成手機或電腦能開啟的地址。

**其他命令列 Agent 一行接入。** 設定 `use: "command"` 並傳入命令陣列，`{prompt}` 作為獨立參數傳遞，不會被當成 shell 程式碼執行。下面的命令整理自各家官方文件，我們還沒有逐個跑過：

| Agent | 接入命令 |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) 舊版（內建外掛要 0.2.2 或更新） | `dsh --profile headless {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -Q -q {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |

**交付流程。** 給 GitHub PR 打上 `deliver` 標籤後，它會自己跟進到上線：**審程式碼 → 等 CI → 合併 PR → 等部署 → 核對線上版本**。審查和交付設定只從 `main` 讀取，絕不在執行工作的電腦上簽出或執行 PR 裡的程式碼；排隊、併發和重試直接重用核心。

**寫自己的外掛。** 從 [Agent](examples/plugins/hello-agent/agent.ts)、[通道](examples/plugins/hello-channel/channel.ts)、[事件](examples/plugins/hello-source/source.ts) 三個可執行的最小範本開始，見[外掛開發說明](docs/plugins.md)。要讓 Agent 操作網頁，先看[瀏覽器接入](docs/plugins.md#浏览器接入)。命令列和 [MCP](skills/agent-autoloop/SKILL.md#mcp-与密钥撤销) 也能檢視和回答卡片。

## 核心的四個機制

核心約 1650 行程式碼、零執行階段相依套件。它不讀系統時鐘、不用隨機數、不向外發請求，外掛主動連進來，帳號憑據留在各自的外掛裡；同樣的輸入永遠得出同樣的結果。它把四個電腦領域的成熟做法用到了命令列 Agent 上：

- **等待零消耗**：等你決定時行程直接結束，等待狀態存在資料庫裡，Agent 不用一直掛著。你三天沒回，這三天就沒有 Agent 行程在執行、不花 Token，只有很輕的中台在背景等著；你一回答，它接著原來的對話繼續工作。
- **事件溯源**：所有狀態都從一條只追加的日誌算出來，日誌和索引在同一筆交易裡寫入磁碟，寫完才應答。行程被強制終止，已經確認的事不丟（整台電腦斷電沒有單獨測過）；任何一輪為什麼跑、結果是什麼，一條命令就能查清；資料格式變了就從日誌重建，不用寫遷移指令碼。
- **指令與資料分離**：思路和 SQL 參數化一樣。Issue 的標題和正文等外部文字只作為資料放進檔案，不拼進提示詞，提示詞裡只有驗證過字元的類型、編號和連結；用哪個 Agent、在哪個目錄、什麼權限，只由你本機的規則決定，事件裡帶 `cwd`、`agent`、`access` 欄位會被直接拒收。
- **跳數熔斷**：思路和網路封包的 TTL 一樣。Agent 交回的事件會再派給 Agent，層數一路累加，經過人工提問和排程複查也不清零，Agent 自己改不了；超過 8 層就只記錄、不再派工，並發送一張卡片告訴你。

### 自己跑一遍

在程式目錄 `~/.agent-autoloop/app` 下執行：

| 驗證什麼 | 命令 |
|---|---|
| 任何一輪的來龍去脈 | `agent-autoloop why 1` |
| 20 萬步模擬斷網、封包遺失、崩潰和重複提交，一個種子就能重現 | `node sim/random.ts 24301 200000` |
| 強制終止行程 1000 次，已確認的記錄一條不丟 | `node sim/crash.ts 1000 12648430` |
| 下面的效能數字 | `npm run benchmark` |

```text
第 1 輪 · 示範
11-03 20:47:25  規則版本 #1
11-03 20:47:25  觸發事件：來源 local · 類型 demo.start · 對象 example
11-03 20:47:25  local 領取（示範程式）
11-03 20:47:25  結束：示範完成
```

### 實測效能

Apple M5 Pro、24 GB、Node 24.21.0。寫入逐條提交，交易寫入磁碟後才回應。

| 指標 | 實測 |
|---|---:|
| 冷啟動 | 88.78 ms |
| 閒置記憶體 | 59.94 MB RSS |
| 1000 個同時等待的長輪詢 | 170.49 MB RSS |
| 持久化寫入 | 2394 條/秒 |
| 派工 p99 | 1.82 ms |
| 排隊 5000 時被擋下的心跳 p99 | 1.66 ms |
| 110 萬條事實時的啟動 | 99.8 ms |
| 核心行數（含空行和註解） | 約 1650 |
| 執行階段相依套件 | 0 |

歷史變大後，狀態彙總會變慢，日誌和索引也繼續佔磁碟；格式變化後的首次啟動要從日誌全量重建，110 萬條用時 43.1 秒。[完整資料和測法](docs/protocol.md#历史增长实测)。

## 用量與合規說明

中台直接呼叫你本機已經安裝並登入好的命令列工具，不會讀取或轉存你的帳號憑據。模型呼叫消耗算在你自己的帳號名下，額度和使用範圍遵循各家模型廠商的服務條款。

在高頻自動化情境下，各家廠商通常更建議使用 API Key（個人訂閱額度主要是為日常人工互動設計的，詳見 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 與 [OpenAI](https://learn.chatgpt.com/docs/auth) 的官方說明）。如果你用它對外提供服務，請使用 API Key。本專案為獨立開源專案，與上述廠商無隸屬或背書關係。

## 更多文件

- [安裝說明](INSTALL.md)
- [繁體中文使用手冊](docs/使用手冊.md)
- [規則與交付流程設定手冊](skills/agent-autoloop/SKILL.md)
- [如何編寫外掛](docs/plugins.md)
- [完整通訊協定](docs/protocol.md)
- [安全邊界說明](SECURITY.md)
- [參與貢獻與交流](CONTRIBUTING.md)
- [專案開發約定](AGENTS.md)

<details>
<summary><strong>儲存庫目錄</strong></summary>

| 位置 | 放什麼 |
|---|---|
| `kernel/` | 核心：決策、事實日誌、狀態投影、到期任務、規則比對、介面行為與卡片表單 |
| `host/` | 執行外殼：Node HTTP、檔案與 SQLite 連線、時鐘、設定、狀態彙總、背景服務和外掛載入 |
| `protocol/` | 通訊格式、JSON Schema、輸入驗證、HTTP 用戶端和一致性檢查 |
| `worker/` | 工作執行程式：領取工作、執行 Agent、心跳與停止、讀取和提交回條 |
| `cli/`、`bin/` | 使用者命令及啟動入口，包括狀態、回答、`why`、MCP、更新與解除安裝 |
| `plugins/` | 內建 Agent、事件、通道和交付外掛 |
| `examples/recipes/` | 完整情境：規則、任務 Skill 和啟用說明 |
| `examples/plugins/`、`examples/skills/`、`examples/*.sh` | 最小外掛範本、獨立任務手冊和 Shell 範例 |
| `skills/agent-autoloop/` | 中台的正式設定與操作手冊，安裝時也提供給 Agent 使用 |
| `docs/` | 通訊協定、外掛開發說明與中英文架構圖 |
| `tests/`、`sim/` | 日常行為測試，以及模擬、窮舉、強殺和變異檢查 |
| `scripts/`、`.github/workflows/` | 效能與真機驗證、安裝冒煙指令碼（POSIX 與 Windows 各一份）、單一執行檔的建置，以及 Linux / macOS / Windows CI 與 Release |
| 根目錄文件與 `install.sh` | 中英文 README、安裝說明、安全邊界、開發約定、授權條款與安裝指令碼 |

讀程式碼可以從 `bin/agent-autoloop.ts` → `cli/main.ts` 開始，再按功能進入 `host/`、`worker/` 或 `plugins/`；核心設計先看[協定](docs/protocol.md)。同名檔案分屬不同層：`host/http.ts` 轉換 Node 請求，`kernel/http.ts` 定義介面行為；`protocol/rules.ts` 驗證輸入，`kernel/rules.ts` 定義規則類型和比對。

</details>

[MIT License](LICENSE)
