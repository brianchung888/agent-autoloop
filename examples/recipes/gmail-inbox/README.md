# gmail-inbox — 把 Gmail 收件匣收成 dashboard

和 `gitlab-issues` 同一套做法：Python 腳本（只用標準函式庫）收集 → sha256 快照 → Markdown + HTML →
agent-autoloop 通知回執。版面、篩選列、「我處理過了」勾選、分頁回前景自動重載都沿用同一個模板。

```
python gmail_inbox.py                      # 收集 → 快照 → briefs/latest.{md,html}
python gmail_inbox.py --dry-run            # 只收集與統計，不寫 briefs
python gmail_inbox.py --autoloop           # 結尾加印 agent-autoloop 回執區塊
python gmail_inbox.py --fixture tests/eml  # 離線：讀 .eml 當信件來源，不連 IMAP（開發/測試用）
```

## 先讀這段：腳本有兩份

和 gitlab-issues 一樣，**排程跑的不是這個 recipe 目錄裡的檔案**。部署時會把 `gmail_inbox.py`
複製到你放腳本的地方（例如 `~/scripts/`），`rules.json` 的 `command` 指向那一份，`cwd` 才是工作目錄。
**改完 recipe 一定要同步那一份**，否則下一個排程 tick 會用舊版蓋掉產出。工作目錄只放
`sources.json`、`template.html`、`gmail-inputs/`、`briefs/`。

## 認證

| 變數 | 內容 |
|---|---|
| `GMAIL_AGENT` | 最省事的一條：放 `信箱:應用程式密碼`，或只放應用程式密碼（信箱就從 `GMAIL_USER` 或 `sources.json` 的 `me` 第一筆取） |
| `GMAIL_USER` | 完整信箱位址（有設 `GMAIL_AGENT` 的話可省） |
| `GMAIL_APP_PASSWORD` | Google 應用程式密碼（<https://myaccount.google.com/apppasswords>，16 碼，空白可留） |

```powershell
setx GMAIL_AGENT "you@company.com:abcdefghijklmnop"
```

帳密只從環境變數讀，不寫進 `sources.json`、不印在任何輸出或錯誤訊息裡。
Windows 上還會補一手：環境變數抓不到時，直接讀 `HKCU\Environment`——排程的 hub 行程常常比 `setx`
早啟動，拿不到新設的變數，有這層就不必為了設一個變數重啟 hub。
帳號需要開啟兩步驟驗證才能產生應用程式密碼；Workspace 帳號若被管理員停用 IMAP 或應用程式密碼，
這條路會走不通（登入會回「IMAP 登入失敗」），得改用 Gmail API OAuth。

## 唯讀

- mailbox 一律 `SELECT ... readonly=True`，所有 FETCH 都是 `BODY.PEEK[...]` → **不會把信標成已讀**。
- 腳本裡沒有任何 `STORE`／`COPY`／`EXPUNGE` 呼叫，不封存、不改標籤、不刪信。
- 「我處理過了」只存在瀏覽器 localStorage，不回寫 Gmail。

## sources.json

```json
{
  "imapHost": "imap.gmail.com",
  "mailbox": "[Gmail]/All Mail",
  "query": "in:inbox newer_than:7d",
  "me": ["you@example.com"],
  "labelOrder": ["工作", "帳單"],
  "maxThreads": 300,
  "bodyChars": 400,
  "timezone": "Asia/Taipei"
}
```

| 欄位 | 說明 |
|---|---|
| `query` | **就是 Gmail 搜尋框那套語法**，原封不動交給 Gmail（IMAP `X-GM-RAW`）。腳本不自創篩選規則。例：`in:inbox newer_than:7d -category:promotions`、`label:工作 is:unread`。 |
| `mailbox` | 預設 `[Gmail]/All Mail`；帳號若是其他語言介面，腳本會用 IMAP `LIST` 的 `\All` 屬性自動找到真名。 |
| `me` | 你自己的信箱位址（可多個，別名、群組信箱都列進來）。用來判斷「直接寄給我」與「這封是我寄的」。`GMAIL_USER` 會自動併入。 |
| `labelOrder` | Markdown 分組的順序；沒列到的標籤排在後面，沒有標籤的歸「（無標籤）」。 |
| `maxThreads` | 上限，預設 300（1–2000）。達到上限會砍掉較舊的對話串並在 log 提醒。 |
| `bodyChars` | 內文摘要字數，預設 400；設 0 就完全不抓內文（最省、最快、快照最小）。 |

## 收集規則

| # | 來源 | 說明 |
|---|---|---|
| 1 | `UID SEARCH CHARSET UTF-8 X-GM-RAW "<query>"` | 搜尋條件整條交給 Gmail，非 ASCII 用 literal 送。 |
| 2 | `UID FETCH ... BODY.PEEK[HEADER.FIELDS (...)]` | 批次抓標頭＋`FLAGS`／`INTERNALDATE`／`X-GM-THRID`／`X-GM-MSGID`／`X-GM-LABELS`，一次 200 封。 |
| 3 | `UID FETCH ... BODY.PEEK[]<0.65536>` | 只對進了清單的對話串抓**最新那封**的前 64 KiB，取純文字摘要（`text/plain` 優先，沒有才把 HTML 轉純文字）。 |

**一列 = 一個對話串**（`X-GM-THRID`），不是一封信。串以最新一封的寄件者／主旨／時間代表，
另記信數、未讀數、標籤。最新一封是自己寄的就顯示「我」。

旗標（HTML 的標籤、Markdown 的反引號）：

| 旗標 | 意義 |
|---|---|
| `U` | 串裡有未讀 |
| `D` | 直接寄給我（我在 `To`，只在 `Cc` 不算） |
| `R` | 最新一封是我寄的，或最新一封已被我回覆（`\Answered`） |
| `S` | 已加星號（`\Flagged`） |
| `L` | 清單信（有 `List-Id`） |
| `A` | 有夾檔 |

「待我回覆」= `D` 且沒有 `R`（最新一封還沒被我回覆、也不是我自己寄的）且不是清單信、寄件位址不是 noreply／notification 這類機器信箱，最多 8 筆。
對方在我回覆後又寄一封，這串就會變回待回覆。
（gitlab-issues 的「待我確認」有 LLM 版，這裡目前只有規則版。）

## 快照

`gmail-inputs/<sha256>.json`，id 是內容的 sha256（不含 `id`／`collectedAt`）。對話串依 `thrid` 排序、
欄位順序固定，所以信箱狀態沒變就不會產生新快照、不會重做摘要。上限 2 MiB，超過整輪失敗，不產生部分摘要。
**快照與 briefs 含信件內容，只留在工作目錄，不要進 repo。**

## 輸出

- `briefs/<id>.md`、`briefs/<id>.html`，接著原子覆寫 `latest.*` 與 `<YYYY-MM-DD>.*`
- HTML 只替換模板 `<script id="data" type="application/json">` 那一段，其餘一個位元組都不改
- `--autoloop` 會在 stdout 補一段 ` ```agent-autoloop ` 回執，中台據此發通知

## rules.json

`rules.json` 是範例：把 `command` 指到你實際放腳本的路徑，`cwd` 指到工作目錄。

## 測試

`tests/eml/` 是 6 封合成信（不含任何真實信件），涵蓋：直接寄給我未讀、三封的對話串、
清單信＋Big5 主旨、只被 Cc＋夾檔、待回覆。`--fixture tests/eml` 不連網就能跑完整條管線。
