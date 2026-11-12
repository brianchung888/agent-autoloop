"""Shared contract for the Multica agent backends (Python port).

Python translation of the shared pieces of Multica's ``server/pkg/agent`` Go
package: the unified ``Backend`` interface, the ``ExecOptions`` / ``Session`` /
``Message`` / ``Result`` data types, and the common helpers every backend
relies on (argument filtering, environment construction, a bounded stderr tail,
cross-platform process spawning, and a streaming subprocess supervisor).

The Go original used goroutines + channels to stream events while the child CLI
runs. Here a background thread reads the child's stdout and pushes ``Message``
objects onto a queue; the caller iterates ``Session.messages()`` and blocks on
``Session.result()`` for the final ``Result`` -- the same producer/consumer
shape, expressed with the standard library.
"""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

# -- Message / Result types --------------------------------------------


class MessageType(str, Enum):
    """Identifies the kind of :class:`Message` (mirrors Go's MessageType)."""

    TEXT = "text"
    THINKING = "thinking"
    TOOL_USE = "tool-use"
    TOOL_RESULT = "tool-result"
    STATUS = "status"
    ERROR = "error"
    LOG = "log"


@dataclass
class TokenUsage:
    """Token consumption for a single model."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class Message:
    """A unified event emitted by an agent during execution."""

    type: MessageType
    content: str = ""
    tool: str = ""
    call_id: str = ""
    input: Optional[Dict[str, Any]] = None
    output: str = ""
    status: str = ""
    level: str = ""
    session_id: str = ""


@dataclass
class Result:
    """The final outcome after an agent session completes."""

    status: str = "completed"   # completed|failed|aborted|timeout|cancelled
    output: str = ""
    error: str = ""
    duration_ms: int = 0
    session_id: str = ""
    usage: Dict[str, TokenUsage] = field(default_factory=dict)
    # Structured, normalized failure diagnostics (empty on success).
    diagnostics: List["Diagnostic"] = field(default_factory=list)
    # 完整事件軌跡；僅在 ExecOptions.capture_transcript=True 時填入。
    transcript: List["Message"] = field(default_factory=list)

    @property
    def thinking(self) -> str:
        """把 transcript 中的推理片段串成一段文字（未開啟擷取時為空字串）。"""
        return "\n".join(m.content for m in self.transcript
                         if m.type == MessageType.THINKING and m.content)

    def transcript_text(self, include_thinking: bool = True) -> str:
        """把 transcript 轉成人類可讀的逐步紀錄，方便寫入記憶/日誌。"""
        lines = []
        for m in self.transcript:
            if m.type == MessageType.THINKING:
                if include_thinking and m.content:
                    lines.append("[思考] " + m.content)
            elif m.type == MessageType.TEXT and m.content:
                lines.append("[輸出] " + m.content)
            elif m.type == MessageType.TOOL_USE:
                lines.append("[工具] %s %s" % (m.tool, m.input if m.input else ""))
            elif m.type == MessageType.TOOL_RESULT and m.output:
                lines.append("[結果] " + m.output)
            elif m.type == MessageType.ERROR and m.content:
                lines.append("[錯誤] " + m.content)
        return "\n".join(lines)


# -- Config / options --------------------------------------------------


@dataclass
class ExecOptions:
    """Configures a single execution (mirrors Go's ExecOptions)."""

    cwd: str = ""
    model: str = ""
    system_prompt: str = ""
    thread_name: str = ""
    max_turns: int = 0
    # timeout in seconds; <= 0 means "no wall-clock deadline" (liveness is left
    # to the inactivity watchdog), matching the Go runContext semantics.
    timeout: float = 0.0
    semantic_inactivity_timeout: float = 0.0
    resume_session_id: str = ""
    extra_args: List[str] = field(default_factory=list)
    custom_args: List[str] = field(default_factory=list)
    # MCP server config as raw JSON bytes; if non-empty it is written to a temp
    # file and passed via --mcp-config (see write_mcp_config_to_temp).
    mcp_config: Optional[bytes] = None
    thinking_level: str = ""
    openclaw_mode: str = ""
    # Optional human-in-the-loop approval callback. When set, tool/exec/
    # patch approval points call it and honor a "rejected" decision instead
    # of the default auto-allow. Signature: (ApprovalRequest) -> ApprovalDecision.
    on_approval_request: Optional[Callable[["ApprovalRequest"], "ApprovalDecision"]] = None
    # 保留完整執行軌跡（thinking / tool-use / tool-result / text ...）到
    # Result.transcript。預設關閉：長時間自主執行的軌跡可能很大，是否留存
    # 應由呼叫端決定。
    capture_transcript: bool = False


# -- Minimal structured logger -----------------------------------------


class Logger:
    """A tiny stand-in for Go's *slog.Logger.

    Backends call ``logger.info("msg", key=value, ...)``. Output goes to stderr
    so it never contaminates a backend that streams JSON on stdout. Set
    ``enabled=False`` to silence it.
    """

    def __init__(self, enabled: bool = True, stream=None) -> None:
        self.enabled = enabled
        self.stream = stream or sys.stderr

    def _emit(self, level: str, msg: str, **kw: Any) -> None:
        if not self.enabled:
            return
        parts = ["%-5s" % level, msg]
        for k, v in kw.items():
            parts.append("%s=%r" % (k, v))
        print(" ".join(parts), file=self.stream, flush=True)

    def debug(self, msg: str, **kw: Any) -> None:
        self._emit("DEBUG", msg, **kw)

    def info(self, msg: str, **kw: Any) -> None:
        self._emit("INFO", msg, **kw)

    def warn(self, msg: str, **kw: Any) -> None:
        self._emit("WARN", msg, **kw)

    def error(self, msg: str, **kw: Any) -> None:
        self._emit("ERROR", msg, **kw)


@dataclass
class Config:
    """Configures a Backend instance (mirrors Go's Config)."""

    executable_path: str = ""
    env: Dict[str, str] = field(default_factory=dict)
    logger: Optional[Logger] = None

    def __post_init__(self) -> None:
        if self.logger is None:
            self.logger = Logger()


# -- Session (streaming) -----------------------------------------------

_MSG_DONE = object()
_MSG_QUEUE_SIZE = 256


class Session:
    """Represents a running agent execution.

    ``messages()`` yields :class:`Message` events as the agent works and stops
    once the agent finishes. ``result()`` blocks until the single final
    :class:`Result` is available. Mirrors the Go ``Session`` struct's
    ``Messages`` channel + ``Result`` channel.
    """

    def __init__(self, capture_transcript: bool = False) -> None:
        self._msg_q: "queue.Queue[Any]" = queue.Queue(maxsize=_MSG_QUEUE_SIZE)
        self._result: Optional[Result] = None
        self._result_ready = threading.Event()
        # 事件擷取：與佇列消費解耦，因此就算呼叫端沒有讀 messages()，
        # 或佇列滿載丟棄了事件，軌跡仍然完整。
        self._capture = capture_transcript
        self._transcript: List[Message] = []
        self._transcript_lock = threading.Lock()

    # producer side (backends / supervisor)
    def _emit(self, msg: Message) -> None:
        if self._capture:
            with self._transcript_lock:
                self._transcript.append(msg)
        try:
            self._msg_q.put_nowait(msg)
        except queue.Full:
            pass  # drop; final output is accumulated in Result.output

    def _close_messages(self) -> None:
        try:
            self._msg_q.put(_MSG_DONE, timeout=5)
        except queue.Full:
            pass

    def _set_result(self, result: Result) -> None:
        if self._capture and not result.transcript:
            with self._transcript_lock:
                result.transcript = list(self._transcript)
        if not result.diagnostics:
            diag = diagnostic_for_status(result.status, result.error)
            if diag is not None:
                result.diagnostics = [diag]
        self._result = result
        self._result_ready.set()

    # consumer side (callers)
    def messages(self) -> Iterator[Message]:
        while True:
            item = self._msg_q.get()
            if item is _MSG_DONE:
                return
            yield item

    def result(self, timeout: Optional[float] = None) -> Result:
        if not self._result_ready.wait(timeout=timeout):
            raise TimeoutError("agent result not ready within timeout")
        assert self._result is not None
        return self._result


# -- Backend interface -------------------------------------------------


class Backend(ABC):
    """Unified interface for executing prompts via coding agents."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    @abstractmethod
    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        """Run ``prompt`` and return a :class:`Session` for streaming results.

        ``cancel`` is the Python analogue of Go's context cancellation: setting
        the event asks the backend to terminate the child process.
        """
        raise NotImplementedError


# -- Argument filtering (filterCustomArgs / unshellQuote) ---------------


class BlockedArgMode(Enum):
    BLOCKED_WITH_VALUE = "with_value"
    BLOCKED_STANDALONE = "standalone"


def strip_surrounding_quotes(s: str) -> Tuple[str, bool]:
    if len(s) >= 2 and (
        (s[0] == "'" and s[-1] == "'") or (s[0] == '"' and s[-1] == '"')
    ):
        return s[1:-1], True
    return s, False


def unshell_quote_arg(arg: str) -> str:
    if arg.startswith("-"):
        idx = arg.find("=")
        if idx > 0:
            value = arg[idx + 1:]
            unquoted, ok = strip_surrounding_quotes(value)
            if ok:
                return arg[: idx + 1] + unquoted
            return arg
    unquoted, ok = strip_surrounding_quotes(arg)
    return unquoted if ok else arg


def filter_custom_args(args: List[str],
                       blocked: Dict[str, BlockedArgMode],
                       logger: Logger) -> List[str]:
    """Remove protocol-critical flags from user-configured custom args."""
    if not args:
        return list(args)
    filtered: List[str] = []
    skip = False
    for raw in args:
        if skip:
            skip = False
            continue
        arg = unshell_quote_arg(raw)
        flag = arg
        has_inline_value = False
        idx = arg.find("=")
        if idx > 0:
            flag = arg[:idx]
            has_inline_value = True
        mode = blocked.get(flag)
        if mode is not None:
            logger.warn("custom_args: blocked protocol-critical flag, skipping", flag=flag)
            if mode == BlockedArgMode.BLOCKED_WITH_VALUE and not has_inline_value:
                skip = True
            continue
        filtered.append(arg)
    return filtered


# -- Environment construction (buildEnv / mergeEnv) --------------------


def is_filtered_child_env_key(key: str) -> bool:
    if key in (
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SSE_PORT",
    ):
        return True
    return key.startswith("CLAUDECODE_")


def merge_env(base: Dict[str, str], extra: Dict[str, str]) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for k, v in base.items():
        if is_filtered_child_env_key(k):
            continue
        env[k] = v
    for k, v in (extra or {}).items():
        env[k] = v
    return env


def build_env(extra: Dict[str, str]) -> Dict[str, str]:
    return merge_env(dict(os.environ), extra or {})


# -- Bounded stderr tail (stderr_tail.go) ------------------------------

AGENT_STDERR_TAIL_BYTES = 2048

# 行程結束後，等 stderr 排空執行緒收尾的上限（秒）。有界，避免孫行程繼承
# 了 stderr 而讓管線遲遲不 EOF 時卡住收尾流程。
STDERR_DRAIN_GRACE = 2.0


class StderrTail:
    """Retains a bounded tail of the bytes written to it (thread-safe)."""

    def __init__(self, max_bytes: int = AGENT_STDERR_TAIL_BYTES,
                 inner: Optional[Callable[[bytes], None]] = None) -> None:
        self.max = max_bytes if max_bytes > 0 else AGENT_STDERR_TAIL_BYTES
        self._inner = inner
        self._buf = bytearray()
        self._lock = threading.Lock()

    def write(self, p: bytes) -> int:
        if self._inner is not None:
            self._inner(p)
        with self._lock:
            self._buf.extend(p)
            if len(self._buf) > self.max:
                del self._buf[: len(self._buf) - self.max]
        return len(p)

    def tail(self) -> str:
        with self._lock:
            return self._buf.decode("utf-8", "replace").strip()


def with_agent_stderr(msg: str, label: str, tail: str) -> str:
    if not tail:
        return msg
    return "%s; %s stderr: %s" % (msg, label, tail)


# -- Cross-platform process spawning (proc_*.go) -----------------------

_IS_WINDOWS = os.name == "nt"


def popen_platform_kwargs() -> Dict[str, Any]:
    """Popen kwargs that hide the console (Windows) and place the child in its
    own process group (POSIX). Combines hideAgentWindow + configureProcessGroup.
    """
    kw: Dict[str, Any] = {}
    if _IS_WINDOWS:
        si = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW  # type: ignore[attr-defined]
        si.wShowWindow = 0  # SW_HIDE
        kw["startupinfo"] = si
        kw["creationflags"] = 0x00000010  # CREATE_NEW_CONSOLE
    else:
        kw["start_new_session"] = True
    return kw


def signal_process_group(proc: "subprocess.Popen", sig: Optional[int] = None) -> None:
    """Signal the whole process group led by ``proc`` (POSIX) or kill it (Windows)."""
    if proc is None or proc.poll() is not None:
        return
    if _IS_WINDOWS:
        try:
            proc.kill()
        except Exception:
            pass
        return
    import signal as _signal
    if sig is None:
        sig = _signal.SIGTERM
    try:
        os.killpg(os.getpgid(proc.pid), sig)
    except Exception:
        try:
            proc.send_signal(sig)
        except Exception:
            pass


# -- Streaming subprocess supervisor -----------------------------------


@dataclass
class RunState:
    """Mutable per-run accumulators shared with a backend's line handler."""

    output: List[str] = field(default_factory=list)
    session_id: str = ""
    final_status: str = "completed"
    final_error: str = ""
    usage: Dict[str, TokenUsage] = field(default_factory=dict)
    diagnostics: List["Diagnostic"] = field(default_factory=list)


class StreamingRunner:
    """Supervisor for backends that spawn a CLI and read line-delimited output
    on stdout (claude, codebuddy, copilot, opencode, openclaw, pi, cursor,
    antigravity). Codex/ACP backends implement their own loops.
    """

    def __init__(self, cfg: Config, label: str) -> None:
        self.cfg = cfg
        self.label = label
        self.session = Session()
        self.state = RunState()
        self.proc: Optional[subprocess.Popen] = None

    def emit(self, msg: Message) -> None:
        self.session._emit(msg)

    def run(self,
            argv: List[str],
            env: Dict[str, str],
            cwd: str,
            on_line: Callable[[str, RunState, "StreamingRunner"], None],
            opts: ExecOptions,
            cancel: Optional[threading.Event] = None,
            stdin_payload: Optional[bytes] = None,
            keep_stdin_open: bool = False,
            on_finish: Optional[Callable[[RunState, "StreamingRunner"], None]] = None) -> Session:
        self.session._capture = bool(getattr(opts, "capture_transcript", False))
        exec_path = argv[0]
        if shutil.which(exec_path) is None and not os.path.isabs(exec_path):
            raise FileNotFoundError("%s executable not found: %r" % (self.label, exec_path))

        stderr_tail = StderrTail(
            inner=lambda b: self.cfg.logger.debug(
                "[%s:stderr] %s" % (self.label, b.decode("utf-8", "replace").rstrip()))
        )

        popen_kw = popen_platform_kwargs()
        self.cfg.logger.info("agent command", exec=exec_path, args=argv[1:])
        proc = subprocess.Popen(
            argv, cwd=cwd or None, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            bufsize=0, **popen_kw,
        )
        self.proc = proc

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            for chunk in iter(lambda: proc.stderr.readline(), b""):
                stderr_tail.write(chunk)

        stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
        stderr_thread.start()

        def _write_stdin() -> None:
            if stdin_payload is not None and proc.stdin is not None:
                try:
                    proc.stdin.write(stdin_payload)
                    proc.stdin.flush()
                except Exception as exc:  # noqa: BLE001
                    self.cfg.logger.warn("%s: stdin write failed" % self.label, error=str(exc))
                    if not self.state.final_error:
                        self.state.final_error = "write %s input: %s" % (self.label, exc)
            if not keep_stdin_open and proc.stdin is not None:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        threading.Thread(target=_write_stdin, daemon=True).start()

        def _supervise() -> None:
            start = time.monotonic()
            timed_out = {"v": False}
            aborted = {"v": False}
            deadline = start + opts.timeout if opts.timeout and opts.timeout > 0 else None
            stop_watch = threading.Event()

            def _watch() -> None:
                while not stop_watch.wait(0.1):
                    if proc.poll() is not None:
                        return
                    if deadline is not None and time.monotonic() > deadline:
                        timed_out["v"] = True
                        signal_process_group(proc)
                        return
                    if cancel is not None and cancel.is_set():
                        aborted["v"] = True
                        signal_process_group(proc)
                        return

            threading.Thread(target=_watch, daemon=True).start()

            assert proc.stdout is not None
            try:
                for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace").strip() if isinstance(raw, bytes) else raw.strip()
                    if not line:
                        continue
                    try:
                        on_line(line, self.state, self)
                    except Exception as exc:  # noqa: BLE001
                        self.cfg.logger.warn("%s: line handler error" % self.label, error=str(exc))
            finally:
                stop_watch.set()

            proc.wait()
            duration_ms = int((time.monotonic() - start) * 1000)
            st = self.state
            if timed_out["v"]:
                st.final_status = "timeout"
                st.final_error = "%s timed out after %ss" % (self.label, opts.timeout)
            elif aborted["v"]:
                st.final_status = "aborted"
                st.final_error = "execution cancelled"
            elif proc.returncode not in (0, None) and st.final_status == "completed":
                st.final_status = "failed"
                st.final_error = "%s exited with error: exit status %s" % (self.label, proc.returncode)

            if on_finish is not None:
                try:
                    on_finish(st, self)
                except Exception as exc:  # noqa: BLE001
                    self.cfg.logger.warn("%s: on_finish error" % self.label, error=str(exc))

            # stderr 由獨立執行緒排空。行程已結束，管線很快就會 EOF，這裡
            # 等它收乾淨再取用 tail()。
            #
            # 不等的話會出現一個難查的偶發問題：final_error 與診斷訊息裡的
            # stderr 尾巴時有時無（實測約 1/24 的機率漏掉），而這兩個欄位都
            # 屬於共同憲法——等於契約本身不是確定的，parity 會隨機變紅，
            # 也會讓「Rust 版是對是錯」無法判定。
            stderr_thread.join(timeout=STDERR_DRAIN_GRACE)

            if st.final_error:
                st.final_error = with_agent_stderr(st.final_error, self.label, stderr_tail.tail())

            self.cfg.logger.info("%s finished" % self.label,
                                 status=st.final_status, duration_ms=duration_ms)
            if st.final_status in ("failed", "timeout") and not st.diagnostics:
                _d = diagnostic_for_status(st.final_status, st.final_error, stderr_tail.tail())
                if _d is not None:
                    st.diagnostics.append(_d)
            self.session._set_result(Result(
                status=st.final_status, output="".join(st.output),
                error=st.final_error, duration_ms=duration_ms,
                session_id=st.session_id, usage=st.usage,
                diagnostics=st.diagnostics,
            ))
            self.session._close_messages()

        threading.Thread(target=_supervise, daemon=True).start()
        return self.session


# -- Structured diagnostics (ported from AgentSpace AgentRouter) --------


class DiagnosticSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class DiagnosticCode(str, Enum):
    CLI_MISSING = "harness.cli_missing"
    AUTH_REQUIRED = "harness.auth_required"
    AUTH_INVALID = "harness.auth_invalid"
    PROFILE_MISSING = "harness.profile_missing"
    MODEL_UNAVAILABLE = "harness.model_unavailable"
    TOOL_PERMISSION_DENIED = "harness.tool_permission_denied"
    EMPTY_RESPONSE = "harness.empty_response"
    PROTOCOL_PARSE_FAILED = "harness.protocol_parse_failed"
    TIMEOUT = "harness.timeout"
    SESSION_MISSING = "harness.session_missing"
    EXITED_NONZERO = "harness.exited_nonzero"
    CANCELLED = "harness.cancelled"
    UNKNOWN_FAILURE = "harness.unknown_failure"


@dataclass
class Diagnostic:
    """A normalized failure descriptor (mirrors AgentRouter's diagnostics)."""

    code: str
    message: str
    severity: str = DiagnosticSeverity.ERROR.value
    raw_provider_message: str = ""
    stderr_tail: str = ""


def create_diagnostic(code, message, severity=DiagnosticSeverity.ERROR.value,
                      raw_provider_message="", stderr_tail=""):
    code_val = code.value if isinstance(code, DiagnosticCode) else code
    sev_val = severity.value if isinstance(severity, DiagnosticSeverity) else severity
    return Diagnostic(code=code_val, message=message, severity=sev_val,
                      raw_provider_message=raw_provider_message, stderr_tail=stderr_tail)


def diagnostic_for_status(status, error, stderr_tail=""):
    """Synthesize a structured Diagnostic from a terminal status + free-text error.

    Returns None for the non-failure states so success carries no diagnostics.
    """
    if status == "timeout":
        return create_diagnostic(DiagnosticCode.TIMEOUT, error or "Agent timed out.",
                                 stderr_tail=stderr_tail)
    if status in ("aborted", "cancelled"):
        return create_diagnostic(DiagnosticCode.CANCELLED, error or "Execution cancelled.",
                                 severity=DiagnosticSeverity.INFO.value, stderr_tail=stderr_tail)
    if status == "failed":
        low = (error or "").lower()
        if "exit status" in low or "exited with" in low:
            code = DiagnosticCode.EXITED_NONZERO
        elif "empty" in low or "no parseable" in low or "no_parseable" in low:
            code = DiagnosticCode.EMPTY_RESPONSE
        elif "not found" in low or "executable" in low:
            code = DiagnosticCode.CLI_MISSING
        elif "timed out" in low or "timeout" in low:
            code = DiagnosticCode.TIMEOUT
        else:
            code = DiagnosticCode.UNKNOWN_FAILURE
        return create_diagnostic(code, error or "Agent failed.", stderr_tail=stderr_tail)
    return None


# -- Human-in-the-loop approval (ported from AgentRouter) ---------------


@dataclass
class ApprovalRequest:
    """A tool/exec/patch approval prompt handed to opts.on_approval_request."""

    harness: str
    tool_name: str
    tool_input: Optional[Dict[str, Any]] = None
    session_id: str = ""
    content_preview: str = ""


@dataclass
class ApprovalDecision:
    """The caller's verdict on an ApprovalRequest."""

    decision: str = "approved"   # "approved" | "rejected"
    comment: str = ""


def _approval_preview(tool_name, tool_input):
    if (tool_name == "Bash" and isinstance(tool_input, dict)
            and isinstance(tool_input.get("command"), str)):
        return "Bash: " + tool_input["command"]
    try:
        return "%s: %s" % (tool_name, json.dumps(tool_input or {}, ensure_ascii=False))
    except Exception:
        return "%s: %s" % (tool_name, tool_input)


def resolve_approval(opts, harness, tool_name, tool_input=None, session_id="", logger=None):
    """Consult opts.on_approval_request for a tool approval.

    Returns None when no callback is configured (caller should auto-allow, the
    historical daemon behavior). Returns an ApprovalDecision otherwise. Callback
    errors fail *open* (return None) so a broken hook never wedges a run.
    """
    cb = getattr(opts, "on_approval_request", None)
    if cb is None:
        return None
    try:
        return cb(ApprovalRequest(
            harness=harness, tool_name=tool_name or "unknown",
            tool_input=tool_input or {}, session_id=session_id,
            content_preview=_approval_preview(tool_name, tool_input)))
    except Exception as exc:  # noqa: BLE001
        if logger is not None:
            logger.warn("%s: approval callback error, auto-allowing" % harness, error=str(exc))
        return None


def approval_rejected(decision) -> bool:
    """True if a resolve_approval() result is a definite rejection."""
    return decision is not None and getattr(decision, "decision", "approved") != "approved"
