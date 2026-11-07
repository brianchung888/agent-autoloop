# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux、Windows 11。Windows 是原生安装，不需要 WSL2，但有四处降级，装之前要知道：桌面通知在 Windows 上一律跳过（卡片仍然进 `agent-autoloop status` 和别的通道）；常驻靠计划任务而不是服务管理器，停了之后最多等 5 分钟才会自己回来，加了域的电脑还不让“登录时启动”，登录后也要等最多 5 分钟；文件权限没有 `0700`，改用 `icacls` 锁到当前用户，锁不上时不拦着启动、由 `agent-autoloop doctor` 报一条降级（详见下面）；Agent 的程序必须是真正的可执行文件（`claude.exe` 这种），npm 装出来的 `.cmd` 包装脚本起不了，`agent-autoloop init` 会说找不到。另外还有一处 Windows 才有的开销，不是降级但会看得见：有一轮在跑的时候，中台每 30 秒会有一次约 2 秒不应答——这一拍它在走整张进程表，为的是这一轮停下来时找得着孙子进程（POSIX 上是进程组，不需要走），所以这时候 `status` 一类的命令偶尔会慢这么一下。仍然想用 WSL2 的话按 Linux 装，注意系统服务要发行版开着 systemd（`/etc/wsl.conf` 里 `systemd=true`，没开就加 `--no-service`，自己运行 `agent-autoloop up`），没人登录时不启动要 `loginctl enable-linger`，桌面通知也到不了 Windows 桌面，WSL2 本身还要占 1GB 左右内存。

需要 Node.js 24 或更新、Git，以及一个已经登录的命令行 Agent。下载安装脚本在 macOS / Linux 用 curl，Windows 用 PowerShell 自带的 `irm`，两边都不需要额外装东西。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/brianchung888/agent-autoloop/main/install.sh | sh
```

Windows 用 PowerShell，不需要管理员：

```powershell
irm https://raw.githubusercontent.com/brianchung888/agent-autoloop/main/install.ps1 | iex
```

它把 `agent-autoloop.cmd` 放进 `%USERPROFILE%\.local\bin` 并加进你自己的 PATH（不动系统 PATH），所以装完要重开一个终端，`agent-autoloop` 才认得。本地仓库安装时和 POSIX 一样设 `AGENT_AUTOLOOP_REPO`，再运行该目录下的 `install.ps1`。

GitHub Issue 轮询和 PR 交付等功能另需已登录的 `gh`，按对应场景说明配置；运行 Agent 也仍需该 Agent 自己的登录或授权。

安装和 `agent-autoloop update` 都装最新的 Release，那是通过了全部检查的版本，`main` 上还没发布的改动要等下一个 Release。

用户指定本地仓库时，用该目录的安装脚本，并把 `AGENT_AUTOLOOP_REPO` 设成它的绝对路径。不要下载 GitHub 的旧脚本，也不要用未提交的文件冒充已安装版本；这时安装器克隆的是本地仓库的 HEAD，`update` 也跟着那个仓库走，不看 Release。已经装过时这个变量不起作用，还跟着原来的来源走；要换来源，先运行 `agent-autoloop uninstall` 再装。

下面以 `/path/to/agent-autoloop` 为例，使用已经登录的 Codex：

```bash
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex
```

`--agent claude` 选择 Claude Code；只有其他 CLI 时加 `--command 'hermes chat -Q -q {prompt}'`。不指定时会检测本机安装的 Agent，第一种作为试跑对象。

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；macOS / Linux 没有图形会话时安静跳过，Windows 是一律跳过（这边还没有可用的通知程序），两种情况下问题都仍能用 `agent-autoloop status` 查看，`agent-autoloop doctor` 也会指出来。命令放在 PATH 中的 `~/.local/bin`；macOS / Linux 上这个目录不在 PATH 里时改选 PATH 里第一个可写目录，Windows 上则是把 `%USERPROFILE%\.local\bin` 加进用户 PATH（走 `[Environment]::SetEnvironmentVariable`，不用 `setx`——`setx` 会把超过 1024 个字的 PATH 截短；要重开终端才生效，把 `AGENT_AUTOLOOP_NO_PATH` 设成非空就不改 PATH）。两边都不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。Windows 没有 `0700`，改用 `icacls` 把数据目录的权限锁到当前用户（去掉继承，只留你自己，子目录和文件跟着继承），`master.key` 另外单独锁一次；锁不上（网络盘、FAT32、域策略）不会拦着启动，但 `agent-autoloop doctor` 会多出一条“文件权限降级”，这时同机的其他用户可能读得到数据。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。源码安装和下面的单一二进位之间互换不算格式变化，不会触发重建。

## 单一二进位（这台电脑上没有 Node）

还有一条不需要装 Node 的路：每个 Release 附一个单文件可执行程序，三个平台各一个，旁边各有一份 `.sha256`。源码安装仍然是默认方式，这条是额外的管道——它换掉的只有「先装 Node 24」这一件事，别的都一样。

| | 源码安装 | 单一二进位 |
|---|---|---|
| 前置 | Node.js 24+、Git | 没有 |
| 下载体积 | 约 1.5 MB | 约 96 MB（里面就是一整个 Node） |
| 怎么升级 | `agent-autoloop update` | `agent-autoloop update`（自己换掉自己，见下） |
| 第三方 `.ts` 插件 | 可以 | 不行，要带 `runtime: "process"`（见[插件说明](docs/plugins.md#源码插件在打包版下的限制)） |
| 数据、规则、密钥 | 都在 `~/.agent-autoloop` | 一样，而且两种装法可以互换 |

拿到那个文件之后：先对校验和，再跑 `init`。没有安装脚本可跑，因为没有东西要安装——这个文件就是整个程序，放在哪里都行（PATH 里的某个目录最省事）。

```powershell
# Windows
certutil -hashfile .\agent-autoloop-windows-x64.exe SHA256
.\agent-autoloop-windows-x64.exe init
```

```bash
# macOS / Linux
shasum -a 256 ./agent-autoloop-macos-arm64
chmod +x ./agent-autoloop-macos-arm64
./agent-autoloop-macos-arm64 init
```

**Windows 上会被 SmartScreen 拦。** 这个文件没有签章：注入那一步会破坏 node.exe 原本的 Authenticode 签章，所以产物是「未签章」而不是「签章坏了」。第一次运行会弹「Windows 已保护你的电脑」，要点「更多信息 → 仍要运行」；下载时浏览器也可能先说一句。对完 `.sha256` 再放行。它能证明什么得说清楚：那串校验和和文件是同一个 Release 发出来的，所以它只能证明你手上这份字节和发布页上那份一样——下载断了、代理改写了、镜像换了文件，这些它都抓得到；发布端自己被攻破、两份一起换掉，它一句话也说不了。这整套发布没有任何签署，没有签章可以验；要比这再强一层，只能靠别的办法：自己从源码建，或者在组织内部用组织的证书重签。给组织内部分发时，自己用组织的证书重签一次最省事。要对的是 Release 上那一份 `.sha256`：同一个提交自己再建一次，SHA256 不会和它一样（blob 里带着 V8 的 code cache，由建置那台机器的运行时产生），所以这不是可重现建置，别拿自己重建的那一份去比。

**升级也是 `agent-autoloop update`，它自己换掉自己。** 在二进位里这条命令会去问最新的 Release 是哪一版，下载这台电脑这个平台的那一个和它旁边的 `.sha256`，对完校验和才动手：往 `AGENT_AUTOLOOP_HOME/stop` 写一个文件等中台收尾，把手上这个 exe 改名成 `.old`、把下载下来的 `.new` 改成正名，再重启常驻（计划任务指的是路径不是文件，所以不用重装）。`.old` 下次启动时自己清掉——Windows 不让删正在跑的 exe，但允许改名，这整套就是为这一点设计的。

出错的时候一律不动手上这一版：下载断了、`.sha256` 对不上、改名没成功，都会把下载删掉、把原文件放回去，并说清楚发生了什么。只有一件事它收不回来——中台已经被停过一次，所以消息里会写它有没有重新启动。没网、被限流（没登录的调用按出口地址限次）或者这个平台 Release 里没建，都会让它直接说出来并给出手动下载的地址；手动那条路还在：到 Release 页面取文件、对校验和（Windows：`certutil -hashfile <文件> SHA256`；macOS / Linux：`shasum -a 256 <文件>`）、写 `stop` 文件、换掉文件、再启动一次。别在中台还在跑的时候直接覆盖这个 exe——Windows 会直接拒绝。

规则、密钥和记录都在数据目录里，不在这个文件里，所以换文件不丢任何东西，两种装法之间来回换也不会让投影重建（两种模式算出来的投影格式逐字相同，`tests/sea-format.test.ts` 钉着这一条）。

二进位里 `uninstall` 删的是它自己放进去的东西（常驻、Skill、PATH 上的链接），不删你下载的那个文件——那是你放的。

**还有两处和源码模式不一样。** 内置插件是编进去的，`agent-autoloop add` 装的第三方插件如果是 `.ts`，在二进位里会收到一句「这个打包版跑不了外部的 .ts 文件，在 plugin.json 里写 {"runtime":"process",…}」，照着改就行。另外开发用的随机模拟（`sim/`）在二进位里到不了；`conformance` 到得了，和源码模式一样用。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。Windows 上停它别直接杀进程：往 `AGENT_AUTOLOOP_HOME` 下写一个空的 `stop` 文件，中台看到就自己收尾（`agent-autoloop uninstall` 也是这么停的）。Windows 没有 SIGTERM 可送，硬杀会留下 `up.pid` 和没关的连接（留下的 `up.pid` 挡不住下一次 `up`：里面记着那个进程的创建时刻，认得出是遗留的）。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 环境变量

这台电脑上能改程序行为的全部环境变量，一张表（之前有几个只写在注释里，`phase3-verification-round2.md` #6）。都不是必填的：不设就是表里那个默认行为。

| 变量 | 给谁看 | 作用 |
|---|---|---|
| `AGENT_AUTOLOOP_HOME` | 全部 | 数据目录，默认 `~/.agent-autoloop`。换掉它就是另一个独立的安装（常驻的名字跟着变） |
| `AGENT_AUTOLOOP_RULES` | 中台 | 规则文件的位置，默认 `HOME/rules.json`。临时跑一套规则不用动数据目录时用它 |
| `AGENT_AUTOLOOP_PUBLIC_URL` | 中台 | 卡片链接写出去时用的地址。`up` 会按 `config.json` 的 `hub.publicUrl`（没有就按 `hub.listen`）自己设好，手动设只在不走 `up` 的时候有意义 |
| `AGENT_AUTOLOOP_TREE_SAMPLE` | 接单程序 | Windows 上「一轮跑着的时候隔多久走一次它的进程树」，毫秒，默认 30000。走一次整张进程表要 1.3–1.9 秒，所以它不该调小；`0` 是每一拍都走，只有测试这么用 |
| `AGENT_AUTOLOOP_COMMIT`、`AGENT_AUTOLOOP_RELEASE` | 版本 | `--version` 说哪一版。二进位把自己的版本写成 `\|\|=`，好让部署改得动。报问题之前先 `unset`，否则说出来的不是手上这个文件 |
| `AGENT_AUTOLOOP_RELEASES` | `update` | 二进位自我更新去问哪个 Release API，默认公开仓库那个。改它只为了拿自建的 Release 试，或者给测试用一个本机的服务器 |
| `AGENT_AUTOLOOP_REPO` | 安装器 | `install.sh` / `install.ps1` 从哪个仓库装，默认公开仓库。从本地副本装时用它（见上面「临时 HOME」一节） |
| `AGENT_AUTOLOOP_NO_PATH` | 安装器 | 设成非空就不改 Windows 的用户 PATH（见上面「安装」一节） |
| `AGENT_AUTOLOOP_LANG` | 全部 | 这个程序说哪种中文：`zh-TW`（默认）或 `zh-CN`，`zh_TW.UTF-8`、`zh-Hant`、`zh-HK` 这些写法也认。没设时看 `config.json` 的 `lang`（`agent-autoloop lang` 和 `init --lang` 写它），再没有才看环境的 `LC_ALL` / `LC_MESSAGES` / `LANG`。设了它就盖得过 `config.json`，所以脚本和测试用它钉住要哪一种 |
| `AGENT_AUTOLOOP_CONFORMANCE` | `conformance` | 一致性检查用的凭据文件，等于不写 `--config` 时的默认值 |
| `AGENT_AUTOLOOP_SECRET_<来源名>` | 中台 | 这个来源验 Webhook 签名用的密钥，来源名里的 `-` 写成 `_` 并大写。平时放 `HOME/secrets.env`，`up` 启动时读进来 |

还有几个是程序**交给**它启动的东西的，不是用来配置这台电脑的：`AGENT_AUTOLOOP_RUN`、`AGENT_AUTOLOOP_CONTEXT`、`AGENT_AUTOLOOP_COMMAND`（接单程序给 Agent 的，见[插件说明](docs/plugins.md)），`AGENT_AUTOLOOP_URL`、`AGENT_AUTOLOOP_KEY`、`AGENT_AUTOLOOP_ONCE`、`AGENT_AUTOLOOP_CLAIM`、`AGENT_AUTOLOOP_RECEIPT`（自己写接单程序或通道时用的，见[协议](docs/protocol.md)），以及 `AGENT_AUTOLOOP_PID`（Windows 上问进程信息的那段 PowerShell 的入参，内部用）。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

环境里 export 了 `AGENT_AUTOLOOP_COMMIT` 或 `AGENT_AUTOLOOP_RELEASE` 的话，`--version` 说的是那两个值：二进位把自己的版本写成 `||=`，好让部署改得动，和源码模式一个样。报问题之前先 `unset` 这两个，否则说出来的版本不是手上这个文件的。

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。Windows 上装了计划任务的话，`doctor` 会在“系统服务在跑”下面多一条说明，讲清“崩了最多等 5 分钟”这个语义差别。`doctor` 的三个符号是：`●` 好了，`○` 红项（这一条让退出码不为 0），`◐` 降级说明（能用，只是不如字面承诺的那么多，不计入红项）。

## 写第一条规则

安装验证完成后，按用户希望自动处理的事从 [README 的场景模板](README.md#拿来即用的场景模板)选一个，再照[配置手册](skills/agent-autoloop/SKILL.md)写规则；用户还没指定用途时再问。用 `agent-autoloop check` 检查；改动几秒内生效。

国内业务可从反馈处理、网站巡检、飞书周报与业务摘要三套模板开始。它们默认飞书本人私聊；替换占位符后，配置和业务资料留在私有目录，不提交到仓库。模板不替用户新建凭据或扩大飞书权限。

桌面通知只在这台电脑上显示。需要别的通道时，先确认接收位置，再按配置手册接入。不要直接测试发信或发群消息。`access` 的含义见[插件说明](docs/plugins.md#access-实际能做什么)，不要替用户扩大权限。

## 卸载

卸载程序，默认保留规则、密钥和记录：

```bash
agent-autoloop uninstall
```

终端里确认后才执行；非交互运行时加 `--yes` 跳过确认，数据同样保留。它只停自己的服务和进程、删除指向自身的命令及 Skill 链接，以及安装目录里的 `app`。其他同名文件不动；数据目录不删除。Windows 上删的是 `agent-autoloop.cmd` 这个包装脚本（按里面写的程序路径确认是自己的才删），Skill 用的是 junction；junction 也建不了时安装器会改成复制，并在 `HOME/skill-link.json` 记下来，卸载按这条记录删掉那份复制（SKILL.md 内容不一致就不动）。PATH 里那一行要自己去“编辑账户的环境变量”删。

临时安装验证完，用 `agent-autoloop uninstall --yes` 停掉本次进程，再清掉自己创建的临时目录。不要卸载用户已经在用的中台。

## 文档

- [配置手册](skills/agent-autoloop/SKILL.md)：接事件插件、通道、多台电脑和交付流水线。
- [协议](docs/protocol.md)：HTTP、回执、事实日志和故障恢复。
- [插件](docs/plugins.md)：三个可运行的最小例子。
- [安全边界](SECURITY.md)：密钥、执行权限和交付审查。

开发检查用 `npm run test:quick`（改了 `kernel/`、`protocol/`、`sim/` 时用 `npm test`）、`npm run typecheck`、`npm run format:check`，完整故障检查和性能实测用 `npm run test:nightly`。备份和恢复见[配置手册](skills/agent-autoloop/SKILL.md#日志与恢复)。`master.key` 坏了中台会拒绝启动：从备份恢复；没有备份就删掉它，重启会生成新的，已发出的卡片链接和正在跑的轮次会失效。
