// 简体中文：这个程序原本就是用这些话写的，所以这一份是 key 的事实来源。
//
// 每一条都是从原来的代码里逐字搬过来的，标点也一样——既有的测试断言的就是这些字，所以这里改一个字就是改一次行为。
// `{名字}` 是 host/i18n.ts 的 `t` 填进去的值；另一份表（i18n/zh-TW.ts）的类型是从这里读的，少一个 key 或多一个
// key 都过不了 typecheck。
//
// 分区按它们被说出来的地方排：kernel、host、worker、plugins、cli。一句话只属于一个地方。kernel 排第一个，因为
// 它那些话不走 `t()`：内核不许问环境，说哪一种是调用端传进去的 `lang`（`i18n/t.ts` 的 `say(lang, key)`）。
export const zhCN = {
  // ---- kernel/decide.ts ----
  "kernel.decide.unknownInput": "不认识的输入：{type}",
  "kernel.decide.backOnline": "连上了",
  "kernel.decide.tooDeep": "同一条处理链已超过 {hops} 层，后续事件已记录，没有继续派发。",
  "kernel.decide.loopStopped": "事件循环已停止",
  "kernel.decide.notYourRun": "这件活不归这个令牌",
  "kernel.decide.runInDoubt": "交给 {agent} 后超过 5 分钟没有回音，不确定做没做完；后续新任务照常处理。",
  "kernel.decide.workerNeverSeen": "{worker} 一直没连上中台，有 {waiting} 件任务等了 {minutes} 分钟没人接",
  "kernel.decide.workerSilent": "{worker} 已经 {minutes} 分钟没连上中台，有 {waiting} 件任务在排队或在跑",
  "kernel.decide.checkPower": "有没有开机联网",
  "kernel.decide.checkOffline": "是不是关机、休眠或断网了",
  "kernel.decide.workerOffline": "接单程序没连上",
  "kernel.decide.workerOfflineWords": "{situation}（请看一眼那台电脑{check}）。",
  "kernel.decide.ruleGone": "规则「{rule}」不在了，不再派发",
  "kernel.decide.ruleGoneWords":
    "规则「{rule}」不在了（删掉或改名了），排着的这一轮不再派发。还要做的话重新触发这件事。",
  "kernel.decide.noReason": "没说原因",
  "kernel.decide.onlyNoticeWhenFailed": "没跑成的一轮只能发通知",
  "kernel.decide.outsideWindow": "失败了，而下一次重试已在排程时段外：等下一次排程",
  "kernel.decide.gaveUp": "连续 {tries} 次没跑成，不再自动重试",
  "kernel.decide.gaveUpWords":
    "连续 {tries} 次自动处理没跑完（卡在：{error}），不再自动重试。解决后重新触发这件事，它会从头开始。",
  "kernel.decide.failingWords": "连续 3 次自动处理没跑完（卡在：{error}），{time} 会自动再试。",
  "kernel.decide.laterRan": "后来跑成了",
  "kernel.decide.resultCameBack": "结果回来了",
  "kernel.decide.byRound": "第 {id} 轮",
  "kernel.decide.outOfScope": "不在本轮核对范围",
  "kernel.decide.cannotEmit": "规则「{rule}」没有写可以发 {type}",
  "kernel.decide.handedInOther": "这一次执行已经交过不一样的结果",
  "kernel.decide.stopped": "已停止",
  "kernel.decide.noSuchCard": "没有这张卡片",
  "kernel.decide.notYourCard": "这个人不能回答这张卡片",
  "kernel.decide.notThatMessage": "不是发出去的那条消息",
  "kernel.decide.byTooLong": "回答人最多 {most} 字",
  "kernel.decide.refTooLong": "消息编号最多 {most} 字",
  "kernel.decide.handlingNote": "处理说明",
  "kernel.decide.answer": "回答",
  "kernel.decide.mustBeText": "{what}要是文字",
  "kernel.decide.textTooLong": "{what}最多 {most} 字",
  "kernel.decide.handled": "已处理",
  "kernel.decide.noSuchOption": "没有这个选项",
  "kernel.decide.rulesFixed": "改好了",
  "kernel.decide.rulesBroken": "rules.json 写错了，还在用旧规则",
  "kernel.decide.elsewhereNoCwd": "定时任务「{name}」没写 cwd，回答了没人接着做：只能 tell",
  "kernel.decide.fieldTooLong": "{field} 要是 500 字以内的文字",
  "kernel.decide.noSuchRun": "没有这一轮",
  "kernel.decide.runOver": "这一轮已经结束了",
  "kernel.decide.notToThisChannel": "这张卡片没有交给这个通道",

  // ---- kernel/cron.ts ----
  // 内核里的话，语言由调用端当参数传进来（host/i18n.ts 的 t() 是外壳在用的，内核拿不到它）。
  "kernel.cron.everyDay": "每天 {at}",
  "kernel.cron.everyWeek": "每周{day} {at}",
  "kernel.cron.weekdayNames": "日一二三四五六日",
  "kernel.cron.workdays": "工作日 {at}",
  "kernel.cron.everyMonth": "每月 {day} 日 {at}",

  // ---- kernel/card-page.ts ----
  "kernel.card.howHandled": "我实际怎么处理的（可不填）",
  "kernel.card.handling": "处理说明",
  "kernel.card.otherThought": "别的想法",
  "kernel.card.closeWithNote": "记录并结案",
  "kernel.card.send": "发送",
  "kernel.card.chose": "你选了「{option}」",
  "kernel.card.handlingWas": "处理说明：{text}",

  // ---- kernel/query.ts ----
  "kernel.query.handled": "已处理",

  // ---- kernel/store.ts ----
  "kernel.store.logMoved": "日志已变化，请重读后再提交",

  // ---- kernel/http.ts ----
  "kernel.http.owner": "本人",
  "kernel.http.worker": "接单程序",
  "kernel.http.channel": "通道",
  "kernel.http.source": "来源",
  "kernel.http.needKey": "要{whom}自己的密钥",
  "kernel.http.notJson": "不是 JSON",
  "kernel.http.noSuchCard": "没有这张卡片",
  "kernel.http.linkExpired":
    "这个链接过期了。在装它的电脑上运行 agent-autoloop status，还没答的卡片都在那里，可以接着回答",
  "kernel.http.byLink": "链接",
  "kernel.http.noWebhook": "这个来源不收 Webhook",
  "kernel.http.needSourceOrWorker": "要来源或接单程序的密钥",
  "kernel.http.tellShape": "要有正确的 key 和 text，接单程序还要写 task，text 最多 20000 字；问你的写 task 和 ask",
  "kernel.http.noSuchTask": "这台接单程序没有这个定时任务",
  "kernel.http.askShape": "问你的只写 task 和 ask，ask 和回执里的一样：title、text、2 到 5 个 options",
  "kernel.http.claimShape": "claim 是这次领活的编号，最多 200 字",
  "kernel.http.keyGone": "密钥已失效",
  "kernel.http.resolveReason": "写一句处理结果，最多 1000 字",
  "kernel.http.needVersion": "要说明是哪个版本",
  "kernel.http.badId": "编号不正确",
  "kernel.http.badSeq": "日志序号不正确",
  "kernel.http.badKeyName": "密钥名字不正确",
  "kernel.http.noSuchPath": "没有这个地址",
  "kernel.http.tooLarge": "请求最多 1024 KB",

  // ---- host/notify.ts ----
  "notify.trouble.win": "桌面通知不可用：Windows 上没有可用的通知程序，卡片会跳过通知",
  "notify.trouble.linux": "桌面通知不可用：这台电脑没有图形会话（DISPLAY 和 WAYLAND_DISPLAY 都没设），卡片会跳过通知",
  "notify.trouble.unknown": "桌面通知不可用：问不到这台电脑的图形会话，卡片会跳过通知",

  // ---- host/permissions.ts ----
  "permissions.noUser": "不知道当前用户是谁（USERNAME 没有设）",
  "permissions.icaclsBroken": "icacls 运行不了：{why}",
  "permissions.icaclsRefused": "icacls 没能锁定 {target}",
  "permissions.icaclsUnreadable": "icacls 问不到 {target} 的权限清单",
  "permissions.othersLeft": "icacls 没能去掉 {target} 上其他人的权限（{others}）",
  "permissions.neverLocked": "还没有锁过文件权限：运行一次 agent-autoloop init 或 up",
  "permissions.trouble": "{trouble}。同一台电脑上的其他用户可能读得到 {home} 里的东西",

  // ---- host/assets.ts ----
  "assets.missing":
    "这个打包版里没有 {name}：建置时内嵌的清单漏了它（host/assets.ts 的 ASSETS，由 scripts/build-binary.ps1 / .sh 写进 SEA 设定）。{why}",

  // ---- host/config.ts ----
  "config.listen.shape": "hub.listen 要写成 主机:端口（IPv6 用 [地址]:端口）：{listen}",
  "config.listen.port": "hub.listen 的端口要在 1 到 65535 之间：{listen}",
  "config.notInstalled": "还没装好：先运行 agent-autoloop init",

  // ---- host/http.ts ----
  "http.serverError": "中台出错了",

  // ---- host/plugin-loaders.ts ----
  "plugin.sourceInPackaged":
    '{name} 是源码插件（plugins/{name}/{kind}.ts），这个打包版跑不了外部的 .ts 文件。在 {manifest} 里写 {"runtime":"process","entry":"…"}，让它当一个独立程序被调用（见 docs/plugins.md）。',

  // ---- host/plugins.ts ----
  "plugin.badName": "插件名字不正确：{name}",
  "plugin.none": "没有 {name} 的插件（plugins/{name}/{kind}.ts）",

  // ---- host/plugin-manifest.ts ----
  "manifest.runtime": "{name} 的 plugin.json 里 runtime 只能是 {allowed}，现在写的是 {written}",
  "manifest.or": " 或 ",
  "manifest.entryMissing": '{name} 的 plugin.json 写了 runtime: "process"，还要用 entry 指出要运行的程序',
  "manifest.entryAbsolute": "{name} 的 plugin.json 里 entry 要是插件目录内的相对路径，不能是绝对路径：{entry}",
  "manifest.entryEscapes": "{name} 的 plugin.json 里 entry 走出了插件目录：{entry}",
  "manifest.args": "{name} 的 plugin.json 里 args 要是一串字符串，每一项都是一个参数",

  // ---- host/plugin-process.ts ----
  "pluginProcess.cannotStart": "{name} 插件的程序起不来（{program}）：{why}",
  "pluginProcess.signalled": "{name} 插件的程序被 {signal} 结束了，没有答复 {call}",
  "pluginProcess.saidNothing": "{name} 插件对 {call} 什么都没答（退出码 {status}）",
  "pluginProcess.notJson": "{name} 插件对 {call} 答的不是一行 JSON：{line}",
  "pluginProcess.noReason": "没说原因（{line}）",
  "pluginProcess.said": "{name} 插件说：{said}",
  "pluginProcess.channelNotProcess":
    '{name} 是通道插件，现在还不能用 runtime: "process"：通道是和中台一样长命的循环，不是一次一答的翻译。用别的语言写通道，直接当独立程序连中台的 HTTP 协议（见 docs/plugins.md 的通道一节），不必经过插件机制。',
  "pluginProcess.entryGone": "{name} 的 plugin.json 指的程序不在：{entry}",

  // ---- host/runtime.ts ----
  "runtime.masterKeyBroken":
    "{file} 坏了（应该是 43 个字符），中台不启动。从备份恢复这个文件；没有备份就删掉它，重启会生成新的，但已经发出的卡片链接和正在跑的轮次会失效。",
  "runtime.rulesGone": "找不到 {file}，被删掉或移走了？放回去就会接着用",
  "runtime.rulesUnreadable": "没有权限读 {file}，改回能读的权限就会接着用",
  "runtime.rulesTrouble": "读不到 {file}：{why}",
  "runtime.noRules": "缺少规则",
  "runtime.noSuchRun": "没有这一轮",

  // ---- host/self-replace.ts ----
  "selfReplace.nothingStaged": "没有要换上去的文件：{staged} 不在",
  "selfReplace.cannotRenameRunning":
    "没能把手上这个 {name} 换开，什么都没动，下载到的那份已经删掉（{why}）：这个文件被别的程序打开着（杀毒软件在读、调试器挂着）就是这样，过一阵再来一次",
  "selfReplace.lost":
    "换文件失败了，而且没能把旧的放回去：现在 {executable} 不在，旧的在 {old}。把它改回原名就能用（{why}；放回时 {putBack}）",
  "selfReplace.rolledBack": "换文件失败了，已经回到原样（{why}）",

  // ---- host/server.ts ----
  "server.noWebhook": "这个来源不收 Webhook",
  "server.adapterBroken": "{adapter} 这个插件装不起来",
  "server.adapterBrokenCode": "{adapter} 这个插件装不起来（{code}）",
  "server.adapterBrokenTail": "，中台日志里写了是什么",
  "server.badSignature": "验签没过",

  // ---- host/service.ts, host/service-win.ts ----
  "service.description": "Agent 自动化中台",
  "service.descriptionNamed": "Agent 自动化中台（{label}）",
  "service.unitControlChars": "systemd unit 的值不能包含控制字符",
  "service.noBornAt": "问不出本进程的创建时刻：up.pid 少了这一项，下一次 up 会说看不清这把锁，而不是把它当空的。",
  "service.winNote": "Windows 上靠计划任务常驻：停了之后最多等 5 分钟才会自己回来。",
  "service.winNoteNoLogon":
    "Windows 上靠计划任务常驻，而这台电脑不让登录时就启动（通常是加了域）：登录后和停了之后都最多等 5 分钟。",
  "service.systemUnit": "这台电脑用的是系统级服务，运行 systemctl restart {name} 才会用上新版。",
  "service.winPathQuotes": "Windows 上的路径不能包含引号或控制字符",
  "service.winHomeNewline": "AGENT_AUTOLOOP_HOME 不能包含换行",

  // ---- host/up.ts ----
  "up.lockUnclear": "看不清 {file} 里的号还在不在（列进程没成功）：确认没有别的 up 在跑之后，把它删掉再来",
  "up.alreadyRunning": "已经在跑了（进程 {pid}）",
  "up.notLoopback": "{host} 不是本机回环地址，中台会向这个地址所在的网络开放；前面要有 HTTPS 反向代理",

  // ---- host/version.ts ----
  "version.line": "agent-autoloop {release}（提交 {commit}）",
  "version.unreleased": "未发布",

  // ---- worker/agents.ts ----
  "agents.notFound": "找不到 {name}：先装好并登录",

  // ---- worker/launcher.ts ----
  "launcher.usage": "用法：agent-autoloop internal:launch <stdout 文件> <stderr 文件> <exit 文件> -- <命令行>",
  "launcher.cannotOpen": "启动不了：写不了输出文件（{why}）",
  "launcher.cannotStart": "启动不了：{why}",

  // ---- worker/worker.ts ----
  "worker.cwdGone": "在 {cwd} 启动不了：这个目录不存在",
  "worker.gaveNothing": "它什么也没给",
  "worker.unreadableOutput": "读不懂这个 Agent 的输出：{why}",
  "worker.receiptUnreadable.title": "「{rule}」的回执读不懂",
  "worker.receiptUnreadable.text":
    "这一轮按第一行算结束了，但它要中台做的事没有生效（{problem}）。原文在 {file}，留 {days} 天。",
  "worker.stopped": "已停止",
  "worker.timedOut": "超过 {minutes} 分钟还没结束，已停止",
  "worker.noResult": "没留下结果",
  "worker.groupNotConfirmed": "停止信号发出后没能确认进程组已结束：这一轮按没跑成记，不再重试，进程可能还在。",
  "worker.hubUnreachable": "{name} 连不上中台已经 {minutes} 分钟了，派给它的活暂时没人接；它还在一直重试。",

  // ---- plugins/desktop/channel.ts ----
  "desktop.words": "运行 agent-autoloop status 查看",
  "desktop.title": "Agent 问你一个问题",
  "desktop.hubUnreachable": "连不上中台：{why}",
  "desktop.notSent": "卡片 {card} 的桌面通知没发出：{why}",

  // ---- plugins/feishu/channel.ts ----
  "feishu.decided": "你选了「{chosen}」，已记录，等待处理。",
  "feishu.doneWithResult": "你选了「{chosen}」。已执行：{result}",
  "feishu.done": "你选了「{chosen}」。已执行。",
  "feishu.closed": "不用决定了：{result}",
  "feishu.note": "处理说明：{note}",
  "feishu.noteLabel": "处理说明（可不填）",
  "feishu.notePlaceholder": "比如：已回复他视频下周发；或：群发广告，不用管",
  "feishu.noteSubmit": "记录并结案",
  "feishu.noOwner": "飞书通道要在 config.json 写 user，或者先 lark-cli auth login",

  // ---- plugins/webhook/channel.ts, plugins/webhook/templates.ts ----
  "webhook.source": "来源：{rule}",
  "webhook.openCard": "点击处理",
  "webhook.openLink": "打开链接",
  "webhook.discordTooLong": "Discord 消息超过 2000 个字，请缩短卡片",
  "webhook.wecomTooLong": "企微消息超过 2048 字节，请缩短卡片",
  "webhook.noTemplate": "没有这个 Webhook 模板：{platform}",
  "webhook.status": "返回 {status}",
  "webhook.sendFailed": "发送失败：{why}",
  "webhook.slackNotOk": "Slack 没有确认收到消息",

  // ---- plugins/acp ----
  "acp.unfinished": "ACP 没有完成这一轮",
  "acp.unfinishedWhy": "ACP 没有完成这一轮：{why}",
  "acp.noCommand": "ACP 要在 command 写启动命令",
  "acp.exited": "ACP 在交回结果前退出：{code}",
  "acp.noMethod": "不支持这个方法",
  "acp.closedOutput": "ACP 在交回结果前关掉了输出",
  "acp.noResume": "这个 ACP Agent 不支持恢复会话",
  "acp.badVersion": "不支持 ACP 版本 {version}",
  "acp.noSession": "ACP 没有返回会话编号",
  "acp.modelUnavailable": "ACP 会话没有提供可选模型：{model}",
  "acp.modelUnconfirmed": "ACP 没有确认切换到模型：{model}",

  // ---- plugins/claude, plugins/codex, plugins/dsh, plugins/command ----
  "agent.noResult": "没留下结果",
  "agent.noReason": "没留下原因",
  "agent.exitCode": "退出码 {code}：{why}",
  "claude.notLoggedIn": "Claude Code 没有登录：运行 claude auth login",
  "claude.unusable": "Claude Code 用不了：{why}",
  "codex.unfinished": "Codex 没跑完这一轮",
  "codex.noResult": "Codex 没有完成并留下实际结果",
  "codex.notLoggedIn": "Codex 没有登录或用不了：运行 codex login（{why}）",
  "dsh.unfinished": "DSH 没跑完这一轮",
  "dsh.noResult": "DSH 没有完成并留下实际结果",
  "dsh.aborted": "这一轮被中止了",
  "dsh.blocked": "这一轮被卡住了，没有完成",
  "dsh.maxTokens": "这一轮用完了输出上限",
  "dsh.tooOld":
    "DSH 版本太旧，要 0.2.2 或更新：npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local",
  "dsh.unusable": 'DSH 用不了：运行 dsh headless "hi" 看看（{why}）',

  // ---- cli/main.ts：说明和用法 ----
  // `{prompt}` 在 HELP 和 INIT_USAGE 里是命令行上要原样打出来的那两个字，不是填进去的值：t() 填不到的
  // `{名字}` 原样留着，这一条就是靠这个。
  "cli.help":
    "Agent 自动化中台\n\n  agent-autoloop init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service]\n                                    在这台电脑上装好：一个人一台电脑就够\n  agent-autoloop try                     用你的 Agent 跑一遍完整流程\n  agent-autoloop why <第几轮> [--json]  查看时间线；--json 输出原始事实\n  agent-autoloop conformance <地址> --config <测试凭据文件>\n                                    在测试中台上检查协议\n  agent-autoloop status [--json]         现在什么情况：谁在线、等你什么、在做什么、做过什么、花了多少\n                                     --json 输出 /v1/state 的原始结构，给脚本用\n  agent-autoloop answer <卡片> [序号] [--text 别的想法]\n                                    回答一张卡片；通知不用写序号\n  agent-autoloop resolve <卡片> <结果>   这件事不用决定了，写一句结果\n  agent-autoloop doctor                  查哪里没配好\n  agent-autoloop check [文件]            检查规则文件，不碰中台；不写文件就查 rules.json\n  agent-autoloop rules explain           按本机 rules.json 说明生效的规则、Agent、通道和下次定时\n  agent-autoloop emit <类型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]\n                                    发一条事件；--dry-run 只预演会派给谁，不连接中台\n  agent-autoloop tell <编号> [--task 定时任务名]\n                                    直接告诉你一件事，内容从标准输入读\n  agent-autoloop ask --task <定时任务名>\n                                    定时任务问你一件事：标准输入传回执那样的 ask；你答了，它的 Agent 在 cwd 接着做\n  agent-autoloop stop <第几轮>           停掉一轮\n  agent-autoloop key new <source|worker|channel|owner> <名字>\n                                    新建一把密钥（只显示这一次）\n  agent-autoloop key list                有哪些密钥\n  agent-autoloop key remove <种类> <名字>  立即收回一把密钥\n  agent-autoloop add <git 地址>           安装插件，不自动更新\n  agent-autoloop mcp                      用标准输入输出连接 MCP 客户端\n  agent-autoloop join <中台地址> --worker <名字> --key <密钥> [--no-service]\n                                    另一台电脑只接活时用\n  agent-autoloop backup [目录]           备份数据库、主密钥、配置、规则和 secrets.env；不填目录就放在 ~/.agent-autoloop/backups\n  agent-autoloop restore <目录> [--yes]  停掉中台后，用一次备份恢复本机数据\n  agent-autoloop update                  更新到最新发布的版本\n  agent-autoloop uninstall [--yes]       卸载程序并保留数据；--yes 跳过确认\n  agent-autoloop lang [zh-TW|zh-CN]      这个程序说哪种中文；不写就说现在说的是哪种\n  agent-autoloop --version               版本和当前提交\n  agent-autoloop help                    这份说明\n  agent-autoloop up                      启动（平时由系统服务调用）\n  agent-autoloop service install|remove  系统服务\n\n配置和数据在 {home}。规则在 {rules}，改了自动生效。",
  "cli.usage.init":
    "用法：agent-autoloop init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service] [--lang zh-TW|zh-CN]\n\n  --agent      只接这个 Agent：claude 或 codex。不写就接本机装好的全部\n  --command    改用别的命令行 Agent；{prompt} 会作为一个独立参数传进去\n  --port       中台监听的端口，默认 3350\n  --no-service 先不装系统服务，之后手动运行 agent-autoloop up\n  --lang       这个程序说哪种中文：zh-TW（默认）或 zh-CN",
  "cli.usage.try":
    "用法：agent-autoloop try\n\n用本机接好的 Agent 跑一遍完整流程：提问，进程退出等你回复，你拍板，它接着干完。",
  "cli.usage.status":
    "用法：agent-autoloop status [--json]\n\n现在什么情况：谁在线、等你什么、在做什么、做过什么、花了多少。\n  --json  输出 /v1/state 的原始结构，给脚本和看板用",
  "cli.usage.update": "用法：agent-autoloop update\n\n更新到最新发布的版本。没有参数。",
  "cli.usage.uninstall":
    "用法：agent-autoloop uninstall [--yes]\n\n卸载程序并保留规则、密钥和记录。\n  --yes  跳过确认",
  "cli.usage.restore":
    "用法：agent-autoloop restore <目录> [--yes]\n\n恢复会替换本机的数据库、主密钥、配置、规则和 secrets.env；先停掉中台，--yes 跳过确认。",
  "cli.usage.lang":
    "用法：agent-autoloop lang [zh-TW|zh-CN]\n\n这个程序说哪种中文，写进 config.json 的 lang；不写就说现在说的是哪种。\nAGENT_AUTOLOOP_LANG 盖得过它。\n要先 init 才有 config.json 可写；init 之前用 AGENT_AUTOLOOP_LANG 或 init --lang。",
  "cli.usage.add": "用法：agent-autoloop add <git 地址>",
  "cli.usage.answer": "用法：agent-autoloop answer <卡片> [序号] [--text 别的想法]",
  "cli.usage.ask":
    '用法：agent-autoloop ask --task <定时任务名>，问题从标准输入读：\n  { "title": "…", "text": "…", "options": ["…", "…"], "recommend": 0, "about": "留给接着做的", "key": "这件事的固定名字" }\nrules.json 里这个定时任务要写 cwd；你答了，中台叫醒它的 Agent 在 cwd 照 skill、prompt 接着做。',
  "cli.usage.backup": "用法：agent-autoloop backup [目录]",
  "cli.usage.check": "用法：agent-autoloop check [文件]",
  "cli.usage.conformance": "用法：agent-autoloop conformance <测试中台地址> --config <测试凭据文件>",
  "cli.usage.doctor": "用法：agent-autoloop doctor",
  "cli.usage.emit":
    "用法：agent-autoloop emit <类型> [--dry-run] [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]",
  "cli.usage.join": "用法：agent-autoloop join <中台地址> --worker <名字> --key <密钥> [--no-service]",
  "cli.usage.key":
    "用法：agent-autoloop key new <source|worker|channel|owner> <名字>\n      agent-autoloop key list\n      agent-autoloop key remove <种类> <名字>",
  "cli.usage.keyNew": "用法：agent-autoloop key new <source|worker|channel|owner> <名字>",
  "cli.usage.keyRemove": "用法：agent-autoloop key remove <种类> <名字>",
  "cli.usage.mcp": "用法：agent-autoloop mcp",
  "cli.usage.resolve": "用法：agent-autoloop resolve <卡片> <结果>",
  "cli.usage.rules": "用法：agent-autoloop rules explain",
  "cli.usage.service": "用法：agent-autoloop service install|remove",
  "cli.usage.stop": "用法：agent-autoloop stop <第几轮>",
  "cli.usage.tell": "用法：agent-autoloop tell <编号> [--task 定时任务名]，内容从标准输入读",
  "cli.usage.up": "用法：agent-autoloop up",
  "cli.usage.why": "用法：agent-autoloop why <第几轮> [--json]",
  "cli.usage.internalPlugin": "用法：agent-autoloop internal:plugin <插件名字> [参数…]",

  // ---- cli/main.ts：init、join、try ----
  "cli.unknownFlags": "不认识的参数：{flags}",
  "cli.unknownArgs": "不认识的参数：{args}",
  "cli.noOwnerKey": "这台电脑上没有本人的密钥（只接活的电脑看不了）",
  "cli.starter.source": "本机",
  "cli.starter.channel": "桌面通知",
  "cli.starter.rule": "试一下",
  "cli.starter.prompt":
    '这是 agent-autoloop try 的试跑，不要改任何文件，不要做别的事。读资料文件。如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，options 写 ["蓝色","绿色"]，key 写 try-color，第一行结论写“问了一个问题”。如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里选的那一项，不附回执。',
  "cli.skillNotLinked": "没能把 skill 接到你的 Agent 上（{why}）。这不影响中台，之后可以手动放。",
  "cli.alreadyInstalled": "已经装过了：{file}",
  "cli.noAgentFound":
    "这台电脑上没找到 Claude Code 或 Codex。先装好并登录，或者用 --command 指定别的命令行 Agent，比如 --command 'hermes chat -Q -q {prompt}'",
  "cli.init.channelLine": "  通道：桌面通知",
  "cli.init.nextNoService": "先运行 {run} up 启动中台，再开一个终端运行 {run} try 跑一遍完整流程。",
  "cli.init.next": "运行 {run} try 跑一遍完整流程。",
  "cli.init.done": "装好了。\n  Agent：{agents}\n{reach}  规则：{rules}\n\n{next}",
  "cli.join.already": "已经配置过了：{file}。为防止覆盖现有设置，请先备份并手动修改配置。",
  "cli.join.next": "运行 {run} up 开始。",
  "cli.join.done": "这台电脑以 {name} 的身份接活了。{next}",
  "cli.card.ask": "等你决定",
  "cli.card.notice": "要你留意",
  "cli.card.recommend": "（推荐）",
  "cli.card.howToAnswerAsk": "回答：agent-autoloop answer {card} <序号>",
  "cli.card.howToAnswerNotice": "处理完了：agent-autoloop answer {card}",
  "cli.choose": "选几？",
  "cli.chooseRange": "输入 1 到 {max}。",
  "cli.try.noSourceKey": "这台电脑上没有来源的密钥。",
  "cli.try.hubUnreachable": "连不上中台（{why}）：先 agent-autoloop up 或 agent-autoloop service install",
  "cli.try.retrying": "上一次没跑成（{error}），{time} 会自动再试，这次的事件会一起处理。",
  "cli.try.sent": "事件发出去了，Agent 开始干活……",
  "cli.try.agentFailed": "Agent 没跑成：{error}\n运行 agent-autoloop doctor 看看。",
  "cli.try.cardPrefix": "试跑",
  "cli.try.asked": "Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。",
  "cli.try.answerHint": "{how}\n答完运行 agent-autoloop status，能看到它接着把活干完。",
  "cli.try.received": "收到，Agent 接着干……",
  "cli.try.done": "它把活干完了：{result}\n\n通了。接下来把 {rules} 改成你自己的规则，或者跟你的 Agent 说一句。",
  "cli.try.timeout": "五分钟没等到结果。运行 agent-autoloop doctor 看看。",

  // ---- cli/main.ts：status ----
  "cli.run.claimed": "在跑",
  "cli.run.queued": "排队",
  "cli.run.done": "做完了",
  "cli.run.nothing": "没事可做",
  "cli.run.unknown": "不确定",
  "cli.run.cancelled": "停了",
  "cli.run.retrying": "等重派",
  "cli.status.totals": "在跑 {running} · 排队 {queued} · 今天做完 {doneToday} · 等你 {waiting}",
  "cli.status.timed": "定时",
  "cli.status.elsewhere": "（在别处：{where}）",
  "cli.status.timedLine": "  {name}{where}：{every}，下次 {next}",
  "cli.status.recentCards": "最近的卡片",
  "cli.status.recentRuns": "最近几轮",
  "cli.status.unrouted": "没有规则接的事件",

  // ---- cli/main.ts：answer、resolve ----
  "cli.answer.unchanged": "这张卡片已经处理过了，这次没有改动。",
  "cli.answer.closed": "结案了。",
  "cli.answer.received": "收到，Agent 接着干。",

  // ---- cli/main.ts：doctor ----
  "cli.doctor.notInstalled": "还没装好：运行 agent-autoloop init",
  "cli.doctor.filePermissions": "文件权限降级：{why}",
  "cli.doctor.rules": "规则 {file}",
  "cli.doctor.noAnswerers": "{channel}没写 answerers：这个通道里谁都能回答卡片。",
  "cli.doctor.serviceRunning": "系统服务在跑",
  "cli.doctor.systemService": "系统级服务在跑",
  "cli.doctor.serviceStopped": "系统服务没在跑：agent-autoloop service install",
  "cli.doctor.hub": "中台 {url}（{commit}）",
  "cli.doctor.hubUnreachable": "连不上中台 {url}：{why}",
  "cli.doctor.online": "在线",
  "cli.doctor.offline": "不在线",
  "cli.doctor.agent": "{name}（{worker}）{state}",
  "cli.doctor.agentUsable": "{name} 可以用",
  "cli.doctor.channel": "{name}{state}",
  "cli.doctor.noChannels":
    "还没接通道：Agent 问你时不会主动告诉你，要自己运行 agent-autoloop status 看。接法见 {manual}",
  "cli.doctor.onlyDesktopMuted":
    "只接了桌面通知，而这台电脑弹不出通知：Agent 问你时得自己运行 agent-autoloop status 看。",
  "cli.doctor.onlyDesktop":
    "只接了桌面通知：Agent 问你时只有这台电脑会弹通知，人不在电脑前、或者电脑没有图形界面就看不到。",
  "cli.doctor.onlyDesktopTail": "{only}要发到飞书、钉钉这些地方，接法见 {manual}",
  "cli.doctor.stateUnreadable": "读不到中台状态：{why}",

  // ---- cli/main.ts：check、key、emit、backup、restore、tell、ask、stop、add、update ----
  "cli.rulesUnreadable": "读不到 {file}：{why}",
  "cli.check.ok": "规则没问题：{file}",
  "cli.key.removed": "密钥已失效。",
  "cli.key.notThere": "没有这把密钥，可能已经删过了。",
  "cli.emit.dryRunWithKey": "--dry-run 按这台电脑的来源预演，不能和 --key 一起用",
  "cli.emit.noSourceNameForDryRun": "这台电脑上没有来源的密钥：--dry-run 需要知道来源名",
  "cli.emit.preview": "预演（按本机 rules.json，不连接中台、不写日志）：",
  "cli.emit.noSourceKey": "这台电脑上没有来源的密钥：用 --key",
  "cli.emit.routed": "交给了：{to}",
  "cli.emit.unrouted": "记下了，没有规则接它。",
  "cli.backup.done": "备份好了：{target}\n  {files}\n里面有密钥，把它放到安全的地方；恢复要中台停下来。",
  "cli.restore.needsYes": "恢复会替换本机数据；确认后运行 agent-autoloop restore <目录> --yes",
  "cli.restore.confirm": "恢复会替换本机的数据库、主密钥、配置、规则和 secrets.env，继续？[y/N] ",
  "cli.restore.cancelled": "没有恢复。",
  "cli.restore.done": "恢复好了。原来的文件在 {safety}。\n启动：agent-autoloop up 或 agent-autoloop service install",
  "cli.tell.empty": "要说的话从标准输入传，不能为空。",
  "cli.tell.notWorker": "这台电脑不是接单程序",
  "cli.tell.noSourceKey": "这台电脑上没有来源的密钥",
  "cli.tell.duplicate": "这件事已经说过了，这次没再发。",
  "cli.tell.sent": "说了。",
  "cli.ask.badJson": "问题从标准输入传，是一段 JSON：和回执里的 ask 一样",
  "cli.ask.duplicate": "同一件事还在等你回答，这次没再问。",
  "cli.ask.asked": "问了。",
  "cli.stop.told": "通知它停了。",
  "cli.add.driveOnly":
    "「{url}」只是一个盘符，不是一个地址：写全要装的那个仓库的路径或 URL（比如 {drive}:/path/to/plugin）。",
  "cli.add.badName": "插件名字「{name}」不能用：只能用小写字母、数字和 -，规则里的 use 也写这个名字",
  "cli.add.cloneFailed": "安装失败。",
  "cli.add.installed": "已安装 {name}。",
  "cli.add.badManifest": "但它的 plugin.json 写错了：{why}",
  "cli.add.isProcess": '它声明自己是一个外部程序（runtime: "process"），跑的是 {entry}。',
  "cli.add.isSource": '它没有声明 runtime，按源码插件用（runtime: "source"）：中台加载它的时候会执行它。',
  "cli.plugin.noMain": "{name} 这个插件没有可以这样跑的活（它没有导出 main）",
  "cli.update.newest": "已经是最新的（{to}）。",
  "cli.update.restarted": "中台已经用新版重新启动。",
  "cli.update.wasUpNoService": "中台为这次换文件停掉了，而本机没装常驻：再 agent-autoloop up 启一次，用的就是新版。",
  "cli.update.upAgain": "再 agent-autoloop up 就用上新版了（本机没装常驻）。",
  "cli.update.done": "更新好了（{to}）。{back}",
  "cli.update.oldKept": "旧的那一个还在 {old}，下次启动会自己清掉。",
  "cli.update.newestSource": "已经是最新的{version}。",
  "cli.update.doneSource": "更新好了{version}。{told}",
  "cli.update.gitFailed": "git {command} 没成功：{why}",

  // ---- cli/main.ts：lang ----
  "cli.lang.now": "现在说的是 {lang}。",
  "cli.lang.changed": "以后说 {lang}。",
  "cli.lang.unknown": "不认识的语言：{told}。只能是 {allowed}",
  "cli.lang.overridden": "注意：AGENT_AUTOLOOP_LANG 设成了 {env}，它盖得过 config.json 里写的。",

  // ---- cli/spend.ts ----
  "cli.spend.today": "今天",
  "cli.spend.week": "最近 7 天",
  "cli.spend.zero": "{label} 0 轮",
  "cli.spend.missing": "（{rounds} 轮没上报）",
  "cli.spend.noTokens": "Token 没上报",
  "cli.spend.tokens": "{amount} Token{missing}",
  "cli.spend.noCost": "费用没上报",
  "cli.spend.line": "{label} {rounds} 轮 · {tokens} · {cost}",
  /** 紧凑计数的单位，中间加一个空格好读：zh-CN 是万和亿，zh-TW 是萬和億。 */
  "cli.spend.units": "万|亿",

  // ---- cli/explain.ts ----
  "cli.explain.whenEvent": "来源 {source} · {types}",
  "cli.explain.whenCron": "定时 {cron}（下次 {next}）",
  "cli.explain.parallel": "并发 {n}",
  "cli.explain.resume": "接着上一轮的会话",
  "cli.explain.group": "组 {group}",
  "cli.explain.tell": "通知 {tell}",
  "cli.explain.hasSkill": "有 Skill",
  "cli.explain.hasPrompt": "有 Prompt",
  "cli.explain.emits": "可发 {source} {types}",
  "cli.explain.header": "时区 {zone}；先问你：{askFirst}；{count} 条规则",
  "cli.explain.sources": "来源：{list}",
  "cli.explain.sourceItem": "{id}（{name}）",
  "cli.explain.agents": "Agent：{list}",
  "cli.explain.agentItem": "{id}（{name}，{worker}，权限 {access}）",
  "cli.explain.channels": "通道：{list}",
  "cli.explain.channelItem": "{id}（{name}{answerers}{links}）",
  "cli.explain.answerers": "，回答人 {list}",
  "cli.explain.withLinks": "，带链接",
  "cli.explain.rulesHeading": "规则：",
  "cli.explain.ruleLine": "  {name}：{details}",
  "cli.explain.elsewhereLine": "  {name}：在别处（{where}）{cron}{answers}",
  "cli.explain.elsewhereAnswers": "；问你的，回答后交给 {agent} 在 {cwd} 接着做",
  "cli.explain.event": "事件：{source} {type}",
  "cli.explain.unregisteredSource": "来源 {source} 没有登记在 rules.json 的 sources 里",
  "cli.explain.noRule": "没有规则接这条事件；真发出去会记成「没有规则接的事件」。",
  "cli.explain.willGo": "会派给：",
  "cli.explain.goesTo": "  {name} → {to} · {cwd}",

  // ---- cli/why.ts ----
  "cli.why.header": "第 {id} 轮 · {rule}",
  "cli.why.noSubject": "无",
  "cli.why.event": "来源 {source} · 类型 {type} · 对象 {subject}",
  "cli.why.claimed": "{worker} 领取（{name}）",
  "cli.why.started": "开始处理",
  "cli.why.session": "会话：{link}",
  "cli.why.finished": "结束：{summary}",
  "cli.why.stopped": "已停止",
  "cli.why.noSummary": "没有填写结论",
  "cli.why.retry": "本次未完成：{error}；重试时间 {time}",
  "cli.why.rejected": "未执行：{reason}",
  "cli.why.cardAsk": "提问",
  "cli.why.cardNotice": "通知",
  "cli.why.cardLine": "{kind}：{title}",
  "cli.why.options": "选项：{options}",
  "cli.why.owner": "本人",
  "cli.why.answered": "{by}回答「{title}」：{answer}",
  "cli.why.continued": "回答后继续：第 {run} 轮",
  "cli.why.closed": "结案：{title}；{result}",
  "cli.why.rulesVersion": "规则版本 #{seq}",
  "cli.why.triggered": "触发事件：{event}",
  "cli.why.timerSet": "安排复查：{about}；时间 {time}",
  "cli.why.timerCancelled": "取消复查：{key}",
  "cli.why.emitted": "发出事件：{event}",

  // ---- cli/mcp.ts ----
  "cli.mcp.status": "查看现在的事项和卡片",
  "cli.mcp.why": "查看一轮的事件、规则和结果",
  "cli.mcp.answer": "回答卡片；选项从 0 开始，也可以写自己的答案",
  "cli.mcp.resolve": "将卡片结案，写明已核实的结果",
  "cli.mcp.stop": "停止一轮",
  "cli.mcp.emit": "用本机来源发送事件；相同编号只记一次",
  "cli.mcp.tell": "用本机来源发送通知；相同编号只发一次",
  "cli.mcp.badTool": "工具名或参数不正确",
  "cli.mcp.notJson": "不是 JSON",
  "cli.mcp.badRequest": "请求格式不正确",
  "cli.mcp.noMethod": "没有这个方法",

  // ---- cli/backup.ts ----
  "cli.backup.targetNotEmpty": "备份目录不是空的：{target}",
  "cli.backup.notABackup": "这个目录不像备份：缺 {db} 或 {key}",
  "cli.backup.masterKeyBroken": "备份里的 master.key 坏了",
  "cli.backup.dbUnreadable": "备份里的 hub.db 读不出来",
  "cli.backup.hubRunning": "中台还在跑：先停掉它（例如 agent-autoloop service remove，或手动停服务），再恢复",

  // ---- cli/uninstall.ts ----
  "cli.uninstall.removed": "删掉了 {path}",
  "cli.uninstall.needsYes": "运行 agent-autoloop uninstall --yes 卸载程序，规则、密钥和记录会保留。",
  "cli.uninstall.confirm": "卸载程序并保留数据？[y/N] ",
  "cli.uninstall.cancelled": "没有卸载。",
  "cli.uninstall.doneWithData": "卸载好了。规则、密钥和记录还留在 {home}。",
  "cli.uninstall.done": "卸载好了。",

  // ---- cli/self-update.ts ----
  "cli.selfUpdate.noBuild":
    "Release 里没有 {platform}-{arch} 的单文件版（只建 {built}）。这个平台要从源码装，见 INSTALL.md 的「安装」一节。",
  "cli.selfUpdate.rateLimited":
    "发布页暂时不让问了（HTTP {status}，没登录的调用是按出口地址限次的）：过一阵再来，或者手动下载 {page}",
  "cli.selfUpdate.httpError": "没能{what}：发布页返回 HTTP {status}（手动下载：{page}）",
  "cli.selfUpdate.unreachable": "连不上发布页，没能{what}（{why}）：等网络好了再来，或者手动下载 {page}",
  "cli.selfUpdate.whatLatest": "问出最新发布的版本",
  "cli.selfUpdate.whatDownload": "下载 {name}",
  "cli.selfUpdate.noTag": "发布页答的东西里没有 tag_name，看不出最新是哪一版（手动下载：{page}）",
  "cli.selfUpdate.and": "和",
  "cli.selfUpdate.nothing": "没有",
  "cli.selfUpdate.missingAssets":
    "{tag} 这一版没有附 {missing}，这台电脑要的就是它（附了：{attached}）。换一版或者手动下载 {page}",
  "cli.selfUpdate.noSumInFile": ".sha256 里读不出校验和：{text}",
  "cli.selfUpdate.sumNameMismatch": ".sha256 说的是 {said}，不是这台电脑要的 {wanted}",
  "cli.selfUpdate.downloadBroke": "下载 {name} 断了（{why}）：重来一次，或者手动下载 {page}",
  "cli.selfUpdate.emptyBody": "答复里没有内容",
  "cli.selfUpdate.shortRead": "说好 {said} 个字节，只到了 {got} 个",
  "cli.selfUpdate.longRead": "说好 {said} 个字节，来的却是 {got} 个：发布端说的长度不对",
  "cli.selfUpdate.sumMismatch":
    "下载下来的 {name} 和 Release 上的 .sha256 对不上，已经删掉，什么都没换：说好 {published}，拿到 {got}。别自己找来的那一份去对——Release 上的 .sha256 才是凭据（INSTALL.md 讲了为什么自己重建的不一样）。重下一次还是对不上就先别用，到 {page} 看看。",
  "cli.selfUpdate.notExecutable": "没能把 {staged} 设成可执行（{why}）：什么都没换。",
  "cli.selfUpdate.swapFailed": "{why}。手上这一版还在用；{hub}",
  "cli.selfUpdate.hubStoppedAgain": "中台已经被停过一次（{again}）。",
  "cli.selfUpdate.hubStoppedRestarted": "中台已经被停过一次，已经重新启动。",
  "cli.selfUpdate.hubStoppedNeedsUp": "中台已经被停过一次，要再 agent-autoloop up。",

  // ---- protocol ----
  // protocol/rules.ts
  "protocol.rules.badFile": "rules.json 有问题：\n{issues}",
  // 写进去的那一份是说这句话的时候说的那种话；别人自己写在 rules.json 里的 askFirst 原样留着，这里只是没写时的默认。
  // 一条一句，中间的顿号就是分隔：protocol/rules.ts 按它切开。
  "protocol.rules.askFirstDefault": "删数据、停服、花钱、对外发消息、改产品方向、新建或轮换密钥、修改权限",
  "protocol.rules.notEmpty": "不能为空",
  "protocol.rules.idWords": "只能用小写字母、数字和 -",
  "protocol.rules.folderWin": "要是以 ~/、~\\、/ 或盘符（C:\\）开头的目录",
  "protocol.rules.folderPosix": "要是以 ~/ 或 / 开头的目录",
  "protocol.rules.whereObject": "{where}要是一个对象",
  "protocol.rules.missing": "{where}缺少 {name}",
  "protocol.rules.fieldProblem": "{where}的 {name} {problem}",
  "protocol.rules.unknownField": "{where}有不认识的字段 {name}",
  "protocol.rules.duplicateName": "规则名「{name}」重复了",
  "protocol.rules.ruleWhere": "规则「{name}」",
  "protocol.rules.object": "要是一个对象",
  "protocol.rules.unknownAgentIs": "不是已登记的 Agent：{to}",
  "protocol.rules.count": "要是正整数",
  "protocol.rules.boolean": "只能是 true 或 false",
  "protocol.rules.oneOf": "只能是 {allowed}",
  "protocol.rules.channelList": "要是通道编号的列表",
  "protocol.rules.whenWhere": "{where}的 when ",
  "protocol.rules.unknownSourceIs": "不是已登记的来源：{source}",
  "protocol.rules.typeListWild": "要是事件类型的列表，可以用 x.* 或 *",
  "protocol.rules.cronNever": "{where}的定时永远不会到来：{cron}",
  "protocol.rules.badCron": "不是有效的 cron",
  "protocol.rules.needWords": "{where}的 skill 和 prompt 至少写一个",
  "protocol.rules.emitsWhere": "{where}的 emits ",
  "protocol.rules.typeList": "要是事件类型的列表",
  "protocol.rules.unknownChannel": "{where}的 channels 不是已登记的通道：{channel}",
  "protocol.rules.notJson": "不是 JSON：{why}",
  "protocol.rules.badZone": "不是有效的时区",
  "protocol.rules.wordList": "要是文字的列表",
  "protocol.rules.list": "要是一个列表",
  "protocol.rules.reservedSource": "来源 {id} 是保留的，定时用规则的 cron",
  "protocol.rules.sourceId": "来源的编号{words}：{id}",
  "protocol.rules.sourceWhere": "来源 {id} ",
  // 中台自己给的那个来源的名字：写进 rules、进 /v1/state、进卡片的正文，所以它是一笔资料，不是一句话。
  "protocol.rules.scheduleSource": "定时",
  "protocol.rules.channelId": "通道的编号{words}：{id}",
  "protocol.rules.channelWhere": "通道 {id} ",
  "protocol.rules.trueFalse": "要是 true 或 false",
  "protocol.rules.agentId": "Agent 的编号{words}：{id}",
  "protocol.rules.commandList": "要是命令行的列表",
  "protocol.rules.minutes": "要是正整数（分钟）",
  "protocol.rules.groupParallel": "组「{group}」里的规则 parallel 要一致",
  "protocol.rules.taskDuplicate": "定时任务「{name}」和别的规则或定时任务重名",
  "protocol.rules.taskWhere": "定时任务「{name}」",
  "protocol.rules.unknownSource": "不是已登记的来源",
  "protocol.rules.unknownAgent": "不是已登记的 Agent",
  "protocol.rules.taskNeedsCwd": "定时任务「{name}」写了回答后照什么做，还要写 cwd：在哪接着做",
  "protocol.rules.taskNeedsWords": "定时任务「{name}」写了 cwd，skill 和 prompt 至少写一个：回答后照什么做",

  // protocol/validate.ts
  "protocol.event.notObject": "事件要是一个 JSON 对象",
  "protocol.event.unknownField": "不认识的字段：{name}",
  "protocol.event.text": "{name} 要是文字",
  "protocol.event.missing": "缺少 {name}",
  "protocol.event.tooLong": "{name} 最多 {limit} 个字",
  "protocol.event.hops": "hops 要是非负整数",
  "protocol.event.illFormedId": "id 里有不完整的字符",
  "protocol.event.type": "type 只能用小写字母、数字和 . _ -，以字母开头",
  "protocol.event.subject": "subject 只能用字母、数字和 # . _ : / @ -",
  "protocol.event.link": "link 要是网址，非 ASCII 的字要先编码",
  "protocol.result.notObject": "结果要是一个 JSON 对象",
  "protocol.result.unknownField": "结果里有不认识的字段",
  "protocol.result.outcome": "outcome 只能是 done、nothing、failed、cancelled",
  "protocol.result.tooLong": "summary、error、session 最多 500 字",
  "protocol.result.usage": "usage 要是对象，里面要是有限的非负数字",
  "protocol.result.ask": "ask 每一项要有 title、text 和 2 到 5 个 options，recommend 是其中一个的序号，最多 5 项",
  "protocol.result.notice": "notice 每一项要有 title 和 text，最多 10 项",
  "protocol.result.resolve": "resolve 每一项要有卡片编号和 1000 字以内的核实依据，最多 50 项",
  "protocol.result.later": "later 每一项要有 key，以及带时区的 at 和 about，或者 cancel: true，最多 10 项",
  "protocol.result.events": "events 最多 100 项",

  // protocol/client.ts
  "protocol.client.status": "中台返回 {status}",

  // protocol/schema.ts
  "protocol.schema.unknownType": "没有这个协议类型：{name}",

  // protocol/conformance.ts：断言的话给跑 conformance 的人看，正文那几条是它自己发进测试中台的探测资料。
  "protocol.conformance.status": "{path} 状态码",
  "protocol.conformance.shape": "{path} 格式",
  "protocol.conformance.bodyLimits": "事件正文边界",
  "protocol.conformance.parallel": "检查规则的 parallel 至少要是 2",
  "protocol.conformance.summary": "一致性检查",
  "protocol.conformance.askTitle": "选择 {tag}",
  "protocol.conformance.askText": "选择一个",
  "protocol.conformance.optionA": "甲",
  "protocol.conformance.optionB": "乙",
  "protocol.conformance.otherTitle": "另一个 {tag}",
  "protocol.conformance.otherText": "核实后关闭",
  "protocol.conformance.outOfRange": "越界",
  "protocol.conformance.resolved": "已核实",
  "protocol.conformance.deliveryFailed": "旧消息发送失败",
  "protocol.conformance.told": "检查完成",
  "protocol.conformance.notYours": "不能冒充",
  "protocol.conformance.streamIncomplete": "日志流没有完整事实",
  "protocol.conformance.streamMissing": "日志流缺少事实",
  "protocol.conformance.streamLeaks": "日志流泄露密钥记录",
};

/** key 的事实来源：另一份表照着它写，少一个多一个都过不了 typecheck。 */
export type Strings = typeof zhCN;
