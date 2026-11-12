"""Pi backend (port of pi.go + pi_invocation*.go).

Spawns the Pi CLI in non-interactive JSON mode
(``pi -p --mode json --session <path>``) with the prompt as the final
positional argument, and parses its newline-delimited JSON event stream on
stdout into the unified Message/Result types.

Notable Pi-specific behaviour preserved from the Go original:

* ``--session <path>`` names a JSONL file that Pi appends events to. The path
  doubles as the opaque session id: it is returned as ``session_id`` and
  expected back as ``resume_session_id`` on the next turn. Pi refuses to start
  when the file is missing, so it is created up front (see
  :func:`ensure_pi_session_file`). New sessions live under
  ``~/.multica/pi-sessions/<timestamp>.jsonl``.
* Pi reads its prompt from argv and never expects interactive input, but has
  been observed to block awaiting stdin under systemd (#2188). The
  :class:`StreamingRunner` attaches a stdin pipe and closes it immediately
  (no payload, ``keep_stdin_open=False``), delivering an explicit EOF.
* Pi emits partial tool-call markup inside its ``text_delta`` stream. The
  ``drain_pi_*`` / ``strip_pi_*`` helpers strip structured tool markup
  (``call:name{...}<tool_call|>``) and control tokens (``<|...|>``) while
  buffering across deltas so a split marker is never emitted verbatim.

Windows quirk (condensed): the npm ``pi.cmd`` launcher shells out via cmd.exe,
whose ``%*`` re-tokenises the raw command line and mangles the multi-line
positional prompt (#3306). We resolve ``pi.ps1`` next to the ``.cmd`` and run
PowerShell with ``-File`` directly so each argv token is preserved. The rewrite
helper is shared with the cursor backend (see :mod:`.cursor`).
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, filter_custom_args,
)
from .cursor import choose_ps1_invocation

# ── Tool-call / control-token markup sanitisation ──

# Matches Pi control tokens such as ``<|foo>bar`` or ``<foo|>``.
_PI_CONTROL_TOKEN_RE = re.compile(r"<\|[A-Za-z0-9_-]+>[A-Za-z0-9_-]*|<[A-Za-z0-9_-]+\|>")

_PI_MARKUP_PREFIXES = ("call:", "response:")
_PI_QUOTE_MARKER = '<|"|>'
_PI_TOOL_CALL_TAIL = "<tool_call|>"


def _is_pi_tool_name_byte(b: str) -> bool:
    return ("a" <= b <= "z") or ("A" <= b <= "Z") or ("0" <= b <= "9") or b in ("_", "-")


def looks_like_pi_control_token_prefix(s: str) -> bool:
    if len(s) == 0 or s[0] != "<" or len(s) > 64:
        return False
    for i in range(1, len(s)):
        b = s[i]
        if (("a" <= b <= "z") or ("A" <= b <= "Z") or ("0" <= b <= "9")
                or b in ("_", "-", "|", ">")):
            continue
        return False
    return True


def next_pi_tool_markup_prefix(s: str, frm: int) -> Tuple[int, int]:
    best = -1
    best_len = 0
    for prefix in _PI_MARKUP_PREFIXES:
        i = s.find(prefix, frm)
        if i >= 0 and (best == -1 or i < best):
            best = i
            best_len = len(prefix)
    return best, best_len


def scan_pi_tool_markup_end(s: str, i: int) -> Tuple[int, bool]:
    name_start = i
    while i < len(s) and _is_pi_tool_name_byte(s[i]):
        i += 1
    if i == name_start or i >= len(s) or s[i] != "{":
        return 0, False

    depth = 0
    in_quote = False
    qlen = len(_PI_QUOTE_MARKER)
    while i < len(s):
        if s.startswith(_PI_QUOTE_MARKER, i):
            in_quote = not in_quote
            i += qlen
            continue
        if not in_quote:
            c = s[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    i += 1
                    if s.startswith(_PI_TOOL_CALL_TAIL, i):
                        i += len(_PI_TOOL_CALL_TAIL)
                    return i, True
        i += 1
    return 0, False


def safe_pi_text_emit_len(s: str) -> int:
    """Longest suffix length that is safe to emit now, holding back any bytes
    that might be the start of a split ``call:``/``response:`` prefix or a
    partial ``<...`` control token."""
    hold = 0
    for prefix in _PI_MARKUP_PREFIXES:
        n = 1
        while n < len(prefix) and n <= len(s):
            if s.endswith(prefix[:n]) and n > hold:
                hold = n
            n += 1
    idx = s.rfind("<")
    if idx >= 0 and looks_like_pi_control_token_prefix(s[idx:]):
        if len(s) - idx > hold:
            hold = len(s) - idx
    return len(s) - hold


def drain_pi_sanitized_text(s: str) -> Tuple[str, str]:
    """Return (emit, pending): the sanitised text ready to emit and the
    trailing bytes that must be buffered until more input arrives."""
    out: List[str] = []
    i = 0
    while i < len(s):
        start, prefix_len = next_pi_tool_markup_prefix(s, i)
        if start == -1:
            safe_len = safe_pi_text_emit_len(s[i:])
            out.append(s[i:i + safe_len])
            return _PI_CONTROL_TOKEN_RE.sub("", "".join(out)), s[i + safe_len:]
        out.append(s[i:start])
        end, ok = scan_pi_tool_markup_end(s, start + prefix_len)
        if not ok:
            return _PI_CONTROL_TOKEN_RE.sub("", "".join(out)), s[start:]
        i = end
    return _PI_CONTROL_TOKEN_RE.sub("", "".join(out)), ""


def strip_pi_structured_tool_markup(s: str) -> str:
    out: List[str] = []
    i = 0
    while i < len(s):
        start, prefix_len = next_pi_tool_markup_prefix(s, i)
        if start == -1:
            out.append(s[i:])
            break
        out.append(s[i:start])
        end, ok = scan_pi_tool_markup_end(s, start + prefix_len)
        if not ok:
            out.append(s[start:])
            break
        i = end
    return "".join(out)


def strip_pi_tool_call_markup(s: str) -> str:
    return _PI_CONTROL_TOKEN_RE.sub("", strip_pi_structured_tool_markup(s))


def drain_pi_text_buffer(buf: List[str], delta: str) -> str:
    """Append ``delta`` to the single-element buffer ``buf`` and return the
    text ready to emit; leftover bytes stay in ``buf[0]``."""
    s = buf[0] + delta
    emit, pending = drain_pi_sanitized_text(s)
    buf[0] = pending
    return emit


def flush_pi_text_buffer(buf: List[str]) -> str:
    s = buf[0]
    buf[0] = ""
    emit, pending = drain_pi_sanitized_text(s)
    emit += _PI_CONTROL_TOKEN_RE.sub("", pending)
    return emit


# ── Event value decoders ──


def decode_pi_message(raw: Any) -> Optional[dict]:
    return raw if isinstance(raw, dict) else None


def decode_pi_string(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    import json as _json
    return _json.dumps(raw)


def decode_pi_result(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    import json as _json
    return _json.dumps(raw)


# ── Arg builder ──

# Flags hardcoded by the daemon that user custom_args must not override;
# overriding these would break the daemon <-> Pi protocol.
_PI_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_STANDALONE,        # non-interactive mode
    "--print": BlockedArgMode.BLOCKED_STANDALONE,   # alias for -p
    "--mode": BlockedArgMode.BLOCKED_WITH_VALUE,    # "json" event stream protocol
    "--session": BlockedArgMode.BLOCKED_WITH_VALUE,  # daemon manages session path
}


def split_pi_model(s: str) -> Tuple[str, str]:
    """Parse ``provider/model`` into (provider, model). Plain ``model`` passes
    through as (``""``, ``model``)."""
    s = s.strip()
    i = s.find("/")
    if i >= 0:
        return s[:i].strip(), s[i + 1:].strip()
    return "", s


def build_pi_args(prompt: str, session_path: str, opts: ExecOptions,
                  logger: Logger) -> List[str]:
    """Assemble argv for a one-shot Pi invocation.

    The prompt is a positional argument and must be last. We intentionally do
    NOT pass ``--tools`` (omitting it lets Pi use its full registry, including
    user-installed extension tools -- see #2379); tool restriction is left to
    custom_args.
    """
    args: List[str] = ["-p", "--mode", "json"]
    if session_path:
        args += ["--session", session_path]
    if opts.model:
        provider, model = split_pi_model(opts.model)
        if provider:
            args += ["--provider", provider]
        if model:
            args += ["--model", model]
    if opts.system_prompt:
        args += ["--append-system-prompt", opts.system_prompt]
    args += filter_custom_args(opts.custom_args, _PI_BLOCKED_ARGS, logger)
    args.append(prompt)
    return args


# ── Session path management ──


def pi_session_dir() -> str:
    """Directory where Pi session JSONL files live."""
    return os.path.join(os.path.expanduser("~"), ".multica", "pi-sessions")


def new_pi_session_path() -> str:
    now = time.time_ns()
    name = "%s.%09d.jsonl" % (
        time.strftime("%Y%m%dT%H%M%S", time.gmtime(now // 1_000_000_000)),
        now % 1_000_000_000,
    )
    return os.path.join(pi_session_dir(), name)


def ensure_pi_session_file(path: str) -> None:
    """Create an empty session file if one does not yet exist. Pi refuses to
    start when ``--session`` points at a missing file; existing paths (a
    resumed session) are left untouched."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    os.close(fd)


# ── Backend ──


class PiBackend:
    """Backend implementation for the Pi CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_name = self.cfg.executable_path or "pi"
        looked_up = shutil.which(exec_name)
        if looked_up is None and not os.path.isabs(exec_name):
            raise FileNotFoundError("pi executable not found at %r" % exec_name)

        # --session names a file where events are appended; it doubles as the
        # opaque session id (returned as session_id, echoed back as
        # resume_session_id on the next turn).
        session_path = opts.resume_session_id or new_pi_session_path()
        ensure_pi_session_file(session_path)

        args = build_pi_args(prompt, session_path, opts, self.cfg.logger)
        argv0, cmd_args = choose_ps1_invocation(
            "pi", exec_name, looked_up or exec_name, args, self.cfg.logger)

        runner = StreamingRunner(self.cfg, "pi")
        runner.state.session_id = session_path
        text_buffer: List[str] = [""]

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            import json as _json
            try:
                evt = _json.loads(line)
            except Exception:
                return
            if not isinstance(evt, dict):
                return
            etype = evt.get("type")

            if etype == "agent_start":
                r.emit(Message(type=MessageType.STATUS, status="running"))

            elif etype == "turn_start":
                st.output.clear()
                text_buffer[0] = ""

            elif etype == "message_update":
                ame = evt.get("assistantMessageEvent")
                if not isinstance(ame, dict):
                    return
                atype = ame.get("type")
                if atype == "text_delta":
                    d = drain_pi_text_buffer(text_buffer, ame.get("delta", "") or "")
                    if d:
                        st.output.append(d)
                        r.emit(Message(type=MessageType.TEXT, content=d))
                elif atype == "thinking_delta":
                    d = ame.get("delta", "") or ""
                    if d:
                        r.emit(Message(type=MessageType.THINKING, content=d))

            elif etype == "tool_execution_start":
                params = evt.get("args")
                if not isinstance(params, dict):
                    params = None
                r.emit(Message(type=MessageType.TOOL_USE, tool=evt.get("toolName", ""),
                               call_id=evt.get("toolCallId", ""), input=params))

            elif etype == "tool_execution_end":
                r.emit(Message(type=MessageType.TOOL_RESULT,
                               call_id=evt.get("toolCallId", ""),
                               output=decode_pi_result(evt.get("result"))))

            elif etype == "turn_end":
                msg = decode_pi_message(evt.get("message"))
                if msg is not None and isinstance(msg.get("usage"), dict):
                    u = msg["usage"]
                    model = msg.get("model") or opts.model or "unknown"
                    acc = st.usage.get(model, TokenUsage())
                    acc.input_tokens += int(u.get("input", 0) or 0)
                    acc.output_tokens += int(u.get("output", 0) or 0)
                    acc.cache_read_tokens += int(u.get("cacheRead", 0) or 0)
                    acc.cache_write_tokens += int(u.get("cacheWrite", 0) or 0)
                    st.usage[model] = acc

            elif etype == "error":
                err_text = decode_pi_string(evt.get("message"))
                r.emit(Message(type=MessageType.ERROR, content=err_text))
                if st.final_status == "completed":
                    st.final_status = "failed"
                    st.final_error = err_text

            elif etype == "auto_retry_end":
                if not evt.get("success") and st.final_status == "completed":
                    st.final_status = "failed"
                    st.final_error = evt.get("finalError") or "pi exhausted automatic retries"

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            # Flush any text still held in the sanitiser buffer (mirrors the
            # post-scan flush in pi.go, before the Result is built).
            d = flush_pi_text_buffer(text_buffer)
            if d:
                st.output.append(d)
                r.emit(Message(type=MessageType.TEXT, content=d))
            # session_id is always the session path (set on runner.state above);
            # nothing in the stream overrides it.
            st.session_id = session_path

        return runner.run(
            argv=[argv0] + cmd_args, env=runner_env(self.cfg), cwd=opts.cwd,
            on_line=on_line, opts=opts, cancel=cancel,
            stdin_payload=None, keep_stdin_open=False, on_finish=on_finish,
        )


def runner_env(cfg: Config) -> Dict[str, str]:
    from .base import build_env
    return build_env(cfg.env)
