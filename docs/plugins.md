# 写插件

先看 [README 的内置插件目录](../README.md#插件体系四个方向都能自由替换)选择已有实现；需要扩展时，从下面三个可运行的最小模板开始，替换业务部分：

| 模板                                                       | 已经演示了什么                                             | 你要替换什么                   |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| [Agent 模板](../examples/plugins/hello-agent/agent.ts)     | 用 `printf` 模拟执行，读取输出、会话编号和「收下了提示词」 | 新 Agent 的启动命令和输出解析  |
| [通道模板](../examples/plugins/hello-channel/channel.ts)   | 领卡片、写到文件、报告送达；通过命令行回答                 | 目标平台的发送、更新和回答回调 |
| [事件插件模板](../examples/plugins/hello-source/source.ts) | 验证 HMAC-SHA256 签名，把模拟订单转换成事件                | 业务系统的验签方式和字段映射   |

事件插件、接单程序、通道和命令行共用同一套 HTTP + JSON 接口。只用 Shell 接协议，可以看 [接单脚本](../examples/worker.sh) 和 [通道脚本](../examples/channel.sh)：设置中台地址与密钥后运行，需要 `curl`、`jq`。它们适合演示短任务；长任务使用内置接单程序的心跳、停止和恢复能力。

一个插件就是一个目录，入口为 `agent.ts`、`channel.ts` 或 `source.ts`。只用 `node:` 模块和自己目录里的文件，类型在插件里声明；不要相对引用引擎源码：装在 `~/.agent-autoloop/plugins/` 的插件，相对路径到不了引擎。内置插件和引擎放在一起发布，才能直接引 `worker/agents.ts` 里的 `findProgram`、`tail` 这些小工具，引擎不反过来引插件。

用 `agent-autoloop add <git 地址>` 安装到 `~/.agent-autoloop/plugins/<仓库名>`，也接受本地 Git 仓库。插件名就是那个目录名：仓库名转成小写，只能用小写字母、数字和 `-`，别的名字会被拒绝，并说出它算出来的名字；规则的 `use` 和来源的 `adapter` 都写这个名字。它只克隆，不装依赖、不跑安装脚本、不自动更新。加载时会执行插件，安装目录的同名插件优先。插件可以在自己目录里放一个 `plugin.json` 说明自己是哪种（见下一节）；没有这个文件就是源码插件，和以前一样。`add` 克隆完会把它声明的 `runtime` 印出来。

## 先跑起来

在引擎目录运行这条命令：它把三个例子分别装进临时中台，实际走完验签、派活、运行、通知和报告，退出后清理。

```bash
node --disable-warning=ExperimentalWarning --test --test-name-pattern='agent-autoloop add' tests/example-plugins.test.ts
```

## plugin.json：源码插件还是独立程序

插件目录里可以有一个 `plugin.json`，可选，`runtime` 只有两个值：

| `runtime`        | 意思                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`（默认） | 入口是 `agent.ts` / `channel.ts` / `source.ts`，中台把它 `import` 进自己这个进程。**加载就是执行**：插件顶层干了什么，就在这一刻以中台的身份干了什么 |
| `process`        | 入口是 `entry` 指的一个可执行文件，中台每次调用起它一次，走标准输入输出的逐行 JSON                                                                   |

没有这个文件、读不出来、不是对象、或者没写 `runtime`，一律当 `source`：第三方仓库本来就可能有一个讲它自己事情的 `plugin.json`，不能让今天能用的插件用不了。写明了 `runtime` 又写错（不是这两个值、`process` 没有 `entry`、`entry` 是绝对路径或走出插件目录）则直接报错。

### runtime: "process"

```json
{ "runtime": "process", "entry": "bin/my-plugin", "args": ["--quiet"] }
```

`entry` 是插件目录内的相对路径，走不出去；`args` 可选，每次调用都在最前面，是参数而不是 shell 词（不经 shell，也不做字符串拼接）。程序跑起来时的当前目录就是插件自己的目录，所以 `args` 里写相对路径就能指到自己的文件（插件不可能知道自己被装在哪里）。

**Windows 上 `entry` 必须是插件目录里一个真正的可执行文件**（`.exe`），和 Agent 程序一样。这里不经过 shell，CreateProcess 认什么就是什么：`.cmd` / `.bat` 包装起不了（`EINVAL`），`#!/bin/sh` 脚本也起不了（`EFTYPE`，Windows 不看 shebang）；而 `entry` 走不出插件目录，所以也不能指向目录外的 `node.exe` 或别的解释器。要在 Windows 上发一个用解释器跑的插件，就把那个解释器放进插件目录里，脚本写在 `args` 里：

```json
{ "runtime": "process", "entry": "runtime.exe", "args": ["handler.mjs"] }
```

**`entry` 也不能借 symlink 或 junction 出界。** 走不出插件目录这件事比的是**真实路径**（`realpathSync`），不是写法：插件目录里放一个指向外面的 symlink / junction（Windows 上的目录连接），写 `entry: "linked/tool.exe"` 一样会被拒掉，说的还是「走出了插件目录」那一句。连接尽头什么都没有的，也当出界处理——一个现在指不到地方的连接，待会儿可以指到任何地方。所以插件要用的程序得真的在插件目录里（一份拷贝，或者 clone 下来就带着）。

跨平台的插件按平台写两份 `plugin.json`，或者干脆带一个各平台的原生可执行文件——那是这个协议最省事的用法：读一行，打一行，结束。

调用方式：每次起一个进程，标准输入给一行 JSON 请求，标准输出的**最后一行**是 JSON 答复，然后退出。答复是 `{"ok":true,"value":…}` 或 `{"ok":false,"error":"一句人能照着做的话"}`；中间想打印别的东西可以，只要答复在最后一行。

| 请求                                                      | 对应的函数                   | `value`                                                           |
| --------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `{"call":"describe"}`                                     | —                            | `{"calls":["command","read","link","check"]}`，只用来问它有哪几个 |
| `{"call":"command","turn":{…}}`                           | `command(turn)`              | 命令参数数组                                                      |
| `{"call":"read","stdout":"…","code":0,"stderr":"…"}`      | `read(stdout, code, stderr)` | `Reading` 对象，运行中 `code` 是 `null`                           |
| `{"call":"link","session":"…"}`                           | `link(session)`              | 链接字符串                                                        |
| `{"call":"check"}`                                        | `check()`                    | `null` 或一句话                                                   |
| `{"call":"translate","headers":{},"body":"","secret":""}` | 事件插件的那个函数           | 事件数组                                                          |

这些就是全部：协议只是把已有的函数形状搛过进程边界，没有新能力。`describe` 没列出 `link` 或 `check` 的，就没有这两个：中台读的是「有没有」，凭空给一个 `link` 会报一个打不开的会话链接。一次调用就是程序跑一次：不留状态，也不用守着。智能体那四个调用在调用处是同步的（`worker/agents.ts` 的 `Adapter` 就是这个形状），所以它们会阻塞；事件插件的调用都不阻塞——`translate` 和它前面那一次 `describe` 都是，收 webhook 那头本来就是 `async`，取插件那一步（`host/plugins.ts` 的 `loadPlugin`）也是，等另一个程序答话的时候中台照旧转。

**`describe` 每个进程只问一次。** 中台第一次取这个插件的时候问它有哪几个 call，往后就记着了——源码插件被 `import` 一次就是这个样子，`process` 插件也要是同一个样子，否则每收一个 webhook、worker 每一拍，都要为了问一句 `describe` 多起一个进程。代价是：**插件改了要重启中台才算数**（`agent-autoloop up` 重起一次）。改了 `plugin.json`、换了 `entry` 指的程序、给插件加了一个 `link` 或 `check`，在跑着的那个中台里都还是旧的。没做成的插件不进这个记忆——报了错的下一次会再问一遍，所以修好一个起不来的插件不必重启。

**通道现在不支持 `process`。** 通道是和中台一样长命的循环，不是一次一答的翻译。用别的语言写通道，直接当独立程序连中台的 HTTP 协议（见下面的通道插件一节和 `examples/channel.sh`），不必经过插件机制。

### 源码插件在打包版下的限制

以单一二进位分发的版本里（[怎么装](../INSTALL.md#单一二进位这台电脑上没有-node)），内置插件是编进去的（`scripts/build-registry.ts` 在建置期产生一张静态清单，不进版本库），但它没有办法跑外部的 `.ts` 文件。所以装在 `~/.agent-autoloop/plugins/` 的第三方插件：`runtime: "source"` 在源码模式下照旧能用，在打包版下会报一句话、叫你改成 `runtime: "process"`；`process` 两边都能用。开发插件时用源码模式最方便，要分发给用打包版的人，就带一份 `process` 入口。

## Agent 插件

从 [hello-agent/agent.ts](../examples/plugins/hello-agent/agent.ts) 开始。它用 `printf` 代替模型，克隆到别处也能运行。收下提示词和结束时各打一行，`read` 从第一行就知道这一轮接上了原会话，第二行是它的最后一条消息。

| 导出对象的方法               | 作用                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `command(turn)`              | 返回命令参数数组；参数不作为 shell 代码执行                                                              |
| `read(stdout, code, stderr)` | 返回 `text`、`session`、`usage`、`sessionUsage`、`error`、`finished`、`started`；运行中 `code` 为 `null` |
| `link(session)`              | 可选，打开这个会话的链接。回执写错时，`read` 返回了 `session` 的插件都只重写回执，和有没有链接无关       |
| `check()`                    | 可选，能用返回 `null`，否则返回下一步怎么做                                                              |

`turn` 包含 `prompt`、`session`、`resume`、`cwd`、`access`、`model`、`effort`、`command`、`contextFile`、`folder`。`contextFile` 是资料文件，受限 CLI 需要允许读取 `folder`。`read` 要能处理未写完的输出；CLI 真正完成后才返回 `text`。`read` 抛错或什么也不返回时，还在跑的接着跑，结束后这一轮算没跑成，留在原会话重派。

支持 `resume` 的插件，从 Agent 收下提示词起都要返回 `started: true`，包括运行中和出错之后。否则干到一半断了，也会被当成会话接不上，开新会话把业务重做一遍。返回了 `session` 就要按 `turn.resume` 接回原会话：没跑成的重派和写错回执的重写都靠它；接不回去的 CLI 不要返回 `session`。

`usage` 是这次启动用掉的量。有的 CLI 只给整个会话累计到现在的数（Codex 的 Token、Claude Code 的费用），这几项放进 `sessionUsage`，同时要返回 `session`。接单程序启动前记下这个会话上次的累计值，结束后相减，和 `usage` 合起来上报；这些记录放在 `~/.agent-autoloop/worker/usage/`，接单程序中途重启也不会多算。

没有记录的续接（换了电脑、升级前就有的会话）或累计值变小时，这几项这次不报，不猜；下一次续接恢复正常。其他程序在同一个会话里用掉的量分不出来，比如本人打开链接接着聊，会算进下一次续接。CLI 改成只报单次时，插件要把这几项改回 `usage`，不要靠数字大小去猜。

在规则里选择这个插件：

```json
{ "name": "Hello", "worker": "my-computer", "use": "hello-agent", "access": "read" }
```

只需要打印最后一条消息时，用内置 `command` 加参数数组即可，不必写插件。参数里可以用 `{prompt}`、`{model}`、`{effort}`、`{cwd}`、`{context}`，每个参数只替换一轮，替换进去的提示词原样传给程序：提示词里写着 `{cwd}` 或 `$&`，到程序那边也还是这几个字，不会被再替换一次。运行时还有环境变量 `AGENT_AUTOLOOP_CONTEXT`（资料文件）和 `AGENT_AUTOLOOP_RUN`（第几轮）。

DeepSeek Harness 有内置 `dsh` 插件，规则里写 `use: "dsh"`，要 0.2.2 或更新，`agent-autoloop doctor` 会查。现在 npm 的 `latest` 还是旧版，要这样装：`npm install -g @deepseek-ai/dsh@next --allow-scripts=koffi,node-pty,@deepseek-ai/dsh-subprocess-local`。新版 npm 默认不跑依赖的安装脚本，不放行这三个包，装完看着正常，一跑才出错。从旧版升上来的，0.2.2 可能读不到 `~/.dsh/.credentials.yaml` 里的 `refs`，报 `MISSING_CREDENTIAL`：把密钥放进环境变量，Linux 的系统服务放 `~/.config/environment.d/*.conf`。只上报 Token，不上报费用。有用户在 WSL2 上用 0.2.2-rc.1 和第三方 OpenAI 兼容服务实测跑通了问答、用量和 `resume`。它以 `dsh headless --json` 跑一轮，从 `session` 事件拿会话编号，用 `--session-id` 续接，把 `step_end` 的用量汇总为 Token，`final` 事件才算跑完；`access` 每次都映射成 `--permission-mode`，要人批准的调用用 `--approval-policy never` 直接拒绝。规则里的 `model`、`effort` 不起作用，用 DSH 自己的配置。没有可打开的桌面会话链接。DSH 默认把会话日志上传给 DeepSeek，见[它的说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)。

### 浏览器接入

浏览器工具装在运行 Agent 的电脑上，由该 CLI 的工具配置或项目 Skill 提供。Codex 插件启动的是后台 [`codex exec`](https://developers.openai.com/codex/noninteractive/)；可以使用它已配置的 [MCP 工具](https://developers.openai.com/codex/mcp/)，不能只凭桌面应用能打开网页就认定后台也能访问同一浏览器。

Claude 委托 Codex 的完整规则、Skill 和参数调用脚本见[浏览器交接模板](../examples/recipes/browser-handoff/README.md)。入口命令、目标与允许操作由本人配置；网页助手返回证据和会话编号，主任务负责业务与回执。

已有专用浏览器入口时，在规则的 `prompt` 或 `skill` 写明实际命令、会话接续方式和允许的操作。只交网页步骤，返回看到的内容、操作结果和阻塞原因；主任务负责业务和中台回执。浏览器入口不是必装组件，中台不捆绑某台电脑的脚本，也不自动修改 CLI 的工具配置。

需要网页验收的任务，要用同一后台启动方式实际打开目标页面，核对内容并接续一次会话。缺少可用入口或需要本人恢复连接、登录、验证时，保留未验收项，用现有 `ask` 等待恢复；不要写“没跑成”触发重派，也不能把 HTTP 查询当作已经完成网页验收。

## 通道插件

从 [hello-channel/channel.ts](../examples/plugins/hello-channel/channel.ts) 开始。它把卡片写进文件，用命令行回答。

默认导出异步函数，参数是 `{ hub, options, log, signal }`；`options` 来自 `config.json`，不含中台密钥。

| 调用                                  | 作用                                      |
| ------------------------------------- | ----------------------------------------- |
| `hub.nextCard(50)`                    | 长轮询领卡片，没卡片返回 `{ card: null }` |
| `hub.delivered(id, version, ref)`     | 报告送达，保存外部消息编号                |
| `hub.failed(id, version, error)`      | 报告发送失败                              |
| `hub.answer(id, { choice, by, ref })` | 转交回答；核对回答人和原消息              |

`ref` 为空就发新消息，有值就更新原消息；不能更新时只报告。没报告的卡片一分钟后重派。`signal` 中止时退出；函数在此之前返回或抛错，都记日志并在 30 秒后重启，所以它要一直运行。插件和中台在同一个进程里：没接住的错误只记日志，不让中台退出。

在 `rules.json` 登记通道、用 `agent-autoloop key new channel cards` 取密钥，再把下面这项放进 `config.json` 的 `channels`，重启中台：

```json
{ "cards": { "use": "hello-channel", "key": "通道密钥", "file": "/tmp/cards.txt" } }
```

能收回调的通道要在规则里设置 `answerers`，没设时通道里谁都能回答，`doctor` 会提醒；只能发文字的通道设置 `links: true`，发送 `card.link`。拿到链接的人能回答这张卡片。

通道和中台共用一个 Node 进程，外部调用应异步等待。内置飞书通道的用户查询、发送和更新均异步调用 CLI，发送期间中台仍能接收事件和心跳。

## 事件插件

从 [hello-source/source.ts](../examples/plugins/hello-source/source.ts) 开始。它检查 `x-shop-signature` 中的 HMAC-SHA256，再把订单变成事件。

默认导出同步函数，参数为 `{ headers, body, secret }`。先验签，再解析原文；返回事件数组，无事返回 `[]`，拒绝请求就抛异常。事件插件只翻译，不发请求。

在 `rules.json` 登记来源：

```json
{ "shop": { "name": "商店", "adapter": "hello-source" } }
```

请求地址是 `/v1/in/shop`；秘密放在 `secrets.env` 的 `AGENT_AUTOLOOP_SECRET_SHOP`（来源名转大写，`-` 换成 `_`；改完重启中台），不写进规则。事件必须有稳定的 `id` 和合法的 `type`，可带 `subject`、`summary`、`detail`、`link`，上限见[协议](protocol.md#来源把世界变成事件)。

来源能直接发标准 JSON 时不必写插件，用来源密钥调用 `POST /v1/events` 即可。

## access 实际能做什么

`access` 由插件翻译，不是中台提供的系统沙箱。以下是未额外放宽本机权限时的行为。

| 插件             | `read`                                                           | `edit`                                                                       | `full`                                                 |
| ---------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| Codex            | `read-only`：能跑 shell，不能写文件，命令默认不能联网            | `workspace-write`：能跑 shell、写工作目录和临时目录，命令默认不能联网        | `danger-full-access`：能写文件、跑 shell、联网，无审批 |
| Claude Code      | `plan`：能读文件和运行只读命令；其他命令取决于自动审批及本机规则 | `acceptEdits`：再允许目录内文件编辑和常见文件操作；任意 shell 或联网仍需放行 | `bypassPermissions`：跳过工具审批，没有额外系统隔离    |
| DeepSeek Harness | `read-only`：不能写文件，读文件和联网不受限                      | `workspace-write`：命令和文件改动限于工作目录和临时目录，读文件和联网不受限  | `danger-full-access`：不受限制                         |
| ACP              | Agent 来问时，同意读和搜索                                       | 再同意工作目录内的编辑                                                       | 同意它来问的所有操作                                   |

Codex 的三个档位已用插件命令实跑；DeepSeek Harness 和 Claude Code 分别依据 [DSH 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/reference/README.md)和[官方权限说明](https://code.claude.com/docs/en/permission-modes)整理，没有调用模型实跑。Codex 的命令网络限制与托管搜索、MCP 不是同一个边界，详见[官方沙箱说明](https://learn.chatgpt.com/docs/agent-approvals-security)。用户的 CLI 配置可能改变上述能力；`read` 也不代表读不到本机密钥。

ACP 的 `access` 只管 Agent 主动来问的操作。规范允许 Agent 不询问就执行，这种操作 `access` 拦不住，要用 Agent 自己的模式限制，比如 `command` 里写 `env INITIAL_AGENT_MODE=read-only …`。ACP 的 `model`、`effort` 不生效，也要在 Agent 自己那边设置。

场景模板据此选权限：早报用 `edit` 写本地文件，issue 用 `edit` 改代码并让固定脚本联网取正文，告警用 `read` 看代码和事件附带的调用栈。反馈处理和飞书摘要用 `edit`，网站排查用 `read`；固定巡检与飞书读取脚本负责联网，摘要 Agent 只读完整快照。`command` 和固定脚本以本机账号运行，不受 `access` 约束。

## 一致性测试

在引擎目录运行协议的现有 HTTP 检查，全部使用临时数据和随机端口：

```bash
node --disable-warning=ExperimentalWarning --test tests/conformance.test.ts
```

检查其他中台实现时，用 `agent-autoloop conformance <测试地址> --config <测试凭据文件>`，文件格式见[协议](protocol.md#一致性和复现)。它会写事件和卡片，只对专用测试中台运行。

插件本身的完整接入测试见 [tests/example-plugins.test.ts](../tests/example-plugins.test.ts)。用其他语言写独立进程也可以，参考 [curl/jq 通道](../examples/channel.sh)和[接单程序](../examples/worker.sh)。
