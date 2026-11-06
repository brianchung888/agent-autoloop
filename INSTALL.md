# 安装说明（写给 Agent）

用户请你装好 Agent 自动化中台。先安装，再走一遍提问和继续处理；能自己做的直接做。

## 安装

支持 macOS、Linux、Windows 11。Windows 是原生安装，不需要 WSL2，但有三处降级，装之前要知道：桌面通知在 Windows 上一律跳过（卡片仍然进 `agent-autoloop status` 和别的通道）；常驻靠计划任务而不是服务管理器，停了之后最多等 5 分钟才会自己回来，加了域的电脑还不让“登录时启动”，登录后也要等最多 5 分钟；Agent 的程序必须是真正的可执行文件（`claude.exe` 这种），npm 装出来的 `.cmd` 包装脚本起不了，`agent-autoloop init` 会说找不到。仍然想用 WSL2 的话按 Linux 装，注意系统服务要发行版开着 systemd（`/etc/wsl.conf` 里 `systemd=true`，没开就加 `--no-service`，自己运行 `agent-autoloop up`），没人登录时不启动要 `loginctl enable-linger`，桌面通知也到不了 Windows 桌面，WSL2 本身还要占 1GB 左右内存。

需要 Node.js 24 或更新、Git、curl，以及一个已经登录的命令行 Agent。

先检查 `node --version`。Homebrew 的 `node@24` 默认不进 PATH，装好后还要运行 `export PATH="$(brew --prefix node@24)/bin:$PATH"`；需要长期生效时再写入用户的 shell 配置。不要替用户登录，也不要读取或复制登录凭据。

本仓库已公开，安装脚本和代码都可匿名下载，不需要 GitHub 账号、登录或 GitHub CLI（`gh`）。下面的命令安装并启用登录后常驻服务：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh | sh
```

Windows 用 PowerShell，不需要管理员：

```powershell
irm https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.ps1 | iex
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

程序装进 `~/.agent-autoloop/app`，配置和记录留在 `~/.agent-autoloop`。默认打开桌面通知；没有图形会话时安静跳过，问题仍能用 `agent-autoloop status` 查看。命令优先放在 PATH 中的 `~/.local/bin`，否则选 PATH 里第一个可写目录，不用 sudo、不覆盖其他程序；没有位置时使用安装器打印的完整路径。

安装器和中台启动时都会把数据目录设为 `0700`，包括已有目录，阻止其他系统用户读取数据库、事件和运行输出。Windows 没有 `0700`，改用 `icacls` 把数据目录的权限锁到当前用户（去掉继承，只留你自己，子目录和文件跟着继承），`master.key` 另外单独锁一次；锁不上（网络盘、FAT32、域策略）不会拦着启动，但 `agent-autoloop doctor` 会多出一条“文件权限降级”，这时同机的其他用户可能读得到数据。升级后同步重启中台与接单程序；新版 `status` 使用中台提供的费用汇总。

升级时若投影格式有变化，会自动从旧日志逐条重建，历史多时首次启动需要等待；之后正常启动直接复用投影。原日志和已有卡片链接保留，不需要手动迁移。

## 临时 HOME、CI 或没有服务管理器

使用临时 HOME 时不要装系统服务，不改真实用户的 shell 配置和 Agent 配置。保留调用者给定的 `AGENT_AUTOLOOP_HOME`；用真实 `CODEX_HOME` 只为了沿用已经完成的 Codex 登录。

在临时环境中选一个空闲端口，运行本地安装脚本，随后启动中台：

```bash
port=$(node -e 'const s=require("node:net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
AGENT_AUTOLOOP_REPO=/path/to/agent-autoloop sh /path/to/agent-autoloop/install.sh --agent codex --no-service --port "$port"
agent-autoloop up
```

`up` 会一直运行。Windows 上停它别直接杀进程：往 `AGENT_AUTOLOOP_HOME` 下写一个空的 `stop` 文件，中台看到就自己收尾（`agent-autoloop uninstall` 也是这么停的）。Windows 没有 SIGTERM 可送，硬杀会留下 `up.pid` 和没关的连接。在 Agent 的命令工具里保留它返回的运行中会话，再用另一条命令完成验证；不要用 `nohup … &` 代替，命令工具可能在退出时清理后台进程。看到监听地址后再运行验证命令；启动失败就先处理该会话里的错误。

PATH 没有命令时，把 `agent-autoloop` 换成安装器打印的完整路径。临时测试使用假的 `osascript`、`notify-send`，不要发送真实消息；不要给已在线的飞书应用再开监听。

## 验证

先查看安装和连接情况，再用真实 Agent 跑完整问答：

```bash
agent-autoloop --version
agent-autoloop doctor
agent-autoloop try
```

`try` 会使用用户的模型额度。在非交互终端，它打印问题和 `agent-autoloop answer` 命令后退出；这是正常等待，不是失败。把问题转给用户，按他的选择回答，再运行 `agent-autoloop status`，看到“试跑通过”才算接通。仅为安装验证时，可以选择第二项绿色完成试跑。

Claude 要委托 Codex 处理网页时，可用[浏览器交接模板](examples/recipes/browser-handoff/README.md)，先配置现成入口，再验收首次调用与原会话续办。模板不安装浏览器驱动、不自动放宽 Claude 命令权限。

任务还需要网页操作时，另按[浏览器接入](docs/plugins.md#浏览器接入)用同一后台启动方式核实实际页面和会话接续。`try` 只证明问答流程；中台不自动提供浏览器连接或修改 Agent 的工具配置。需要本人恢复连接、登录或验证时，保留待验收项并交 `ask`，不要反复重跑已完成的业务。

没有安装系统服务时，`doctor` 会显示服务未运行；检查中台、Agent 和桌面通道是否在线即可，不要为了消除这条提示安装真实服务。Windows 上装了计划任务的话，`doctor` 会在“系统服务在跑”下面多一条说明，讲清“崩了最多等 5 分钟”这个语义差别——那是说明，不是红项。

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
