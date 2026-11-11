// 正體中文（臺灣用語）：這個程式預設說的話。
//
// 照 i18n/zh-CN.ts 的 key 一條一條寫，少一個或多一個都過不了 typecheck；`{名字}` 要原樣留著，不然 host/i18n.ts
// 填不進去，tests/i18n.test.ts 會釘住這一點。用詞跟著臺灣的習慣：設定不是配置，程式不是程序，行程不是进程，
// 網路不是网络，資料不是数据，檔案不是文件，金鑰不是密钥，預設不是默认，執行不是运行——「卡片」「中台」「回執」
// 這些是這個程式自己的詞，兩邊一樣。
import type { Strings } from "./zh-CN.ts";

export const zhTW: Strings = {
  // ---- kernel/decide.ts ----
  "kernel.decide.unknownInput": "不認識的輸入：{type}",
  "kernel.decide.backOnline": "連上了",
  "kernel.decide.tooDeep": "同一條處理鏈已超過 {hops} 層，後續事件已記錄，沒有繼續派發。",
  "kernel.decide.loopStopped": "事件循環已停止",
  "kernel.decide.notYourRun": "這件活不歸這個權杖",
  "kernel.decide.runInDoubt": "交給 {agent} 後超過 5 分鐘沒有回音，不確定做沒做完；後續新任務照常處理。",
  "kernel.decide.workerNeverSeen": "{worker} 一直沒連上中台，有 {waiting} 件任務等了 {minutes} 分鐘沒人接",
  "kernel.decide.workerSilent": "{worker} 已經 {minutes} 分鐘沒連上中台，有 {waiting} 件任務在排隊或在跑",
  "kernel.decide.checkPower": "有沒有開機連網",
  "kernel.decide.checkOffline": "是不是關機、休眠或斷網了",
  "kernel.decide.workerOffline": "接單程式沒連上",
  "kernel.decide.workerOfflineWords": "{situation}（請看一眼那台電腦{check}）。",
  "kernel.decide.ruleGone": "規則「{rule}」不在了，不再派發",
  "kernel.decide.ruleGoneWords":
    "規則「{rule}」不在了（刪掉或改名了），排著的這一輪不再派發。還要做的話重新觸發這件事。",
  "kernel.decide.noReason": "沒說原因",
  "kernel.decide.onlyNoticeWhenFailed": "沒跑成的一輪只能發通知",
  "kernel.decide.outsideWindow": "失敗了，而下一次重試已在排程時段外：等下一次排程",
  "kernel.decide.gaveUp": "連續 {tries} 次沒跑成，不再自動重試",
  "kernel.decide.gaveUpWords":
    "連續 {tries} 次自動處理沒跑完（卡在：{error}），不再自動重試。解決後重新觸發這件事，它會從頭開始。",
  "kernel.decide.failingWords": "連續 3 次自動處理沒跑完（卡在：{error}），{time} 會自動再試。",
  "kernel.decide.laterRan": "後來跑成了",
  "kernel.decide.resultCameBack": "結果回來了",
  "kernel.decide.byRound": "第 {id} 輪",
  "kernel.decide.outOfScope": "不在本輪核對範圍",
  "kernel.decide.cannotEmit": "規則「{rule}」沒有寫可以發 {type}",
  "kernel.decide.handedInOther": "這一次執行已經交過不一樣的結果",
  "kernel.decide.stopped": "已停止",
  "kernel.decide.noSuchCard": "沒有這張卡片",
  "kernel.decide.notYourCard": "這個人不能回答這張卡片",
  "kernel.decide.notThatMessage": "不是發出去的那條訊息",
  "kernel.decide.byTooLong": "回答人最多 {most} 字",
  "kernel.decide.refTooLong": "訊息編號最多 {most} 字",
  "kernel.decide.handlingNote": "處理說明",
  "kernel.decide.answer": "回答",
  "kernel.decide.mustBeText": "{what}要是文字",
  "kernel.decide.textTooLong": "{what}最多 {most} 字",
  "kernel.decide.handled": "已處理",
  "kernel.decide.noSuchOption": "沒有這個選項",
  "kernel.decide.rulesFixed": "改好了",
  "kernel.decide.rulesBroken": "rules.json 寫錯了，還在用舊規則",
  "kernel.decide.elsewhereNoCwd": "定時任務「{name}」沒寫 cwd，回答了沒人接著做：只能 tell",
  "kernel.decide.fieldTooLong": "{field} 要是 500 字以內的文字",
  "kernel.decide.noSuchRun": "沒有這一輪",
  "kernel.decide.runOver": "這一輪已經結束了",
  "kernel.decide.notToThisChannel": "這張卡片沒有交給這個通道",

  // ---- kernel/cron.ts ----
  // 內核裡的話，語言由呼叫端當參數傳進來（host/i18n.ts 的 t() 是外殼在用的，內核拿不到它）。
  "kernel.cron.everyDay": "每天 {at}",
  "kernel.cron.everyWeek": "每週{day} {at}",
  "kernel.cron.weekdayNames": "日一二三四五六日",
  "kernel.cron.workdays": "工作日 {at}",
  "kernel.cron.everyMonth": "每月 {day} 日 {at}",

  // ---- kernel/card-page.ts ----
  "kernel.card.howHandled": "我實際怎麼處理的（可不填）",
  "kernel.card.handling": "處理說明",
  "kernel.card.otherThought": "別的想法",
  "kernel.card.closeWithNote": "記錄並結案",
  "kernel.card.send": "發送",
  "kernel.card.chose": "你選了「{option}」",
  "kernel.card.handlingWas": "處理說明：{text}",

  // ---- kernel/query.ts ----
  "kernel.query.handled": "已處理",

  // ---- kernel/store.ts ----
  "kernel.store.logMoved": "日誌已變化，請重讀後再提交",

  // ---- kernel/http.ts ----
  "kernel.http.owner": "本人",
  "kernel.http.worker": "接單程式",
  "kernel.http.channel": "通道",
  "kernel.http.source": "來源",
  "kernel.http.needKey": "要{whom}自己的金鑰",
  "kernel.http.notJson": "不是 JSON",
  "kernel.http.noSuchCard": "沒有這張卡片",
  "kernel.http.linkExpired":
    "這個連結過期了。在裝它的電腦上執行 agent-autoloop status，還沒答的卡片都在那裡，可以接著回答",
  "kernel.http.byLink": "連結",
  "kernel.http.noWebhook": "這個來源不收 Webhook",
  "kernel.http.needSourceOrWorker": "要來源或接單程式的金鑰",
  "kernel.http.tellShape": "要有正確的 key 和 text，接單程式還要寫 task，text 最多 20000 字；問你的寫 task 和 ask",
  "kernel.http.noSuchTask": "這台接單程式沒有這個定時任務",
  "kernel.http.askShape": "問你的只寫 task 和 ask，ask 和回執裡的一樣：title、text、2 到 5 個 options",
  "kernel.http.claimShape": "claim 是這次領活的編號，最多 200 字",
  "kernel.http.keyGone": "金鑰已失效",
  "kernel.http.resolveReason": "寫一句處理結果，最多 1000 字",
  "kernel.http.needVersion": "要說明是哪個版本",
  "kernel.http.badId": "編號不正確",
  "kernel.http.badSeq": "日誌序號不正確",
  "kernel.http.badKeyName": "金鑰名字不正確",
  "kernel.http.noSuchPath": "沒有這個位址",
  "kernel.http.tooLarge": "請求最多 1024 KB",

  // ---- host/notify.ts ----
  "notify.trouble.win": "桌面通知無法使用：Windows 上沒有可用的通知程式，卡片會跳過通知",
  "notify.trouble.linux":
    "桌面通知無法使用：這台電腦沒有圖形工作階段（DISPLAY 和 WAYLAND_DISPLAY 都沒設），卡片會跳過通知",
  "notify.trouble.unknown": "桌面通知無法使用：問不到這台電腦的圖形工作階段，卡片會跳過通知",

  // ---- host/permissions.ts ----
  "permissions.noUser": "不知道目前使用者是誰（USERNAME 沒有設）",
  "permissions.icaclsBroken": "icacls 執行不了：{why}",
  "permissions.icaclsRefused": "icacls 沒能鎖定 {target}",
  "permissions.icaclsUnreadable": "icacls 問不到 {target} 的權限清單",
  "permissions.othersLeft": "icacls 沒能去掉 {target} 上其他人的權限（{others}）",
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
  "manifest.or": " 或 ",
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
  "selfReplace.cannotRenameRunning":
    "沒能把手上這個 {name} 換開，什麼都沒動，下載到的那份已經刪掉（{why}）：這個檔案被別的程式開著（防毒軟體在讀、除錯器掛著）就是這樣，過一陣再來一次",
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
  "acp.modelUnavailable": "ACP 工作階段沒有提供可選模型：{model}",
  "acp.modelUnconfirmed": "ACP 沒有確認切換到模型：{model}",

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

  // ---- cli/main.ts：說明和用法 ----
  "cli.help":
    "Agent 自動化中台\n\n  agent-autoloop init [--agent claude|codex] [--command '某個命令 {prompt}'] [--port 3350] [--no-service]\n                                    在這台電腦上裝好：一個人一台電腦就夠\n  agent-autoloop try                     用你的 Agent 跑一遍完整流程\n  agent-autoloop why <第幾輪> [--json]  看時間軸；--json 輸出原始事實\n  agent-autoloop conformance <位址> --config <測試憑證檔案>\n                                    在測試中台上檢查協定\n  agent-autoloop status [--json]         現在什麼情況：誰在線、等你什麼、在做什麼、做過什麼、花了多少\n                                     --json 輸出 /v1/state 的原始結構，給腳本用\n  agent-autoloop answer <卡片> [序號] [--text 別的想法]\n                                    回答一張卡片；通知不用寫序號\n  agent-autoloop resolve <卡片> <結果>   這件事不用決定了，寫一句結果\n  agent-autoloop doctor                  查哪裡沒設好\n  agent-autoloop check [檔案]            檢查規則檔案，不碰中台；不寫檔案就查 rules.json\n  agent-autoloop rules explain           按本機 rules.json 說明生效的規則、Agent、通道和下次定時\n  agent-autoloop emit <類型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 來源金鑰]\n                                    發一條事件；--dry-run 只預演會派給誰，不連接中台\n  agent-autoloop tell <編號> [--task 定時任務名]\n                                    直接告訴你一件事，內容從標準輸入讀\n  agent-autoloop ask --task <定時任務名>\n                                    定時任務問你一件事：標準輸入傳回執那樣的 ask；你答了，它的 Agent 在 cwd 接著做\n  agent-autoloop stop <第幾輪>           停掉一輪\n  agent-autoloop key new <source|worker|channel|owner> <名字>\n                                    新建一把金鑰（只顯示這一次）\n  agent-autoloop key list                有哪些金鑰\n  agent-autoloop key remove <種類> <名字>  立刻收回一把金鑰\n  agent-autoloop add <git 位址>           安裝外掛，不自動更新\n  agent-autoloop mcp                      用標準輸入輸出連接 MCP 用戶端\n  agent-autoloop join <中台位址> --worker <名字> --key <金鑰> [--no-service]\n                                    另一台電腦只接活時用\n  agent-autoloop backup [目錄]           備份資料庫、主金鑰、設定、規則和 secrets.env；不填目錄就放在 ~/.agent-autoloop/backups\n  agent-autoloop restore <目錄> [--yes]  停掉中台後，用一次備份還原本機資料\n  agent-autoloop update                  更新到最新發布的版本\n  agent-autoloop uninstall [--yes]       解除安裝程式並保留資料；--yes 跳過確認\n  agent-autoloop lang [zh-TW|zh-CN]      這個程式說哪種中文；不寫就說現在說的是哪種\n  agent-autoloop --version               版本和目前提交\n  agent-autoloop help                    這份說明\n  agent-autoloop up                      啟動（平時由系統服務呼叫）\n  agent-autoloop service install|remove  系統服務\n\n設定和資料在 {home}。規則在 {rules}，改了自動生效。",
  "cli.usage.init":
    "用法：agent-autoloop init [--agent claude|codex] [--command '某個命令 {prompt}'] [--port 3350] [--no-service] [--lang zh-TW|zh-CN]\n\n  --agent      只接這個 Agent：claude 或 codex。不寫就接本機裝好的全部\n  --command    改用別的命令列 Agent；{prompt} 會作為一個獨立參數傳進去\n  --port       中台監聽的連接埠，預設 3350\n  --no-service 先不裝系統服務，之後手動執行 agent-autoloop up\n  --lang       這個程式說哪種中文：zh-TW（預設）或 zh-CN",
  "cli.usage.try":
    "用法：agent-autoloop try\n\n用本機接好的 Agent 跑一遍完整流程：提問，行程結束等你回覆，你定案，它接著做完。",
  "cli.usage.status":
    "用法：agent-autoloop status [--json]\n\n現在什麼情況：誰在線、等你什麼、在做什麼、做過什麼、花了多少。\n  --json  輸出 /v1/state 的原始結構，給腳本和儀表板用",
  "cli.usage.update": "用法：agent-autoloop update\n\n更新到最新發布的版本。沒有參數。",
  "cli.usage.uninstall":
    "用法：agent-autoloop uninstall [--yes]\n\n解除安裝程式並保留規則、金鑰和紀錄。\n  --yes  跳過確認",
  "cli.usage.restore":
    "用法：agent-autoloop restore <目錄> [--yes]\n\n還原會替換本機的資料庫、主金鑰、設定、規則和 secrets.env；先停掉中台，--yes 跳過確認。",
  "cli.usage.lang":
    "用法：agent-autoloop lang [zh-TW|zh-CN]\n\n這個程式說哪種中文，寫進 config.json 的 lang；不寫就說現在說的是哪種。\nAGENT_AUTOLOOP_LANG 蓋得過它。\n要先 init 才有 config.json 可寫；init 之前用 AGENT_AUTOLOOP_LANG 或 init --lang。",
  "cli.usage.add": "用法：agent-autoloop add <git 位址>",
  "cli.usage.answer": "用法：agent-autoloop answer <卡片> [序號] [--text 別的想法]",
  "cli.usage.ask":
    '用法：agent-autoloop ask --task <定時任務名>，問題從標準輸入讀：\n  { "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0, "about": "留給接著做的", "key": "這件事的固定名字" }\nrules.json 裡這個定時任務要寫 cwd；你答了，中台叫醒它的 Agent 在 cwd 照 skill、prompt 接著做。',
  "cli.usage.backup": "用法：agent-autoloop backup [目錄]",
  "cli.usage.check": "用法：agent-autoloop check [檔案]",
  "cli.usage.conformance": "用法：agent-autoloop conformance <測試中台位址> --config <測試憑證檔案>",
  "cli.usage.doctor": "用法：agent-autoloop doctor",
  "cli.usage.emit":
    "用法：agent-autoloop emit <類型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 來源金鑰]",
  "cli.usage.join": "用法：agent-autoloop join <中台位址> --worker <名字> --key <金鑰> [--no-service]",
  "cli.usage.key":
    "用法：agent-autoloop key new <source|worker|channel|owner> <名字>\n      agent-autoloop key list\n      agent-autoloop key remove <種類> <名字>",
  "cli.usage.keyNew": "用法：agent-autoloop key new <source|worker|channel|owner> <名字>",
  "cli.usage.keyRemove": "用法：agent-autoloop key remove <種類> <名字>",
  "cli.usage.mcp": "用法：agent-autoloop mcp",
  "cli.usage.resolve": "用法：agent-autoloop resolve <卡片> <結果>",
  "cli.usage.rules": "用法：agent-autoloop rules explain",
  "cli.usage.service": "用法：agent-autoloop service install|remove",
  "cli.usage.stop": "用法：agent-autoloop stop <第幾輪>",
  "cli.usage.tell": "用法：agent-autoloop tell <編號> [--task 定時任務名]，內容從標準輸入讀",
  "cli.usage.up": "用法：agent-autoloop up",
  "cli.usage.why": "用法：agent-autoloop why <第幾輪> [--json]",
  "cli.usage.internalPlugin": "用法：agent-autoloop internal:plugin <外掛名字> [參數…]",

  // ---- cli/main.ts：init、join、try ----
  "cli.unknownFlags": "不認得的參數：{flags}",
  "cli.unknownArgs": "不認得的參數：{args}",
  "cli.noOwnerKey": "這台電腦上沒有本人的金鑰（只接活的電腦看不了）",
  "cli.starter.source": "本機",
  "cli.starter.channel": "桌面通知",
  "cli.starter.rule": "試一下",
  "cli.starter.prompt":
    '這是 agent-autoloop try 的試跑，不要改任何檔案，不要做別的事。讀資料檔案。如果 answers 是空的，就問一個問題：title 寫「試跑：選一個顏色」，text 寫「這是一次試跑，選哪個都行。」，options 寫 ["藍色","綠色"]，key 寫 try-color，第一行結論寫「問了一個問題」。如果 answers 不是空的，第一行結論寫「你選了某某，試跑通過」，把某某換成 answers 裡選的那一項，不附回執。',
  "cli.skillNotLinked": "沒能把 skill 接到你的 Agent 上（{why}）。這不影響中台，之後可以手動放。",
  "cli.alreadyInstalled": "已經裝過了：{file}",
  "cli.noAgentFound":
    "這台電腦上沒找到 Claude Code 或 Codex。先裝好並登入，或者用 --command 指定別的命令列 Agent，比如 --command 'hermes chat -Q -q {prompt}'",
  "cli.init.channelLine": "  通道：桌面通知",
  "cli.init.nextNoService": "先執行 {run} up 啟動中台，再開一個終端執行 {run} try 跑一遍完整流程。",
  "cli.init.next": "執行 {run} try 跑一遍完整流程。",
  "cli.init.done": "裝好了。\n  Agent：{agents}\n{reach}  規則：{rules}\n\n{next}",
  "cli.join.already": "已經設定過了：{file}。為了不蓋掉現有設定，請先備份再手動改設定。",
  "cli.join.next": "執行 {run} up 開始。",
  "cli.join.done": "這台電腦以 {name} 的身分接活了。{next}",
  "cli.card.ask": "等你決定",
  "cli.card.notice": "要你留意",
  "cli.card.recommend": "（建議）",
  "cli.card.howToAnswerAsk": "回答：agent-autoloop answer {card} <序號>",
  "cli.card.howToAnswerNotice": "處理完了：agent-autoloop answer {card}",
  "cli.choose": "選幾？",
  "cli.chooseRange": "輸入 1 到 {max}。",
  "cli.try.noSourceKey": "這台電腦上沒有來源的金鑰。",
  "cli.try.hubUnreachable": "連不上中台（{why}）：先 agent-autoloop up 或 agent-autoloop service install",
  "cli.try.retrying": "上一次沒跑成（{error}），{time} 會自動再試，這次的事件會一起處理。",
  "cli.try.sent": "事件發出去了，Agent 開始做事……",
  "cli.try.agentFailed": "Agent 沒跑成：{error}\n執行 agent-autoloop doctor 看看。",
  "cli.try.cardPrefix": "試跑",
  "cli.try.asked": "Agent 結束了這一輪，問了你一個問題。它現在不佔行程、不花 Token。",
  "cli.try.answerHint": "{how}\n答完執行 agent-autoloop status，能看到它接著把活做完。",
  "cli.try.received": "收到，Agent 接著做……",
  "cli.try.done": "它把活做完了：{result}\n\n通了。接下來把 {rules} 改成你自己的規則，或者跟你的 Agent 說一句。",
  "cli.try.timeout": "五分鐘沒等到結果。執行 agent-autoloop doctor 看看。",

  // ---- cli/main.ts：status ----
  "cli.run.claimed": "在跑",
  "cli.run.queued": "排隊",
  "cli.run.done": "做完了",
  "cli.run.nothing": "沒事可做",
  "cli.run.unknown": "不確定",
  "cli.run.cancelled": "停了",
  "cli.run.retrying": "等重派",
  "cli.status.totals": "在跑 {running} · 排隊 {queued} · 今天做完 {doneToday} · 等你 {waiting}",
  "cli.status.timed": "定時",
  "cli.status.elsewhere": "（在別處：{where}）",
  "cli.status.timedLine": "  {name}{where}：{every}，下次 {next}",
  "cli.status.recentCards": "最近的卡片",
  "cli.status.recentRuns": "最近幾輪",
  "cli.status.unrouted": "沒有規則接的事件",

  // ---- cli/main.ts：answer、resolve ----
  "cli.answer.unchanged": "這張卡片已經處理過了，這次沒有改動。",
  "cli.answer.closed": "結案了。",
  "cli.answer.received": "收到，Agent 接著做。",

  // ---- cli/main.ts：doctor ----
  "cli.doctor.notInstalled": "還沒裝好：執行 agent-autoloop init",
  "cli.doctor.filePermissions": "檔案權限降級：{why}",
  "cli.doctor.rules": "規則 {file}",
  "cli.doctor.noAnswerers": "{channel}沒寫 answerers：這個通道裡誰都能回答卡片。",
  "cli.doctor.serviceRunning": "系統服務在跑",
  "cli.doctor.systemService": "系統層級服務在跑",
  "cli.doctor.serviceStopped": "系統服務沒在跑：agent-autoloop service install",
  "cli.doctor.hub": "中台 {url}（{commit}）",
  "cli.doctor.hubUnreachable": "連不上中台 {url}：{why}",
  "cli.doctor.online": "在線",
  "cli.doctor.offline": "不在線",
  "cli.doctor.agent": "{name}（{worker}）{state}",
  "cli.doctor.agentUsable": "{name} 可以用",
  "cli.doctor.channel": "{name}{state}",
  "cli.doctor.noChannels":
    "還沒接通道：Agent 問你時不會主動告訴你，要自己執行 agent-autoloop status 看。接法見 {manual}",
  "cli.doctor.onlyDesktopMuted":
    "只接了桌面通知，而這台電腦彈不出通知：Agent 問你時得自己執行 agent-autoloop status 看。",
  "cli.doctor.onlyDesktop":
    "只接了桌面通知：Agent 問你時只有這台電腦會彈通知，人不在電腦前、或者電腦沒有圖形介面就看不到。",
  "cli.doctor.onlyDesktopTail": "{only}要發到飛書、釘釘這些地方，接法見 {manual}",
  "cli.doctor.stateUnreadable": "讀不到中台狀態：{why}",

  // ---- cli/main.ts：check、key、emit、backup、restore、tell、ask、stop、add、update ----
  "cli.rulesUnreadable": "讀不到 {file}：{why}",
  "cli.check.ok": "規則沒問題：{file}",
  "cli.key.removed": "金鑰已失效。",
  "cli.key.notThere": "沒有這把金鑰，可能已經刪過了。",
  "cli.emit.dryRunWithKey": "--dry-run 按這台電腦的來源預演，不能和 --key 一起用",
  "cli.emit.noSourceNameForDryRun": "這台電腦上沒有來源的金鑰：--dry-run 需要知道來源名",
  "cli.emit.preview": "預演（按本機 rules.json，不連接中台、不寫紀錄）：",
  "cli.emit.noSourceKey": "這台電腦上沒有來源的金鑰：用 --key",
  "cli.emit.routed": "交給了：{to}",
  "cli.emit.unrouted": "記下了，沒有規則接它。",
  "cli.backup.done": "備份好了：{target}\n  {files}\n裡面有金鑰，把它放到安全的地方；還原要中台停下來。",
  "cli.restore.needsYes": "還原會替換本機資料；確認後執行 agent-autoloop restore <目錄> --yes",
  "cli.restore.confirm": "還原會替換本機的資料庫、主金鑰、設定、規則和 secrets.env，繼續？[y/N] ",
  "cli.restore.cancelled": "沒有還原。",
  "cli.restore.done": "還原好了。原來的檔案在 {safety}。\n啟動：agent-autoloop up 或 agent-autoloop service install",
  "cli.tell.empty": "要說的話從標準輸入傳，不能為空。",
  "cli.tell.notWorker": "這台電腦不是接單程式",
  "cli.tell.noSourceKey": "這台電腦上沒有來源的金鑰",
  "cli.tell.duplicate": "這件事已經說過了，這次沒再發。",
  "cli.tell.sent": "說了。",
  "cli.ask.badJson": "問題從標準輸入傳，是一段 JSON：和回執裡的 ask 一樣",
  "cli.ask.duplicate": "同一件事還在等你回答，這次沒再問。",
  "cli.ask.asked": "問了。",
  "cli.stop.told": "通知它停了。",
  "cli.add.driveOnly":
    "「{url}」只是一個磁碟機代號，不是一個位址：寫全要裝的那個倉庫的路徑或 URL（比如 {drive}:/path/to/plugin）。",
  "cli.add.badName": "外掛名字「{name}」不能用：只能用小寫字母、數字和 -，規則裡的 use 也寫這個名字",
  "cli.add.cloneFailed": "安裝失敗。",
  "cli.add.installed": "已安裝 {name}。",
  "cli.add.badManifest": "但它的 plugin.json 寫錯了：{why}",
  "cli.add.isProcess": '它宣告自己是一個外部程式（runtime: "process"），跑的是 {entry}。',
  "cli.add.isSource": '它沒有宣告 runtime，按原始碼外掛用（runtime: "source"）：中台載入它的時候會執行它。',
  "cli.plugin.noMain": "{name} 這個外掛沒有可以這樣跑的活（它沒有匯出 main）",
  "cli.update.newest": "已經是最新的（{to}）。",
  "cli.update.restarted": "中台已經用新版重新啟動。",
  "cli.update.wasUpNoService": "中台為這次換檔停掉了，而本機沒裝常駐：再 agent-autoloop up 啟一次，用的就是新版。",
  "cli.update.upAgain": "再 agent-autoloop up 就用上新版了（本機沒裝常駐）。",
  "cli.update.done": "更新好了（{to}）。{back}",
  "cli.update.oldKept": "舊的那一個還在 {old}，下次啟動會自己清掉。",
  "cli.update.newestSource": "已經是最新的{version}。",
  "cli.update.doneSource": "更新好了{version}。{told}",
  "cli.update.gitFailed": "git {command} 沒成功：{why}",

  // ---- cli/main.ts：lang ----
  "cli.lang.now": "現在說的是 {lang}。",
  "cli.lang.changed": "以後說 {lang}。",
  "cli.lang.unknown": "不認得的語言：{told}。只能是 {allowed}",
  "cli.lang.overridden": "注意：AGENT_AUTOLOOP_LANG 設成了 {env}，它蓋得過 config.json 裡寫的。",

  // ---- cli/spend.ts ----
  "cli.spend.today": "今天",
  "cli.spend.week": "最近 7 天",
  "cli.spend.zero": "{label} 0 輪",
  "cli.spend.missing": "（{rounds} 輪沒上報）",
  "cli.spend.noTokens": "Token 沒上報",
  "cli.spend.tokens": "{amount} Token{missing}",
  "cli.spend.noCost": "費用沒上報",
  "cli.spend.line": "{label} {rounds} 輪 · {tokens} · {cost}",
  "cli.spend.units": "萬|億",

  // ---- cli/explain.ts ----
  "cli.explain.whenEvent": "來源 {source} · {types}",
  "cli.explain.whenCron": "定時 {cron}（下次 {next}）",
  "cli.explain.parallel": "並行 {n}",
  "cli.explain.resume": "接著上一輪的工作階段",
  "cli.explain.group": "群組 {group}",
  "cli.explain.tell": "通知 {tell}",
  "cli.explain.hasSkill": "有 Skill",
  "cli.explain.hasPrompt": "有 Prompt",
  "cli.explain.emits": "可發 {source} {types}",
  "cli.explain.header": "時區 {zone}；先問你：{askFirst}；{count} 條規則",
  "cli.explain.sources": "來源：{list}",
  "cli.explain.sourceItem": "{id}（{name}）",
  "cli.explain.agents": "Agent：{list}",
  "cli.explain.agentItem": "{id}（{name}，{worker}，權限 {access}）",
  "cli.explain.channels": "通道：{list}",
  "cli.explain.channelItem": "{id}（{name}{answerers}{links}）",
  "cli.explain.answerers": "，回答人 {list}",
  "cli.explain.withLinks": "，帶連結",
  "cli.explain.rulesHeading": "規則：",
  "cli.explain.ruleLine": "  {name}：{details}",
  "cli.explain.elsewhereLine": "  {name}：在別處（{where}）{cron}{answers}",
  "cli.explain.elsewhereAnswers": "；問你的，回答後交給 {agent} 在 {cwd} 接著做",
  "cli.explain.event": "事件：{source} {type}",
  "cli.explain.unregisteredSource": "來源 {source} 沒有登記在 rules.json 的 sources 裡",
  "cli.explain.noRule": "沒有規則接這條事件；真發出去會記成「沒有規則接的事件」。",
  "cli.explain.willGo": "會派給：",
  "cli.explain.goesTo": "  {name} → {to} · {cwd}",

  // ---- cli/why.ts ----
  "cli.why.header": "第 {id} 輪 · {rule}",
  "cli.why.noSubject": "無",
  "cli.why.event": "來源 {source} · 類型 {type} · 對象 {subject}",
  "cli.why.claimed": "{worker} 領取（{name}）",
  "cli.why.started": "開始處理",
  "cli.why.session": "工作階段：{link}",
  "cli.why.finished": "結束：{summary}",
  "cli.why.stopped": "已停止",
  "cli.why.noSummary": "沒有填寫結論",
  "cli.why.retry": "本次未完成：{error}；重試時間 {time}",
  "cli.why.rejected": "未執行：{reason}",
  "cli.why.cardAsk": "提問",
  "cli.why.cardNotice": "通知",
  "cli.why.cardLine": "{kind}：{title}",
  "cli.why.options": "選項：{options}",
  "cli.why.owner": "本人",
  "cli.why.answered": "{by}回答「{title}」：{answer}",
  "cli.why.continued": "回答後繼續：第 {run} 輪",
  "cli.why.closed": "結案：{title}；{result}",
  "cli.why.rulesVersion": "規則版本 #{seq}",
  "cli.why.triggered": "觸發事件：{event}",
  "cli.why.timerSet": "安排複查：{about}；時間 {time}",
  "cli.why.timerCancelled": "取消複查：{key}",
  "cli.why.emitted": "發出事件：{event}",

  // ---- cli/mcp.ts ----
  "cli.mcp.status": "看現在的事項和卡片",
  "cli.mcp.why": "看一輪的事件、規則和結果",
  "cli.mcp.answer": "回答卡片；選項從 0 開始，也可以寫自己的答案",
  "cli.mcp.resolve": "將卡片結案，寫明已核實的結果",
  "cli.mcp.stop": "停止一輪",
  "cli.mcp.emit": "用本機來源傳送事件；相同編號只記一次",
  "cli.mcp.tell": "用本機來源傳送通知；相同編號只發一次",
  "cli.mcp.badTool": "工具名或參數不正確",
  "cli.mcp.notJson": "不是 JSON",
  "cli.mcp.badRequest": "請求格式不正確",
  "cli.mcp.noMethod": "沒有這個方法",

  // ---- cli/backup.ts ----
  "cli.backup.targetNotEmpty": "備份目錄不是空的：{target}",
  "cli.backup.notABackup": "這個目錄不像備份：缺 {db} 或 {key}",
  "cli.backup.masterKeyBroken": "備份裡的 master.key 壞了",
  "cli.backup.dbUnreadable": "備份裡的 hub.db 讀不出來",
  "cli.backup.hubRunning": "中台還在跑：先停掉它（例如 agent-autoloop service remove，或手動停服務），再還原",

  // ---- cli/uninstall.ts ----
  "cli.uninstall.removed": "刪掉了 {path}",
  "cli.uninstall.needsYes": "執行 agent-autoloop uninstall --yes 解除安裝程式，規則、金鑰和紀錄會保留。",
  "cli.uninstall.confirm": "解除安裝程式並保留資料？[y/N] ",
  "cli.uninstall.cancelled": "沒有解除安裝。",
  "cli.uninstall.doneWithData": "解除安裝好了。規則、金鑰和紀錄還留在 {home}。",
  "cli.uninstall.done": "解除安裝好了。",

  // ---- cli/self-update.ts ----
  "cli.selfUpdate.noBuild":
    "Release 裡沒有 {platform}-{arch} 的單一檔案版（只建 {built}）。這個平台要從原始碼裝，見 INSTALL.md 的「安裝」一節。",
  "cli.selfUpdate.rateLimited":
    "發布頁暫時不讓問了（HTTP {status}，沒登入的呼叫是按出口位址限次的）：過一陣再來，或者手動下載 {page}",
  "cli.selfUpdate.httpError": "沒能{what}：發布頁回傳 HTTP {status}（手動下載：{page}）",
  "cli.selfUpdate.unreachable": "連不上發布頁，沒能{what}（{why}）：等網路好了再來，或者手動下載 {page}",
  "cli.selfUpdate.whatLatest": "問出最新發布的版本",
  "cli.selfUpdate.whatDownload": "下載 {name}",
  "cli.selfUpdate.noTag": "發布頁答的東西裡沒有 tag_name，看不出最新是哪一版（手動下載：{page}）",
  "cli.selfUpdate.and": "和",
  "cli.selfUpdate.nothing": "沒有",
  "cli.selfUpdate.missingAssets":
    "{tag} 這一版沒有附 {missing}，這台電腦要的就是它（附了：{attached}）。換一版或者手動下載 {page}",
  "cli.selfUpdate.noSumInFile": ".sha256 裡讀不出檢查碼：{text}",
  "cli.selfUpdate.sumNameMismatch": ".sha256 說的是 {said}，不是這台電腦要的 {wanted}",
  "cli.selfUpdate.downloadBroke": "下載 {name} 斷了（{why}）：重來一次，或者手動下載 {page}",
  "cli.selfUpdate.emptyBody": "回覆裡沒有內容",
  "cli.selfUpdate.shortRead": "說好 {said} 個位元組，只到了 {got} 個",
  "cli.selfUpdate.longRead": "說好 {said} 個位元組，來的卻是 {got} 個：發布端說的長度不對",
  "cli.selfUpdate.sumMismatch":
    "下載下來的 {name} 和 Release 上的 .sha256 對不上，已經刪掉，什麼都沒換：說好 {published}，拿到 {got}。別拿自己找來的那一份去對——Release 上的 .sha256 才是憑據（INSTALL.md 講了為什麼自己重建的不一樣）。重下一次還是對不上就先別用，到 {page} 看看。",
  "cli.selfUpdate.notExecutable": "沒能把 {staged} 設成可執行（{why}）：什麼都沒換。",
  "cli.selfUpdate.swapFailed": "{why}。手上這一版還在用；{hub}",
  "cli.selfUpdate.hubStoppedAgain": "中台已經被停過一次（{again}）。",
  "cli.selfUpdate.hubStoppedRestarted": "中台已經被停過一次，已經重新啟動。",
  "cli.selfUpdate.hubStoppedNeedsUp": "中台已經被停過一次，要再 agent-autoloop up。",

  // ---- protocol ----
  // protocol/rules.ts
  "protocol.rules.badFile": "rules.json 有問題：\n{issues}",
  // 寫下去的那一份是說這句話的時候說的那種話；別人自己寫在 rules.json 裡的 askFirst 原樣留著，這裡只是沒寫時的預設。
  // 一條一句，中間的頓號就是分隔：protocol/rules.ts 按它切開。
  "protocol.rules.askFirstDefault": "刪資料、停服、花錢、對外發訊息、改產品方向、新建或輪換金鑰、修改權限",
  "protocol.rules.notEmpty": "不能為空",
  "protocol.rules.idWords": "只能用小寫字母、數字和 -",
  "protocol.rules.folderWin": "要是以 ~/、~\\、/ 或磁碟機代號（C:\\）開頭的目錄",
  "protocol.rules.folderPosix": "要是以 ~/ 或 / 開頭的目錄",
  "protocol.rules.whereObject": "{where}要是一個物件",
  "protocol.rules.missing": "{where}缺少 {name}",
  "protocol.rules.fieldProblem": "{where}的 {name} {problem}",
  "protocol.rules.unknownField": "{where}有不認得的欄位 {name}",
  "protocol.rules.duplicateName": "規則名「{name}」重複了",
  "protocol.rules.ruleWhere": "規則「{name}」",
  "protocol.rules.object": "要是一個物件",
  "protocol.rules.unknownAgentIs": "不是已登記的 Agent：{to}",
  "protocol.rules.count": "要是正整數",
  "protocol.rules.boolean": "只能是 true 或 false",
  "protocol.rules.oneOf": "只能是 {allowed}",
  "protocol.rules.channelList": "要是通道編號的清單",
  "protocol.rules.whenWhere": "{where}的 when ",
  "protocol.rules.unknownSourceIs": "不是已登記的來源：{source}",
  "protocol.rules.typeListWild": "要是事件類型的清單，可以用 x.* 或 *",
  "protocol.rules.cronNever": "{where}的定時永遠不會到來：{cron}",
  "protocol.rules.badCron": "不是有效的 cron",
  "protocol.rules.needWords": "{where}的 skill 和 prompt 至少寫一個",
  "protocol.rules.emitsWhere": "{where}的 emits ",
  "protocol.rules.typeList": "要是事件類型的清單",
  "protocol.rules.unknownChannel": "{where}的 channels 不是已登記的通道：{channel}",
  "protocol.rules.notJson": "不是 JSON：{why}",
  "protocol.rules.badZone": "不是有效的時區",
  "protocol.rules.wordList": "要是文字的清單",
  "protocol.rules.list": "要是一個清單",
  "protocol.rules.reservedSource": "來源 {id} 是保留的，定時用規則的 cron",
  "protocol.rules.sourceId": "來源的編號{words}：{id}",
  "protocol.rules.sourceWhere": "來源 {id} ",
  // 中台自己給的那個來源的名字：寫進 rules、進 /v1/state、進卡片的正文，所以它是一筆資料，不是一句話。
  "protocol.rules.scheduleSource": "定時",
  "protocol.rules.channelId": "通道的編號{words}：{id}",
  "protocol.rules.channelWhere": "通道 {id} ",
  "protocol.rules.trueFalse": "要是 true 或 false",
  "protocol.rules.agentId": "Agent 的編號{words}：{id}",
  "protocol.rules.commandList": "要是命令列的清單",
  "protocol.rules.minutes": "要是正整數（分鐘）",
  "protocol.rules.groupParallel": "群組「{group}」裡的規則 parallel 要一致",
  "protocol.rules.taskDuplicate": "定時任務「{name}」和別的規則或定時任務重名",
  "protocol.rules.taskWhere": "定時任務「{name}」",
  "protocol.rules.unknownSource": "不是已登記的來源",
  "protocol.rules.unknownAgent": "不是已登記的 Agent",
  "protocol.rules.taskNeedsCwd": "定時任務「{name}」寫了回答後照什麼做，還要寫 cwd：在哪接著做",
  "protocol.rules.taskNeedsWords": "定時任務「{name}」寫了 cwd，skill 和 prompt 至少寫一個：回答後照什麼做",

  // protocol/validate.ts
  "protocol.event.notObject": "事件要是一個 JSON 物件",
  "protocol.event.unknownField": "不認得的欄位：{name}",
  "protocol.event.text": "{name} 要是文字",
  "protocol.event.missing": "缺少 {name}",
  "protocol.event.tooLong": "{name} 最多 {limit} 個字",
  "protocol.event.hops": "hops 要是非負整數",
  "protocol.event.illFormedId": "id 裡有不完整的字元",
  "protocol.event.type": "type 只能用小寫字母、數字和 . _ -，以字母開頭",
  "protocol.event.subject": "subject 只能用字母、數字和 # . _ : / @ -",
  "protocol.event.link": "link 要是網址，非 ASCII 的字要先編碼",
  "protocol.result.notObject": "結果要是一個 JSON 物件",
  "protocol.result.unknownField": "結果裡有不認得的欄位",
  "protocol.result.outcome": "outcome 只能是 done、nothing、failed、cancelled",
  "protocol.result.tooLong": "summary、error、session 最多 500 字",
  "protocol.result.usage": "usage 要是物件，裡面要是有限的非負數字",
  "protocol.result.ask": "ask 每一項要有 title、text 和 2 到 5 個 options，recommend 是其中一個的序號，最多 5 項",
  "protocol.result.notice": "notice 每一項要有 title 和 text，最多 10 項",
  "protocol.result.resolve": "resolve 每一項要有卡片編號和 1000 字以內的核實依據，最多 50 項",
  "protocol.result.later": "later 每一項要有 key，以及帶時區的 at 和 about，或者 cancel: true，最多 10 項",
  "protocol.result.events": "events 最多 100 項",

  // protocol/client.ts
  "protocol.client.status": "中台回傳 {status}",

  // protocol/schema.ts
  "protocol.schema.unknownType": "沒有這個協定類型：{name}",

  // protocol/conformance.ts：斷言的話給跑 conformance 的人看，正文那幾條是它自己發進測試中台的探測資料。
  "protocol.conformance.status": "{path} 狀態碼",
  "protocol.conformance.shape": "{path} 格式",
  "protocol.conformance.bodyLimits": "事件正文邊界",
  "protocol.conformance.parallel": "檢查規則的 parallel 至少要是 2",
  "protocol.conformance.summary": "一致性檢查",
  "protocol.conformance.askTitle": "選擇 {tag}",
  "protocol.conformance.askText": "選擇一個",
  "protocol.conformance.optionA": "甲",
  "protocol.conformance.optionB": "乙",
  "protocol.conformance.otherTitle": "另一個 {tag}",
  "protocol.conformance.otherText": "核實後關閉",
  "protocol.conformance.outOfRange": "越界",
  "protocol.conformance.resolved": "已核實",
  "protocol.conformance.deliveryFailed": "舊訊息發送失敗",
  "protocol.conformance.told": "檢查完成",
  "protocol.conformance.notYours": "不能冒充",
  "protocol.conformance.streamIncomplete": "日誌流沒有完整事實",
  "protocol.conformance.streamMissing": "日誌流缺少事實",
  "protocol.conformance.streamLeaks": "日誌流洩漏金鑰記錄",
};
