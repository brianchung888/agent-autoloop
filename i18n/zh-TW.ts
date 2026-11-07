// 正體中文（臺灣用語）：這個程式預設說的話。
//
// 照 i18n/zh-CN.ts 的 key 一條一條寫，少一個或多一個都過不了 typecheck；`{名字}` 要原樣留著，不然 host/i18n.ts
// 填不進去，tests/i18n.test.ts 會釘住這一點。用詞跟著臺灣的習慣：設定不是配置，程式不是程序，行程不是进程，
// 網路不是网络，資料不是数据，檔案不是文件，金鑰不是密钥，預設不是默认，執行不是运行——「卡片」「中台」「回執」
// 這些是這個程式自己的詞，兩邊一樣。
import type { Strings } from "./zh-CN.ts";

export const zhTW: Strings = {
  // ---- host/notify.ts ----
  "notify.trouble.win": "桌面通知無法使用：Windows 上沒有可用的通知程式，卡片會跳過通知",
  "notify.trouble.linux":
    "桌面通知無法使用：這台電腦沒有圖形工作階段（DISPLAY 和 WAYLAND_DISPLAY 都沒設），卡片會跳過通知",
  "notify.trouble.unknown": "桌面通知無法使用：問不到這台電腦的圖形工作階段，卡片會跳過通知",

  // ---- host/permissions.ts ----
  "permissions.noUser": "不知道目前使用者是誰（USERNAME 沒有設）",
  "permissions.icaclsBroken": "icacls 執行不了：{why}",
  "permissions.icaclsRefused": "icacls 沒能鎖定 {target}",
  "permissions.neverLocked": "還沒有鎖過檔案權限：執行一次 agent-autoloop init 或 up",
  "permissions.trouble": "{trouble}。同一台電腦上的其他使用者可能讀得到 {home} 裡的東西",

  // ---- host/assets.ts ----
  "assets.missing":
    "這個打包版裡沒有 {name}：建置時內嵌的清單漏了它（host/assets.ts 的 ASSETS，由 scripts/build-binary.ps1 / .sh 寫進 SEA 設定）。{why}",

  // ---- host/config.ts ----
  "config.listen.shape": "hub.listen 要寫成 主機:連接埠（IPv6 用 [位址]:連接埠）：{listen}",
  "config.listen.port": "hub.listen 的連接埠要在 1 到 65535 之間：{listen}",
  "config.notInstalled": "還沒裝好：先執行 agent-autoloop init",

  // ---- host/http.ts ----
  "http.serverError": "中台出錯了",

  // ---- host/plugin-loaders.ts ----
  "plugin.sourceInPackaged":
    '{name} 是原始碼外掛（plugins/{name}/{kind}.ts），這個打包版跑不了外部的 .ts 檔案。在 {manifest} 裡寫 {"runtime":"process","entry":"…"}，讓它當一個獨立程式被呼叫（見 docs/plugins.md）。',

  // ---- host/plugins.ts ----
  "plugin.badName": "外掛名字不正確：{name}",
  "plugin.none": "沒有 {name} 的外掛（plugins/{name}/{kind}.ts）",

  // ---- host/plugin-manifest.ts ----
  "manifest.runtime": "{name} 的 plugin.json 裡 runtime 只能是 {allowed}，現在寫的是 {written}",
  "manifest.entryMissing": '{name} 的 plugin.json 寫了 runtime: "process"，還要用 entry 指出要執行的程式',
  "manifest.entryAbsolute": "{name} 的 plugin.json 裡 entry 要是外掛目錄內的相對路徑，不能是絕對路徑：{entry}",
  "manifest.entryEscapes": "{name} 的 plugin.json 裡 entry 走出了外掛目錄：{entry}",
  "manifest.args": "{name} 的 plugin.json 裡 args 要是一串字串，每一項都是一個參數",

  // ---- host/plugin-process.ts ----
  "pluginProcess.cannotStart": "{name} 外掛的程式起不來（{program}）：{why}",
  "pluginProcess.signalled": "{name} 外掛的程式被 {signal} 結束了，沒有回覆 {call}",
  "pluginProcess.saidNothing": "{name} 外掛對 {call} 什麼都沒答（結束代碼 {status}）",
  "pluginProcess.notJson": "{name} 外掛對 {call} 答的不是一行 JSON：{line}",
  "pluginProcess.noReason": "沒說原因（{line}）",
  "pluginProcess.said": "{name} 外掛說：{said}",
  "pluginProcess.channelNotProcess":
    '{name} 是通道外掛，現在還不能用 runtime: "process"：通道是和中台一樣常駐的迴圈，不是一次一答的轉譯。用別的語言寫通道，直接當獨立程式連中台的 HTTP 協定（見 docs/plugins.md 的通道一節），不必經過外掛機制。',
  "pluginProcess.entryGone": "{name} 的 plugin.json 指的程式不在：{entry}",

  // ---- host/runtime.ts ----
  "runtime.masterKeyBroken":
    "{file} 壞了（應該是 43 個字元），中台不啟動。從備份還原這個檔案；沒有備份就刪掉它，重新啟動會產生新的，但已經發出的卡片連結和正在跑的輪次會失效。",
  "runtime.rulesGone": "找不到 {file}，被刪掉或移走了？放回去就會接著用",
  "runtime.rulesUnreadable": "沒有權限讀 {file}，改回能讀的權限就會接著用",
  "runtime.rulesTrouble": "讀不到 {file}：{why}",
  "runtime.noRules": "缺少規則",
  "runtime.noSuchRun": "沒有這一輪",

  // ---- host/self-replace.ts ----
  "selfReplace.nothingStaged": "沒有要換上去的檔案：{staged} 不在",
  "selfReplace.lost":
    "換檔案失敗了，而且沒能把舊的放回去：現在 {executable} 不在，舊的在 {old}。把它改回原名就能用（{why}；放回時 {putBack}）",
  "selfReplace.rolledBack": "換檔案失敗了，已經回到原樣（{why}）",

  // ---- host/server.ts ----
  "server.noWebhook": "這個來源不收 Webhook",
  "server.adapterBroken": "{adapter} 這個外掛裝不起來",
  "server.adapterBrokenCode": "{adapter} 這個外掛裝不起來（{code}）",
  "server.adapterBrokenTail": "，中台紀錄裡寫了是什麼",
  "server.badSignature": "驗簽沒過",

  // ---- host/service.ts, host/service-win.ts ----
  "service.description": "Agent 自動化中台",
  "service.descriptionNamed": "Agent 自動化中台（{label}）",
  "service.unitControlChars": "systemd unit 的值不能包含控制字元",
  "service.noBornAt": "問不出本行程的建立時刻：up.pid 少了這一項，下一次 up 會說看不清這把鎖，而不是把它當空的。",
  "service.winNote": "Windows 上靠排程工作常駐：停了之後最多等 5 分鐘才會自己回來。",
  "service.winNoteNoLogon":
    "Windows 上靠排程工作常駐，而這台電腦不讓登入時就啟動（通常是加了網域）：登入後和停了之後都最多等 5 分鐘。",
  "service.systemUnit": "這台電腦用的是系統層級服務，執行 systemctl restart {name} 才會用上新版。",
  "service.winPathQuotes": "Windows 上的路徑不能包含引號或控制字元",
  "service.winHomeNewline": "AGENT_AUTOLOOP_HOME 不能包含換行",

  // ---- host/up.ts ----
  "up.lockUnclear": "看不清 {file} 裡的號還在不在（列行程沒成功）：確認沒有別的 up 在跑之後，把它刪掉再來",
  "up.alreadyRunning": "已經在跑了（行程 {pid}）",
  "up.notLoopback": "{host} 不是本機迴環位址，中台會向這個位址所在的網路開放；前面要有 HTTPS 反向代理",

  // ---- host/version.ts ----
  "version.line": "agent-autoloop {release}（提交 {commit}）",
  "version.unreleased": "未發布",

  // ---- worker/agents.ts ----
  "agents.notFound": "找不到 {name}：先裝好並登入",

  // ---- worker/launcher.ts ----
  "launcher.usage": "用法：agent-autoloop internal:launch <stdout 檔案> <stderr 檔案> <exit 檔案> -- <命令列>",
  "launcher.cannotOpen": "啟動不了：寫不了輸出檔案（{why}）",
  "launcher.cannotStart": "啟動不了：{why}",

  // ---- worker/worker.ts ----
  "worker.cwdGone": "在 {cwd} 啟動不了：這個目錄不存在",
  "worker.gaveNothing": "它什麼也沒給",
  "worker.unreadableOutput": "讀不懂這個 Agent 的輸出：{why}",
  "worker.receiptUnreadable.title": "「{rule}」的回執讀不懂",
  "worker.receiptUnreadable.text":
    "這一輪按第一行算結束了，但它要中台做的事沒有生效（{problem}）。原文在 {file}，留 {days} 天。",
  "worker.stopped": "已停止",
  "worker.timedOut": "超過 {minutes} 分鐘還沒結束，已停止",
  "worker.noResult": "沒留下結果",
  "worker.groupNotConfirmed": "停止訊號發出後沒能確認行程群組已結束：這一輪按沒跑成記，不再重試，行程可能還在。",
  "worker.hubUnreachable": "{name} 連不上中台已經 {minutes} 分鐘了，派給它的活暫時沒人接；它還在一直重試。",

  // ---- plugins/desktop/channel.ts ----
  "desktop.words": "執行 agent-autoloop status 查看",
  "desktop.title": "Agent 問你一個問題",
  "desktop.hubUnreachable": "連不上中台：{why}",
  "desktop.notSent": "卡片 {card} 的桌面通知沒發出：{why}",

  // ---- plugins/feishu/channel.ts ----
  "feishu.decided": "你選了「{chosen}」，已記錄，等待處理。",
  "feishu.doneWithResult": "你選了「{chosen}」。已執行：{result}",
  "feishu.done": "你選了「{chosen}」。已執行。",
  "feishu.closed": "不用決定了：{result}",
  "feishu.note": "處理說明：{note}",
  "feishu.noteLabel": "處理說明（可不填）",
  "feishu.notePlaceholder": "比如：已回覆他影片下週發；或：群發廣告，不用管",
  "feishu.noteSubmit": "記錄並結案",
  "feishu.noOwner": "飛書通道要在 config.json 寫 user，或者先 lark-cli auth login",

  // ---- plugins/webhook/channel.ts, plugins/webhook/templates.ts ----
  "webhook.source": "來源：{rule}",
  "webhook.openCard": "點選處理",
  "webhook.openLink": "開啟連結",
  "webhook.discordTooLong": "Discord 訊息超過 2000 個字，請縮短卡片",
  "webhook.wecomTooLong": "企業微信訊息超過 2048 位元組，請縮短卡片",
  "webhook.noTemplate": "沒有這個 Webhook 範本：{platform}",
  "webhook.status": "回傳 {status}",
  "webhook.sendFailed": "傳送失敗：{why}",
  "webhook.slackNotOk": "Slack 沒有確認收到訊息",

  // ---- plugins/acp ----
  "acp.unfinished": "ACP 沒有完成這一輪",
  "acp.unfinishedWhy": "ACP 沒有完成這一輪：{why}",
  "acp.noCommand": "ACP 要在 command 寫啟動命令",
  "acp.exited": "ACP 在交回結果前結束：{code}",
  "acp.noMethod": "不支援這個方法",
  "acp.closedOutput": "ACP 在交回結果前關掉了輸出",
  "acp.noResume": "這個 ACP Agent 不支援恢復工作階段",
  "acp.badVersion": "不支援 ACP 版本 {version}",
  "acp.noSession": "ACP 沒有回傳工作階段編號",

  // ---- plugins/claude, plugins/codex, plugins/dsh, plugins/command ----
  "agent.noResult": "沒留下結果",
  "agent.noReason": "沒留下原因",
  "agent.exitCode": "結束代碼 {code}：{why}",
  "claude.notLoggedIn": "Claude Code 沒有登入：執行 claude auth login",
  "claude.unusable": "Claude Code 用不了：{why}",
  "codex.unfinished": "Codex 沒跑完這一輪",
  "codex.noResult": "Codex 沒有完成並留下實際結果",
  "codex.notLoggedIn": "Codex 沒有登入或用不了：執行 codex login（{why}）",
  "dsh.unfinished": "DSH 沒跑完這一輪",
  "dsh.noResult": "DSH 沒有完成並留下實際結果",
  "dsh.aborted": "這一輪被中止了",
  "dsh.blocked": "這一輪被卡住了，沒有完成",
  "dsh.maxTokens": "這一輪用完了輸出上限",
  "dsh.tooOld":
    "DSH 版本太舊，要 0.2.2 或更新：npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local",
  "dsh.unusable": 'DSH 用不了：執行 dsh headless "hi" 看看（{why}）',
};
