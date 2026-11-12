"""Cursor Agent backend (port of cursor.go + cursor_invocation*.go).

Spawns the Cursor Agent CLI (``cursor-agent``) with
``-p <prompt> --output-format stream-json --yolo`` and parses its
newline-delimited JSON event stream. The protocol resembles Claude Code's
stream-json: each line is a JSON object with a ``type`` field.

Behaviour preserved from the Go original:

* Lines may carry a ``stdout:``/``stderr:`` prefix which is stripped
  (:func:`normalize_cursor_stream_line`).
* The terminal ``result`` event is treated as the protocol boundary: current
  cursor-agent versions can emit ``result`` yet keep a worker process alive,
  so we kill the child once ``result`` arrives (mirrors the Go ``cancel()``).
  Because of that the streaming supervisor may observe a non-zero exit; when a
  result was already seen we suppress the spurious "exited with error".
* Token usage comes from ``result`` events (authoritative session totals) when
  present, otherwise from accumulated ``step_finish`` events. Per-message usage
  in ``assistant`` events is intentionally ignored to avoid double-counting.
* cursor-agent does not support ``--system-prompt`` or ``--max-turns``;
  instructions are injected via AGENTS.md / .cursor/skills instead.

This module also hosts :func:`choose_ps1_invocation` / the PowerShell lookup,
the ``.cmd`` -> ``powershell -File <name>.ps1`` rewrite shared with the pi
backend (Go: cursor_invocation_windows.go, referenced by pi_invocation_windows.go).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env,
    filter_custom_args, signal_process_group,
)

_IS_WINDOWS = os.name == "nt"


# ── Windows .cmd -> PowerShell -File rewrite (shared with pi backend) ──


def default_powershell_lookup() -> Tuple[str, bool]:
    """Prefer PowerShell on PATH (pwsh.exe or a user powershell.exe), then fall
    back to the system Windows PowerShell."""
    for name in ("pwsh.exe", "powershell.exe"):
        p = shutil.which(name)
        if p:
            return p, True
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    candidate = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if os.path.isfile(candidate):
        return candidate, True
    return "", False


def rewrite_cmd_to_ps1(tool_name: str, looked_up: str, args: List[str],
                       logger: Logger) -> Tuple[str, List[str], bool]:
    """Rewrite an npm ``<tool>.cmd`` launcher to ``powershell -File <tool>.ps1``.

    Going through cmd.exe causes ``%*`` re-tokenisation that mangles multi-line
    arguments (most critically the ``-p`` prompt). Invoking PowerShell with
    ``-File`` directly lets each argv element pass as a discrete token. The ps1
    filename is derived from the canonical ``tool_name`` (not the launcher
    basename) so a custom .bat wrapper still resolves the right script.

    Returns ``(argv0, argv, True)`` when the rewrite applies, else
    ``("", [], False)``.
    """
    ext = os.path.splitext(looked_up)[1].lower()
    if ext not in (".cmd", ".bat"):
        return "", [], False
    ps1 = os.path.join(os.path.dirname(looked_up), tool_name + ".ps1")
    if not os.path.isfile(ps1):
        return "", [], False
    ps_exe, ok = default_powershell_lookup()
    if not ok:
        return "", [], False
    full = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1] + list(args)
    if logger is not None:
        logger.info(tool_name + ": routing through powershell -File to preserve argv tokens",
                    powershell=ps_exe, ps1=ps1, original=looked_up)
    return ps_exe, full, True


def choose_ps1_invocation(tool_name: str, exec_name: str, looked_up: str,
                          args: List[str], logger: Logger) -> Tuple[str, List[str]]:
    """Select argv[0] and full argv. On non-Windows this is a passthrough
    (native binary / shebang binstub); on Windows it applies the ``.cmd`` ->
    PowerShell rewrite when applicable."""
    if _IS_WINDOWS:
        argv0, full, ok = rewrite_cmd_to_ps1(tool_name, looked_up, args, logger)
        if ok:
            return argv0, full
    return exec_name, list(args)


# ── Stream-line normalisation ──

_CURSOR_STREAM_PREFIX_RE = re.compile(r"(?i)^(stdout|stderr)\s*[:=]?\s*")


def normalize_cursor_stream_line(raw: str) -> str:
    """Strip a leading ``stdout:``/``stderr:`` prefix cursor-agent may emit in
    stream-json mode; returns the trimmed JSON line."""
    trimmed = raw.strip()
    if not trimmed:
        return ""
    m = _CURSOR_STREAM_PREFIX_RE.match(trimmed)
    if m:
        return trimmed[m.end():].strip()
    return trimmed


# ── Usage parsing ──


def _first_nonzero(*values: int) -> int:
    for v in values:
        if v:
            return v
    return 0


def parse_cursor_usage(d: dict) -> Tuple[int, int, int, int]:
    """Parse a cursor usage object across its several historical shapes
    (top-level snake_case, camelCase, nested/legacy keys)."""
    g = lambda k: int(d.get(k, 0) or 0)
    input_tokens = _first_nonzero(g("input_tokens"), g("inputTokens"))
    output_tokens = _first_nonzero(g("output_tokens"), g("outputTokens"))
    cache_read = _first_nonzero(
        g("cached_input_tokens"), g("cachedInputTokens"), g("cacheReadTokens"),
        g("cache_read_input_tokens"), g("cacheReadInputTokens"),
    )
    cache_write = _first_nonzero(
        g("cacheWriteTokens"), g("cache_creation_input_tokens"),
        g("cacheCreationInputTokens"),
    )
    return input_tokens, output_tokens, cache_read, cache_write


def cursor_usage_model(evt_model: str, configured_model: str) -> str:
    m = (evt_model or "").strip()
    if m:
        return m
    c = (configured_model or "").strip()
    if c:
        return c
    return "cursor"


def cursor_error_text(evt: dict) -> str:
    for key in ("error", "detail", "result"):
        v = evt.get(key)
        if isinstance(v, str) and v:
            return v
    return ""


# ── Arg builder ──

# Flags hardcoded by the daemon that user custom_args must not override;
# overriding these would break the daemon <-> cursor-agent protocol.
_CURSOR_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_STANDALONE,           # non-interactive print mode
    "--output-format": BlockedArgMode.BLOCKED_WITH_VALUE,  # stream-json protocol
    "--yolo": BlockedArgMode.BLOCKED_STANDALONE,       # auto-approval / autonomy
}


def build_cursor_args(prompt: str, opts: ExecOptions, logger: Logger) -> List[str]:
    """Assemble argv for a one-shot cursor-agent invocation:

    ``cursor-agent -p <prompt> --output-format stream-json --yolo
    [--workspace <cwd>] [--model <m>] [--resume <id>] <custom_args...>``
    """
    args: List[str] = ["-p", prompt, "--output-format", "stream-json", "--yolo"]
    if opts.cwd:
        args += ["--workspace", opts.cwd]
    if opts.model:
        args += ["--model", opts.model]
    if opts.resume_session_id:
        args += ["--resume", opts.resume_session_id]
    args += filter_custom_args(opts.custom_args, _CURSOR_BLOCKED_ARGS, logger)
    return args


# ── Backend ──


class CursorBackend:
    """Backend implementation for the Cursor Agent CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_name = self.cfg.executable_path or "cursor-agent"
        looked_up = shutil.which(exec_name)
        if looked_up is None and not os.path.isabs(exec_name):
            raise FileNotFoundError("cursor-agent executable not found at %r" % exec_name)

        args = build_cursor_args(prompt, opts, self.cfg.logger)
        argv0, cmd_args = choose_ps1_invocation(
            "cursor-agent", exec_name, looked_up or exec_name, args, self.cfg.logger)

        runner = StreamingRunner(self.cfg, "cursor-agent")
        configured_model = (opts.model or "").strip()

        # Per-step totals fall back for when result events omit usage; result
        # totals are authoritative when present.
        step_usage: Dict[str, TokenUsage] = {}
        result_usage: Dict[str, TokenUsage] = {}
        flags = {"has_result_usage": False, "result_seen": False}

        def accumulate_result_usage(evt: dict) -> None:
            model = cursor_usage_model(evt.get("model", ""), configured_model)
            u = result_usage.get(model, TokenUsage())
            top = (int(evt.get("inputTokens", 0) or 0), int(evt.get("outputTokens", 0) or 0),
                   int(evt.get("cacheReadTokens", 0) or 0), int(evt.get("cacheWriteTokens", 0) or 0))
            if any(top):
                u.input_tokens += top[0]
                u.output_tokens += top[1]
                u.cache_read_tokens += top[2]
                u.cache_write_tokens += top[3]
            elif isinstance(evt.get("usage"), dict):
                i, o, cr, cw = parse_cursor_usage(evt["usage"])
                u.input_tokens += i
                u.output_tokens += o
                u.cache_read_tokens += cr
                u.cache_write_tokens += cw
            else:
                return
            result_usage[model] = u

        def has_result_usage(evt: dict) -> bool:
            return (isinstance(evt.get("usage"), dict)
                    or bool(evt.get("inputTokens")) or bool(evt.get("outputTokens"))
                    or bool(evt.get("cacheReadTokens")) or bool(evt.get("cacheWriteTokens")))

        def handle_assistant(evt: dict, st: RunState, r: StreamingRunner) -> None:
            content = evt.get("message")
            if not isinstance(content, dict):
                return
            # Per-message usage intentionally ignored (see module docstring).
            for block in content.get("content", []) or []:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype in ("output_text", "text"):
                    text = block.get("text") or ""
                    if text:
                        st.output.append(text)
                        r.emit(Message(type=MessageType.TEXT, content=text))
                elif btype == "thinking":
                    text = block.get("text") or ""
                    if text:
                        r.emit(Message(type=MessageType.THINKING, content=text))
                elif btype == "tool_use":
                    inp = block.get("input")
                    if not isinstance(inp, dict):
                        inp = None
                    r.emit(Message(type=MessageType.TOOL_USE, tool=block.get("name", ""),
                                   call_id=block.get("id", ""), input=inp))

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            line = normalize_cursor_stream_line(line)
            if not line:
                return
            try:
                evt = json.loads(line)
            except Exception:
                return
            if not isinstance(evt, dict):
                return

            sid = evt.get("session_id")
            if isinstance(sid, str) and sid.strip():
                st.session_id = sid.strip()

            etype = evt.get("type")

            if etype == "system":
                sub = evt.get("subtype")
                if sub == "init":
                    r.emit(Message(type=MessageType.STATUS, status="running"))
                elif sub == "error":
                    err = cursor_error_text(evt)
                    if err:
                        r.emit(Message(type=MessageType.ERROR, content=err))

            elif etype == "assistant":
                handle_assistant(evt, st, r)

            elif etype == "tool_use":
                params = evt.get("parameters")
                if not isinstance(params, dict):
                    params = None
                r.emit(Message(type=MessageType.TOOL_USE, tool=evt.get("tool_name", ""),
                               call_id=evt.get("tool_id", ""), input=params))

            elif etype == "tool_result":
                r.emit(Message(type=MessageType.TOOL_RESULT, call_id=evt.get("tool_id", ""),
                               output=evt.get("output", "") or ""))

            elif etype == "result":
                flags["result_seen"] = True
                if evt.get("is_error") or evt.get("subtype") == "error":
                    st.final_status = "failed"
                    st.final_error = cursor_error_text(evt)
                result_text = evt.get("result") or ""
                if result_text and not st.output:
                    st.output.append(result_text)
                    r.emit(Message(type=MessageType.TEXT, content=result_text))
                accumulate_result_usage(evt)
                if has_result_usage(evt):
                    flags["has_result_usage"] = True
                # Treat result as the protocol boundary: kill the (possibly
                # still-alive) worker so the run reports completion promptly.
                signal_process_group(r.proc)

            elif etype == "error":
                err = cursor_error_text(evt)
                if err:
                    st.final_error = err  # note: status is NOT changed (matches Go)
                r.emit(Message(type=MessageType.ERROR, content=err))

            elif etype == "text":
                part = evt.get("part")
                if isinstance(part, dict):
                    text = part.get("text") or ""
                    if text:
                        st.output.append(text)
                        r.emit(Message(type=MessageType.TEXT, content=text))

            elif etype == "step_finish":
                part = evt.get("part")
                if isinstance(part, dict):
                    tokens = part.get("tokens") or {}
                    cache = tokens.get("cache") or {}
                    model = cursor_usage_model(evt.get("model", ""), configured_model)
                    u = step_usage.get(model, TokenUsage())
                    u.input_tokens += int(tokens.get("input", 0) or 0)
                    u.output_tokens += int(tokens.get("output", 0) or 0)
                    u.cache_read_tokens += int(cache.get("read", 0) or 0)
                    step_usage[model] = u

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            # Result totals are authoritative; else fall back to step totals.
            st.usage = dict(result_usage) if flags["has_result_usage"] else dict(step_usage)
            # cursor.go guards both the "aborted" and "exited with error"
            # transitions with !resultSeen. The streaming supervisor doesn't
            # know about result_seen, and we deliberately kill the child on
            # result -- so undo the spurious failure/abort it may have recorded.
            if flags["result_seen"]:
                exit_err = st.final_error.startswith("cursor-agent exited with error")
                if st.final_status == "failed" and exit_err:
                    st.final_status = "completed"
                    st.final_error = ""
                elif st.final_status == "aborted":
                    st.final_status = "completed"
                    st.final_error = ""

        return runner.run(
            argv=[argv0] + cmd_args, env=build_env(self.cfg.env), cwd=opts.cwd,
            on_line=on_line, opts=opts, cancel=cancel,
            stdin_payload=None, keep_stdin_open=False, on_finish=on_finish,
        )
