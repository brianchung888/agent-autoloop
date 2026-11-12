"""GitHub Copilot CLI backend (port of copilot.go + copilot_invocation*.go).

Spawns the ``copilot`` CLI in one-shot pipe mode
(``copilot -p "<prompt>" --output-format json --allow-all --no-ask-user``) and
parses its newline-delimited JSON event stream. Unlike claude/codebuddy the
prompt is passed as a CLI argument (not stdin), so no stdin frames are written.

Events arrive in Copilot's own envelope::

    { "type": "dotted.event.name", "data": {...}, "id": ..., "ephemeral": ... }

with a final synthetic ``result`` event carrying top-level ``sessionId`` /
``exitCode`` / ``usage``. Parsing is factored into :func:`handle_copilot_event`
so it can be exercised without spawning a process (mirrors Go's
``handleCopilotEvent``).

Windows invocation: npm ships ``copilot.cmd`` which routes through cmd.exe;
cmd.exe's ``%*`` re-tokenises the raw command line and mangles the multi-line
``-p`` prompt. As in the Go source we detect a ``.cmd``/``.bat`` launcher, find
the sibling ``copilot.ps1`` and invoke PowerShell with ``-File`` directly so
each argv element is passed as a discrete token. This is a condensed port of
``rewriteCmdToPS1`` (same intent; the PowerShell lookup order is preserved).
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env, filter_custom_args,
)

_IS_WINDOWS = os.name == "nt"

# Flags hardcoded by the daemon that user custom_args must not override.
_COPILOT_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--output-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--allow-all": BlockedArgMode.BLOCKED_STANDALONE,
    "--allow-all-tools": BlockedArgMode.BLOCKED_STANDALONE,
    "--allow-all-paths": BlockedArgMode.BLOCKED_STANDALONE,
    "--allow-all-urls": BlockedArgMode.BLOCKED_STANDALONE,
    "--yolo": BlockedArgMode.BLOCKED_STANDALONE,
    "--no-ask-user": BlockedArgMode.BLOCKED_STANDALONE,
    "--resume": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--acp": BlockedArgMode.BLOCKED_STANDALONE,
}


def build_copilot_args(prompt: str, opts: ExecOptions, logger: Logger) -> List[str]:
    """Assemble argv for a one-shot copilot invocation.

    copilot -p "<prompt>" --output-format json --allow-all --no-ask-user
            [--model <model>] [--resume <session-id>]
    """
    args = [
        "-p", prompt,
        "--output-format", "json",
        "--allow-all",   # tools + paths + URLs -- full headless mode
        "--no-ask-user",
    ]
    if opts.model:
        args += ["--model", opts.model]
    if opts.resume_session_id:
        args += ["--resume", opts.resume_session_id]
    args += filter_custom_args(opts.custom_args, _COPILOT_BLOCKED_ARGS, logger)
    return args


# -- Windows invocation rewrite (condensed rewriteCmdToPS1) ------------


def _default_powershell_lookup() -> Tuple[str, bool]:
    for name in ("pwsh.exe", "powershell.exe"):
        p = shutil.which(name)
        if p:
            return p, True
    root = os.environ.get("SystemRoot") or "C:\\Windows"
    candidate = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if os.path.isfile(candidate):
        return candidate, True
    return "", False


def choose_copilot_invocation(exec_name: str, args: List[str],
                              logger: Logger) -> Tuple[str, List[str]]:
    """Select argv[0] and the full argv. On non-Windows this is a no-op (the
    npm binstub execs node via shebang). On Windows rewrite copilot.cmd/.bat ->
    ``powershell -NoProfile -ExecutionPolicy Bypass -File copilot.ps1 <args>``.
    """
    looked_up = shutil.which(exec_name)
    if not _IS_WINDOWS or not looked_up:
        return exec_name, args
    ext = os.path.splitext(looked_up)[1].lower()
    if ext not in (".cmd", ".bat"):
        return exec_name, args
    ps1 = os.path.join(os.path.dirname(looked_up), "copilot.ps1")
    if not os.path.isfile(ps1):
        return exec_name, args
    ps_exe, ok = _default_powershell_lookup()
    if not ok:
        return exec_name, args
    full = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1] + args
    logger.info("copilot: routing through powershell -File to preserve argv tokens",
                powershell=ps_exe, ps1=ps1, original=looked_up)
    return ps_exe, full


# -- Event parsing -----------------------------------------------------


def with_copilot_exit_code(msg: str, exit_code: int) -> str:
    exit_msg = "copilot exited with code %d" % exit_code
    msg = (msg or "").strip()
    if not msg:
        return exit_msg
    if exit_msg in msg:
        return msg
    return msg + "; " + exit_msg


class CopilotEventState:
    """Mutable state accumulated while processing the JSONL event stream.

    Output is kept as a single string here (Go used a strings.Builder with
    TrimSuffix semantics); it is synced onto the shared RunState at finish.
    """

    def __init__(self, seed_model: str) -> None:
        self.output = ""
        self.session_id = ""
        self.active_model = seed_model
        self.final_status = "completed"
        self.final_error = ""
        self.usage: Dict[str, TokenUsage] = {}


def _add_output_tokens(st: CopilotEventState, tokens: int) -> None:
    if tokens > 0:
        u = st.usage.get(st.active_model, TokenUsage())
        u.output_tokens += tokens
        st.usage[st.active_model] = u


def handle_copilot_event(evt: dict, st: CopilotEventState) -> List[Message]:
    """Process one parsed Copilot event, mutate ``st``, return Messages to emit."""
    msgs: List[Message] = []
    etype = evt.get("type")
    data = evt.get("data")
    if not isinstance(data, dict):
        data = {}

    if etype == "session.start":
        selected = data.get("selectedModel")
        if selected:
            st.active_model = selected
        # Capture sessionId here too: the synthetic "result" event may never
        # arrive (timeout/cancel/crash). result still wins when present.
        if data.get("sessionId"):
            st.session_id = data["sessionId"]

    elif etype == "assistant.message_delta":
        delta = data.get("deltaContent") or ""
        if delta:
            # Defense-in-depth: keep text even if killed before assistant.message.
            st.output += delta
            msgs.append(Message(type=MessageType.TEXT, content=delta))

    elif etype == "assistant.message":
        content = data.get("content") or ""
        if content:
            # Deltas already wrote incrementally; reset to authoritative content
            # once to avoid double-counting, inserting a blank-line turn break.
            if st.output.endswith(content):
                st.output = st.output[: len(st.output) - len(content)]
            if st.output and not st.output.endswith("\n\n"):
                st.output += "\n\n"
            st.output += content
        reasoning = data.get("reasoningText") or ""
        if reasoning:
            msgs.append(Message(type=MessageType.THINKING, content=reasoning))
        _add_output_tokens(st, int(data.get("outputTokens", 0) or 0))
        for tr in data.get("toolRequests") or []:
            if not isinstance(tr, dict):
                continue
            input_map = None
            raw_args = tr.get("arguments")
            if isinstance(raw_args, dict):
                input_map = raw_args
            elif isinstance(raw_args, (str, bytes)):
                try:
                    input_map = json.loads(raw_args)
                except Exception:
                    input_map = None
            msgs.append(Message(type=MessageType.TOOL_USE, tool=tr.get("name", ""),
                                call_id=tr.get("toolCallId", ""), input=input_map))

    elif etype in ("assistant.reasoning", "assistant.reasoning_delta"):
        text = data.get("content") or data.get("deltaContent") or ""
        if text:
            msgs.append(Message(type=MessageType.THINKING, content=text))

    elif etype == "tool.execution_complete":
        if data.get("model"):
            st.active_model = data["model"]
        success = bool(data.get("success"))
        result = data.get("result") if isinstance(data.get("result"), dict) else None
        error = data.get("error") if isinstance(data.get("error"), dict) else None
        result_content = ""
        if success and result is not None:
            result_content = result.get("content", "")
        elif not success:
            if error is not None:
                result_content = "Error: " + (error.get("message", "") or "")
            elif result is not None:
                result_content = result.get("content", "")
        msgs.append(Message(type=MessageType.TOOL_RESULT,
                            call_id=data.get("toolCallId", ""), output=result_content))

    elif etype == "assistant.turn_start":
        msgs.append(Message(type=MessageType.STATUS, status="running"))

    elif etype == "session.error":
        message = data.get("message", "")
        st.final_status = "failed"
        st.final_error = message
        msgs.append(Message(type=MessageType.LOG, level="error", content=message))

    elif etype == "session.warning":
        message = data.get("message", "")
        msgs.append(Message(type=MessageType.LOG, level="warn", content=message))

    elif etype == "result":
        if evt.get("sessionId"):
            st.session_id = evt["sessionId"]
        exit_code = int(evt.get("exitCode", 0) or 0)
        if exit_code != 0:
            st.final_status = "failed"
            st.final_error = with_copilot_exit_code(st.final_error, exit_code)

    return msgs


class CopilotBackend:
    """Backend implementation for the GitHub Copilot CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_name = self.cfg.executable_path or "copilot"
        args = build_copilot_args(prompt, opts, self.cfg.logger)
        argv0, cmd_args = choose_copilot_invocation(exec_name, args, self.cfg.logger)

        env = build_env(self.cfg.env)
        runner = StreamingRunner(self.cfg, "copilot")

        seed_model = opts.model or "copilot"
        cst = CopilotEventState(seed_model)

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            try:
                evt = json.loads(line)
            except Exception:
                self.cfg.logger.warn("copilot event parse failed", line=line)
                return
            for m in handle_copilot_event(evt, cst):
                r.emit(m)

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            # Sync the copilot event state onto the shared RunState. The runner
            # already set timeout/aborted/nonzero-exit failures; only override
            # status/error when copilot's own stream reported a failure.
            st.output = [cst.output]
            st.session_id = cst.session_id
            st.usage = cst.usage
            if cst.final_status == "failed" and st.final_status == "completed":
                st.final_status = "failed"
                st.final_error = cst.final_error

        return runner.run(
            argv=[argv0] + cmd_args, env=env, cwd=opts.cwd, on_line=on_line,
            opts=opts, cancel=cancel, on_finish=on_finish,
        )
