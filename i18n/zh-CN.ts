// 简体中文：这个程序原本就是用这些话写的，所以这一份是 key 的事实来源。
//
// 每一条都是从原来的代码里逐字搬过来的，标点也一样——既有的测试断言的就是这些字，所以这里改一个字就是改一次行为。
// `{名字}` 是 host/i18n.ts 的 `t` 填进去的值；另一份表（i18n/zh-TW.ts）的类型是从这里读的，少一个 key 或多一个
// key 都过不了 typecheck。
//
// 分区按它们被说出来的地方排：host、worker、plugins、cli。一句话只属于一个地方。
export const zhCN = {
  // ---- host/notify.ts ----
  "notify.trouble.win": "桌面通知不可用：Windows 上没有可用的通知程序，卡片会跳过通知",
  "notify.trouble.linux": "桌面通知不可用：这台电脑没有图形会话（DISPLAY 和 WAYLAND_DISPLAY 都没设），卡片会跳过通知",
  "notify.trouble.unknown": "桌面通知不可用：问不到这台电脑的图形会话，卡片会跳过通知",

  // ---- host/permissions.ts ----
  "permissions.noUser": "不知道当前用户是谁（USERNAME 没有设）",
  "permissions.icaclsBroken": "icacls 运行不了：{why}",
  "permissions.icaclsRefused": "icacls 没能锁定 {target}",
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
};

/** key 的事实来源：另一份表照着它写，少一个多一个都过不了 typecheck。 */
export type Strings = typeof zhCN;
