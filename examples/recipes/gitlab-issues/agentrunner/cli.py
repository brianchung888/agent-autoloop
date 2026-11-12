"""agentrunner 命令列介面。

    agentrunner run  --agent claude --cwd /repo "把測試修好"
    agentrunner chat "一句話說明 JSON-RPC"
    agentrunner list
    agentrunner detect --agent claude

輸出有兩種模式：

* ``text``   —— 給人看的逐步輸出（偵測到 TTY 時的預設）
* ``ndjson`` —— 一行一個 JSON 事件（輸出被導向管線時的預設）

ndjson 的事件格式刻意與 agent-framework 的 ``_event()`` 契約同形
（``{"status", "response", ...}``），因此其他語言/框架可以直接 subprocess
呼叫本 CLI、逐行讀 stdout 來整合，不必 import 這個套件。

stdout 只承載事件流；所有日誌與提示一律走 stderr。
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import threading
from typing import List, Optional

from . import (SUPPORTED_TYPES, Config, ExecOptions, Logger, __version__,
               launch_header, new)
from ._version import detect_cli_version
from .base import ApprovalDecision, DiagnosticCode, MessageType
from .remote import RemoteVersionError

# ── exit code ─────────────────────────────────────────────────────────

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_TIMEOUT = 2
EXIT_ABORTED = 3
EXIT_CLI_MISSING = 4
EXIT_AUTH = 5
EXIT_USAGE = 64          # 沿用 sysexits.h 的 EX_USAGE

_DIAG_EXIT = {
    DiagnosticCode.TIMEOUT.value: EXIT_TIMEOUT,
    DiagnosticCode.CANCELLED.value: EXIT_ABORTED,
    DiagnosticCode.CLI_MISSING.value: EXIT_CLI_MISSING,
    DiagnosticCode.AUTH_REQUIRED.value: EXIT_AUTH,
    DiagnosticCode.AUTH_INVALID.value: EXIT_AUTH,
}
_STATUS_EXIT = {
    "completed": EXIT_OK,
    "failed": EXIT_FAILED,
    "timeout": EXIT_TIMEOUT,
    "aborted": EXIT_ABORTED,
    "cancelled": EXIT_ABORTED,
}


def exit_code_for(result) -> int:
    """由 diagnostics 優先、status 次之決定 exit code。"""
    for d in result.diagnostics:
        if d.code in _DIAG_EXIT:
            return _DIAG_EXIT[d.code]
    return _STATUS_EXIT.get(result.status, EXIT_FAILED)


# ── 輸出渲染 ───────────────────────────────────────────────────────────

_C = {"dim": "\033[2m", "cyan": "\033[36m", "green": "\033[32m",
      "yellow": "\033[33m", "red": "\033[31m", "off": "\033[0m"}


def _use_color(stream) -> bool:
    return (stream.isatty() and os.environ.get("NO_COLOR") is None
            and os.environ.get("TERM") != "dumb")


class TextRenderer:
    """給人看的逐步輸出。"""

    def __init__(self, stream, color: bool, quiet: bool = False) -> None:
        self.s = stream
        self.color = color
        self.quiet = quiet

    def _c(self, key, text):
        return "%s%s%s" % (_C[key], text, _C["off"]) if self.color else text

    def message(self, m) -> None:
        t = m.type
        if t == MessageType.TEXT:
            self.s.write(m.content)
        elif t == MessageType.THINKING and not self.quiet:
            self.s.write("\n" + self._c("dim", "[思考] " + m.content.strip()) + "\n")
        elif t == MessageType.TOOL_USE and not self.quiet:
            arg = "" if m.input is None else " " + json.dumps(m.input, ensure_ascii=False)
            self.s.write("\n" + self._c("cyan", "[工具] " + m.tool) + arg + "\n")
        elif t == MessageType.TOOL_RESULT and not self.quiet:
            out = (m.output or "").strip().replace("\n", " ")
            if len(out) > 200:
                out = out[:200] + "…"
            self.s.write(self._c("dim", "[結果] " + out) + "\n")
        elif t == MessageType.ERROR:
            self.s.write("\n" + self._c("red", "[錯誤] " + m.content) + "\n")
        self.s.flush()

    def final(self, result) -> None:
        ok = result.status == "completed"
        tag = self._c("green" if ok else "red", "[%s]" % result.status)
        self.s.write("\n\n%s %dms" % (tag, result.duration_ms))
        if result.session_id:
            self.s.write("  session=%s" % result.session_id)
        self.s.write("\n")
        if result.usage:
            for model, u in result.usage.items():
                self.s.write(self._c("dim", "  用量 %s: in=%d out=%d\n"
                                     % (model, u.input_tokens, u.output_tokens)))
        for d in result.diagnostics:
            self.s.write(self._c("yellow", "  %s: %s\n" % (d.code, d.message)))
        self.s.flush()


class NdjsonRenderer:
    """一行一個 JSON 事件，與 agent-framework 的 _event 契約同形。"""

    def __init__(self, stream) -> None:
        self.s = stream
        self._acc = ""

    def _emit(self, status: str, response: str = "", **extra) -> None:
        payload = {"status": status, "response": response}
        payload.update(extra)
        self.s.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self.s.flush()

    def start(self) -> None:
        self._emit("analyzing")

    def message(self, m) -> None:
        t = m.type
        if t == MessageType.TEXT:
            self._acc += m.content
            self._emit("generating", self._acc)
        elif t == MessageType.THINKING:
            self._emit("thinking", m.content)
        elif t == MessageType.TOOL_USE:
            self._emit("querying", "", tool=m.tool, input=m.input, call_id=m.call_id)
        elif t == MessageType.TOOL_RESULT:
            self._emit("tool_result", "", output=m.output, call_id=m.call_id)
        elif t == MessageType.ERROR:
            self._emit("error", m.content)

    def final(self, result) -> None:
        self._emit(
            "complete", result.output,
            agent_status=result.status,
            session_id=result.session_id,
            duration_ms=result.duration_ms,
            error=result.error,
            usage={k: vars(v) for k, v in result.usage.items()},
            diagnostics=[vars(d) for d in result.diagnostics],
        )


# ── 審批 ───────────────────────────────────────────────────────────────


def make_approver(mode: str, stream):
    """mode: auto（一律核准）| deny（一律拒絕）| ask（TTY 互動詢問）。"""
    if mode == "auto":
        return None                       # None = 沿用函式庫預設（自動核准）
    if mode == "deny":
        return lambda req: ApprovalDecision(decision="rejected", comment="--approve deny")

    state = {"all": False}

    def ask(req):
        if state["all"]:
            return ApprovalDecision(decision="approved")
        stream.write("\n[審批] %s\n允許? [y/N/a=全部允許] " % (req.content_preview or req.tool_name))
        stream.flush()
        try:
            answer = sys.stdin.readline().strip().lower()
        except Exception:
            answer = ""
        if answer == "a":
            state["all"] = True
            return ApprovalDecision(decision="approved")
        if answer in ("y", "yes"):
            return ApprovalDecision(decision="approved")
        return ApprovalDecision(decision="rejected", comment="使用者於終端機拒絕")

    return ask


# ── 共用小工具 ─────────────────────────────────────────────────────────


def read_prompt(value: Optional[str]) -> str:
    """位置參數為 '-' 或未提供時，從 stdin 讀取。"""
    if value and value != "-":
        return value
    if sys.stdin.isatty():
        return ""
    return sys.stdin.read().strip()


def resolve_output_mode(requested: str, stream) -> str:
    if requested != "auto":
        return requested
    return "text" if stream.isatty() else "ndjson"


def resolve_approve_mode(requested: str) -> str:
    if requested != "auto":
        return requested
    # 只有在 stdin/stdout 都是 TTY 時才可能互動詢問
    return "ask" if (sys.stdin.isatty() and sys.stderr.isatty()) else "auto"


def write_transcript(path: str, result) -> None:
    if path.endswith(".json"):
        data = [{"type": m.type.value, "content": m.content, "tool": m.tool,
                 "call_id": m.call_id, "input": m.input, "output": m.output}
                for m in result.transcript]
        body = json.dumps(data, ensure_ascii=False, indent=2)
    else:
        body = result.transcript_text()
    if not body.endswith("\n"):
        body += "\n"
    with open(path, "w", encoding="utf-8") as f:
        f.write(body)


# ── 子命令 ─────────────────────────────────────────────────────────────


def cmd_run(args) -> int:
    inline_mcp = None
    if getattr(args, "stdin_json", False):
        try:
            payload = json.loads(sys.stdin.read())
        except Exception as exc:                                # noqa: BLE001
            sys.stderr.write("錯誤：--stdin-json 解析失敗：%s\n" % exc)
            return EXIT_USAGE
        prompt = (payload.get("prompt") or "").strip()
        mcp = payload.get("mcp_config")
        if mcp is not None:
            inline_mcp = (mcp if isinstance(mcp, (bytes, bytearray))
                          else json.dumps(mcp).encode("utf-8"))
    else:
        prompt = read_prompt(args.prompt)
    if not prompt:
        sys.stderr.write("錯誤：未提供 prompt（可用位置參數或從 stdin 導入）\n")
        return EXIT_USAGE

    mode = resolve_output_mode(args.output, sys.stdout)
    renderer = (NdjsonRenderer(sys.stdout) if mode == "ndjson"
                else TextRenderer(sys.stdout, _use_color(sys.stdout), args.quiet))

    mcp_config = inline_mcp
    if mcp_config is None and args.mcp_config:
        with open(args.mcp_config, "rb") as f:
            mcp_config = f.read()

    opts = ExecOptions(
        cwd=args.cwd,
        model=args.model or "",
        thinking_level=args.effort or "",
        system_prompt=args.system_prompt or "",
        max_turns=args.max_turns,
        timeout=args.timeout,
        resume_session_id=args.resume or "",
        custom_args=list(args.custom_arg or []),
        mcp_config=mcp_config,
        capture_transcript=bool(args.transcript),
        on_approval_request=make_approver(resolve_approve_mode(args.approve), sys.stderr),
    )

    cfg = Config(executable_path=args.bin or "", logger=Logger(enabled=args.verbose))
    if args.remote:
        backend = _build_remote_backend(args, cfg)
        if backend is None:
            return EXIT_USAGE
    else:
        backend = new(args.agent, cfg)
    cancel = threading.Event()
    _install_sigint(cancel)

    try:
        session = backend.execute(prompt, opts, cancel=cancel)
    except FileNotFoundError as exc:
        sys.stderr.write("錯誤：%s\n" % exc)
        return EXIT_CLI_MISSING
    except RemoteVersionError as exc:
        sys.stderr.write("錯誤：%s\n" % exc)
        return EXIT_CLI_MISSING
    except Exception as exc:                                    # noqa: BLE001
        sys.stderr.write("錯誤：%s\n" % exc)
        return EXIT_FAILED

    if isinstance(renderer, NdjsonRenderer):
        renderer.start()
    for msg in session.messages():
        renderer.message(msg)
    result = session.result()
    renderer.final(result)

    if args.transcript:
        write_transcript(args.transcript, result)
        sys.stderr.write("軌跡已寫入 %s\n" % args.transcript)

    return exit_code_for(result)


def _build_remote_backend(args, cfg):
    """依 --remote 的形式選擇 transport 並建立遠端 backend。

    回傳 None 代表參數有誤（呼叫端應以 EXIT_USAGE 結束）。
    """
    from . import new_remote

    target = args.remote
    is_http = target.startswith("http://") or target.startswith("https://")
    kwargs = {}
    if is_http:
        if not args.remote_token:
            sys.stderr.write("錯誤：HTTP 遠端需要 --remote-token\n")
            return None
        kwargs["token"] = args.remote_token
    else:
        kwargs["remote_bin"] = args.remote_bin
        kwargs["ssh_bin"] = args.remote_ssh_bin
        if args.remote_ssh_arg:
            kwargs["ssh_args"] = tuple(args.remote_ssh_arg)
        # ssh 版沒有審批的回程通道；此時互動審批不會生效，明確告知使用者
        if resolve_approve_mode(args.approve) == "ask":
            sys.stderr.write(
                "提示：ssh 遠端不支援互動審批，工具呼叫將被拒絕。"
                "需要逐項核准請改用 HTTP 遠端（agentrunner serve）。\n")
    try:
        return new_remote(target, args.agent, cfg=cfg, **kwargs)
    except ValueError as exc:
        sys.stderr.write("錯誤：%s\n" % exc)
        return None


def cmd_chat(args) -> int:
    prompt = read_prompt(args.prompt)
    if not prompt:
        sys.stderr.write("錯誤：未提供 prompt\n")
        return EXIT_USAGE
    try:
        from agentrunner_chat import chat
    except ImportError:
        sys.stderr.write("錯誤：找不到 agentrunner_chat 模組\n")
        return EXIT_FAILED
    text = chat(prompt, timeout=args.timeout, model=args.model,
                thinking_level=args.effort, cwd=args.cwd or None,
                backend=args.backend)
    if text is None:
        return EXIT_FAILED
    sys.stdout.write(text + "\n")
    return EXIT_OK


def cmd_serve(args) -> int:
    from .server import build_server

    logger = Logger(enabled=True)
    httpd, token = build_server(host=args.host, port=args.port, token=args.token or "",
                                logger=logger, approval_timeout=args.approval_timeout,
                                default_bin=args.bin or "")
    sys.stderr.write("agentrunner serve 已啟動於 http://%s:%d\n" % (args.host, args.port))
    if not args.token:
        sys.stderr.write("已自動產生 token：%s\n" % token)
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        sys.stderr.write(
            "⚠ 注意：此服務等同開放遠端執行任意指令。你綁定了 %s（非 localhost），"
            "請確認已設置防火牆並在反向代理後終止 TLS。\n" % args.host)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\n停止中…\n")
        httpd.shutdown()
    return EXIT_OK


# ── models ─────────────────────────────────────────────────────────────
#
# 契約（共同憲法）：JSON 欄位名與 Python dataclass 一致；`thinking` 無資料時
# 為 null（不是 {}）；`description` 空字串保留、不省略欄位；陣列順序即靜態表
# 或探測結果的原始順序，**不排序**（排序會遮蓋兩版的順序差異）。

# text 模式的欄寬（凍結值——Rust 版必須用同一組數字，否則 parity 會紅）。
_MODELS_ID_WIDTH = 28
_MODELS_LABEL_WIDTH = 26
_MODELS_DEFAULT_MARK = "(default)"


def model_to_dict(m) -> dict:
    """Model dataclass → 契約 JSON。"""
    thinking = None
    if m.thinking is not None:
        thinking = {
            "supported_levels": [
                {"value": lv.value, "label": lv.label, "description": lv.description}
                for lv in m.thinking.supported_levels
            ],
            "default_level": m.thinking.default_level,
        }
    return {"id": m.id, "label": m.label, "provider": m.provider,
            "default": m.default, "thinking": thinking}


def format_models_text(models) -> str:
    """給人看的固定欄寬輸出。

    版面：``<id 28><空格><label 26><空格><(default) 9><空格>[levels]``
    每行右側空白一律裁掉，避免不同實作在尾隨空白上出現無意義的差異。
    """
    lines = []
    for m in models:
        levels = ""
        if m.thinking is not None and m.thinking.supported_levels:
            levels = "[" + " ".join(lv.value for lv in m.thinking.supported_levels) + "]"
        line = "%-*s %-*s %-*s %s" % (
            _MODELS_ID_WIDTH, m.id,
            _MODELS_LABEL_WIDTH, m.label,
            len(_MODELS_DEFAULT_MARK), _MODELS_DEFAULT_MARK if m.default else "",
            levels,
        )
        lines.append(line.rstrip())
    return "".join(line + "\n" for line in lines)


def cmd_models(args) -> int:
    from .models import list_models

    agent = (args.agent or "").strip()
    if agent not in SUPPORTED_TYPES:
        sys.stderr.write(
            "錯誤：未知的 agent：%r\n支援：%s\n" % (agent, ", ".join(SUPPORTED_TYPES)))
        return EXIT_USAGE

    try:
        models = list_models(agent, args.bin or "")
    except ValueError as exc:
        sys.stderr.write("錯誤：%s\n" % exc)
        return EXIT_USAGE

    if args.output == "json":
        sys.stdout.write(json.dumps([model_to_dict(m) for m in models],
                                    ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(format_models_text(models))
    # 探測失敗而回退到靜態表、或回傳空清單，都是正常行為，不是錯誤。
    return EXIT_OK


def cmd_list(args) -> int:
    if args.output == "json":
        sys.stdout.write(json.dumps(
            [{"agent": t, "launch": launch_header(t)} for t in SUPPORTED_TYPES],
            ensure_ascii=False, indent=2) + "\n")
    else:
        for t in SUPPORTED_TYPES:
            sys.stdout.write("%-12s %s\n" % (t, launch_header(t)))
    return EXIT_OK


def cmd_detect(args) -> int:
    targets = [args.agent] if args.agent else list(SUPPORTED_TYPES)
    rows = []
    for t in targets:
        exe = args.bin or _default_bin(t)
        try:
            rows.append({"agent": t, "executable": exe,
                         "status": "available", "version": detect_cli_version(exe)})
        except Exception as exc:                                # noqa: BLE001
            rows.append({"agent": t, "executable": exe,
                         "status": "missing", "error": str(exc)})
    if args.output == "json":
        sys.stdout.write(json.dumps(rows, ensure_ascii=False, indent=2) + "\n")
    else:
        for r in rows:
            mark = "✓" if r["status"] == "available" else "✗"
            sys.stdout.write("%s %-12s %s\n" % (mark, r["agent"], r.get("version", "—")))
    return EXIT_OK if any(r["status"] == "available" for r in rows) else EXIT_CLI_MISSING


_DEFAULT_BINS = {"kiro": "kiro-cli", "qoder": "qodercli", "antigravity": "agy",
                 "cursor": "cursor-agent"}


def _default_bin(agent_type: str) -> str:
    return _DEFAULT_BINS.get(agent_type, agent_type)


def _install_sigint(cancel: threading.Event) -> None:
    """第一次 Ctrl-C 請求取消（子行程群組會被收乾淨），第二次強制結束。"""
    state = {"hit": False}

    def handler(_signum, _frame):
        if state["hit"]:
            sys.stderr.write("\n強制結束。\n")
            os._exit(EXIT_ABORTED)
        state["hit"] = True
        cancel.set()
        sys.stderr.write("\n收到中斷，正在停止 agent…（再按一次強制結束）\n")

    try:
        signal.signal(signal.SIGINT, handler)
    except ValueError:
        pass          # 非主執行緒，略過


# ── 進入點 ─────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="agentrunner",
        description="用一致的介面執行各家 coding agent（單輪 / 自主多輪 / 跨次續接）。")
    p.add_argument("-V", "--version", action="version",
                   version="agentrunner %s" % __version__)
    sub = p.add_subparsers(dest="command")

    r = sub.add_parser("run", help="交付任務給 agent，串流其執行過程")
    r.add_argument("prompt", nargs="?", help="任務內容；'-' 或省略時從 stdin 讀取")
    r.add_argument("--agent", default="claude", choices=SUPPORTED_TYPES)
    r.add_argument("--bin", help="CLI 執行檔路徑（預設走 PATH）")
    r.add_argument("--cwd", default=".", help="工作目錄")
    r.add_argument("--model")
    r.add_argument("--effort", help="推理強度，如 low/medium/high")
    r.add_argument("--system-prompt")
    r.add_argument("--max-turns", type=int, default=0, help="0 = 不限（自主多輪）")
    r.add_argument("--timeout", type=float, default=0.0, help="秒；0 = 不設上限")
    r.add_argument("--resume", help="續接指定的 session id")
    r.add_argument("--mcp-config", help="MCP server 設定檔（JSON）")
    r.add_argument("--custom-arg", action="append", help="額外傳給 CLI 的參數，可重複")
    r.add_argument("--transcript", help="把執行軌跡寫入檔案（.json 為結構化格式）")
    r.add_argument("--output", default="auto", choices=["auto", "text", "ndjson"])
    r.add_argument("--remote", metavar="TARGET",
                   help="在遠端執行。ssh 目標（user@host）或 HTTP 服務位址"
                        "（http://host:8700）；後者需搭配 --remote-token")
    r.add_argument("--remote-token", help="HTTP 遠端服務的 bearer token")
    r.add_argument("--remote-bin", default="agentrunner",
                   help="遠端主機上的 agentrunner 路徑（ssh 模式，預設 agentrunner）")
    r.add_argument("--remote-ssh-bin", default="ssh", help="本機 ssh 執行檔")
    r.add_argument("--remote-ssh-arg", action="append",
                   help="額外的 ssh 參數，可重複（如 -p 2222 / -i key）")
    r.add_argument("--stdin-json", action="store_true",
                   help="stdin 為 JSON 封包 {\"prompt\":…, \"mcp_config\":…}；供遠端呼叫傳遞機密而不落在命令列")
    r.add_argument("--approve", default="auto", choices=["auto", "ask", "deny"],
                   help="工具審批：auto=自動核准，ask=終端機詢問，deny=一律拒絕")
    r.add_argument("--quiet", action="store_true", help="只輸出文字，不顯示思考與工具")
    r.add_argument("--verbose", action="store_true", help="把除錯 log 輸出到 stderr")
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("chat", help="單輪問答，只回傳文字")
    c.add_argument("prompt", nargs="?")
    # agentrunner_chat 只支援這三個後端（見其 _get_backend）；刻意用 choices
    # 讓打錯的後端在 argparse 層就被攔下，而不是等到 ValueError。
    c.add_argument("--backend", default="claude",
                   choices=["claude", "codex", "antigravity"],
                   help="單輪問答使用的後端；預設 claude")
    c.add_argument("--model")
    c.add_argument("--effort")
    c.add_argument("--cwd")
    c.add_argument("--timeout", type=float, default=120.0)
    c.set_defaults(func=cmd_chat)

    sv = sub.add_parser("serve", help="啟動 HTTP 服務，供遠端呼叫（路徑二）")
    sv.add_argument("--host", default="127.0.0.1", help="綁定位址；預設僅 localhost")
    sv.add_argument("--port", type=int, default=8700)
    sv.add_argument("--token", help="bearer token；未提供時自動產生並印出")
    sv.add_argument("--bin", help="本機 agent CLI 執行檔（傳給 backend）")
    sv.add_argument("--approval-timeout", type=float, default=300.0,
                    help="等待客戶端回覆審批的秒數；逾時採保守拒絕")
    sv.set_defaults(func=cmd_serve)

    mo = sub.add_parser("models", help="列出某個 agent 的模型與 reasoning 等級")
    # 刻意不用 choices：未知 agent 要回 EXIT_USAGE(64)，而不是 argparse 的 2。
    mo.add_argument("--agent", default="", help="agent 類型（14 種之一）")
    mo.add_argument("--bin", help="agent CLI 執行檔路徑（預設走 PATH）")
    mo.add_argument("--output", default="text", choices=["text", "json"])
    mo.set_defaults(func=cmd_models)

    l = sub.add_parser("list", help="列出支援的 agent")
    l.add_argument("--output", default="text", choices=["text", "json"])
    l.set_defaults(func=cmd_list)

    d = sub.add_parser("detect", help="偵測本機可用的 agent CLI 與版本")
    d.add_argument("--agent", choices=SUPPORTED_TYPES)
    d.add_argument("--bin")
    d.add_argument("--output", default="text", choices=["text", "json"])
    d.set_defaults(func=cmd_detect)

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "command", None):
        parser.print_help()
        return EXIT_USAGE
    try:
        return args.func(args)
    except BrokenPipeError:
        return EXIT_OK          # 下游關閉管線（如 | head），視為正常
    except KeyboardInterrupt:
        return EXIT_ABORTED


if __name__ == "__main__":
    sys.exit(main())
