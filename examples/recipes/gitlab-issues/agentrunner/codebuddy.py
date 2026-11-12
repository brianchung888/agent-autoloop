"""CodeBuddy backend (port of codebuddy.go).

CodeBuddy is a Claude Code fork, so this backend is structurally identical to
:mod:`claude`: it spawns the ``codebuddy`` CLI with ``--output-format
stream-json --input-format stream-json``, writes the prompt as a single user
frame on stdin, keeps stdin open to auto-approve ``control_request`` events,
and parses the stream-json events into the unified Message/Result types.

The Go original streamed via goroutines + channels; here the shared
:class:`~.base.StreamingRunner` supervises the child (one thread writes stdin,
one drains stderr, one reads stdout line-by-line, one watches the deadline /
cancel event) and hands us a :class:`~.base.Session`.
"""

from __future__ import annotations

import json
import threading
from typing import Any, Dict, List, Optional

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env, filter_custom_args,
    resolve_approval,
)
from ._mcp import cleanup_mcp_config_temp, write_mcp_config_to_temp
from ._promptfile import fold_system_prompt_into_prompt, system_prompt_fits_argv

# Flags hardcoded by the daemon that user custom_args must not override.
# Overriding these would break the daemon<->codebuddy stream-json protocol.
_CODEBUDDY_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_STANDALONE,
    "--output-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--input-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--permission-mode": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--mcp-config": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--effort": BlockedArgMode.BLOCKED_WITH_VALUE,
}


def build_codebuddy_args(opts: ExecOptions, logger: Logger) -> List[str]:
    """Assemble the argv (minus the executable) for a `codebuddy -p` run.

    System prompt handling -- why it is not always ``--append-system-prompt``:
    a command line is size-capped (Windows ``CreateProcess``: 32,767 UTF-16
    units for the whole line, failing with ``[WinError 206] The filename or
    extension is too long``; POSIX ``ARG_MAX``, which also counts the
    environment block), so a long preamble passed as one argv value kills the
    run before the CLI starts.

    Short prompts (<= ``ARGV_SYSTEM_PROMPT_LIMIT``) keep the historical inline
    flag. Past that the flag is dropped and the prompt is *folded into the
    stdin user frame* by :func:`build_codebuddy_input` -- the fallback
    described in :mod:`agentrunner._promptfile`. CodeBuddy is a Claude Code
    fork but its CLI is not verified to accept the file-based
    ``--append-system-prompt-file`` flag that :mod:`agentrunner.claude` uses,
    and an unknown flag would be a hard startup error; the stdin frame is part
    of the protocol this backend already drives, so it always works. The cost
    is that the text reaches the model as user content rather than system
    content, which is why it is only used past the threshold.
    """
    args = [
        "-p",
        "--output-format", "stream-json",
        "--input-format", "stream-json",
        "--verbose",
        "--strict-mcp-config",
        "--permission-mode", "bypassPermissions",
        "--disallowedTools", "AskUserQuestion",
    ]
    if opts.model:
        args += ["--model", opts.model]
    if opts.thinking_level:
        args += ["--effort", opts.thinking_level]
    if opts.max_turns > 0:
        args += ["--max-turns", str(opts.max_turns)]
    if opts.system_prompt and system_prompt_fits_argv(opts.system_prompt):
        args += ["--append-system-prompt", opts.system_prompt]
    elif opts.system_prompt:
        logger.info("codebuddy: long system prompt folded into the stdin user "
                    "frame to stay under the OS command-line limit",
                    chars=len(opts.system_prompt))
    if opts.resume_session_id:
        args += ["--resume", opts.resume_session_id]
    args += filter_custom_args(opts.extra_args, _CODEBUDDY_BLOCKED_ARGS, logger)
    args += filter_custom_args(opts.custom_args, _CODEBUDDY_BLOCKED_ARGS, logger)
    return args


def build_codebuddy_input(prompt: str, system_prompt: str = "") -> bytes:
    """Build the single stdin user frame.

    ``system_prompt`` is non-empty only on the argv-overflow fallback path (see
    :func:`build_codebuddy_args`); it is then prepended to the prompt inside
    explicit ``<<<SYSTEM_PROMPT>>>`` delimiters.
    """
    if system_prompt:
        prompt = fold_system_prompt_into_prompt(prompt, system_prompt)
    payload = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
    }
    return (json.dumps(payload) + "\n").encode("utf-8")


def _usage_has_tokens(*vals: int) -> bool:
    return any(v > 0 for v in vals)


def codebuddy_result_usage(msg: dict, fallback_model: str) -> Dict[str, TokenUsage]:
    model_usage = msg.get("modelUsage") or {}
    if model_usage:
        out: Dict[str, TokenUsage] = {}
        for model, u in model_usage.items():
            i = int(u.get("inputTokens", 0)); o = int(u.get("outputTokens", 0))
            cr = int(u.get("cacheReadInputTokens", 0)); cw = int(u.get("cacheCreationInputTokens", 0))
            if not model or not _usage_has_tokens(i, o, cr, cw):
                continue
            out[model] = TokenUsage(i, o, cr, cw)
        if out:
            return out
    model = msg.get("model") or fallback_model
    u = msg.get("usage")
    if not u or not model:
        return {}
    i = int(u.get("input_tokens", 0)); o = int(u.get("output_tokens", 0))
    cr = int(u.get("cache_read_input_tokens", 0)); cw = int(u.get("cache_creation_input_tokens", 0))
    if not _usage_has_tokens(i, o, cr, cw):
        return {}
    return {model: TokenUsage(i, o, cr, cw)}


def resolve_session_id(requested_resume: str, emitted: str, failed: bool) -> str:
    """Clear a fresh session id when a resume was requested but a different
    session id came back on a failed run, so the daemon can fall back."""
    if failed and requested_resume and emitted and emitted != requested_resume:
        return ""
    return emitted


class CodebuddyBackend:
    """Backend implementation for the CodeBuddy CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_path = self.cfg.executable_path or "codebuddy"
        args = build_codebuddy_args(opts, self.cfg.logger)
        # Mirror of build_codebuddy_args' threshold decision: whatever was too
        # long for argv travels in the stdin user frame instead.
        stdin_system_prompt = ("" if system_prompt_fits_argv(opts.system_prompt)
                               else opts.system_prompt)

        mcp_config_path = ""
        if opts.mcp_config:
            mcp_config_path = write_mcp_config_to_temp(opts.mcp_config)
            args += ["--mcp-config", mcp_config_path]

        env = build_env(self.cfg.env)
        runner = StreamingRunner(self.cfg, "codebuddy")
        acc_usage: Dict[str, TokenUsage] = {}

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            try:
                msg = json.loads(line)
            except Exception:
                return
            mtype = msg.get("type")
            if mtype == "assistant":
                self._handle_assistant(msg, st, r, acc_usage)
            elif mtype == "user":
                self._handle_user(msg, r)
            elif mtype == "system":
                if msg.get("session_id"):
                    st.session_id = msg["session_id"]
                r.emit(Message(type=MessageType.STATUS, status="running", session_id=st.session_id))
            elif mtype == "result":
                st.session_id = msg.get("session_id", st.session_id)
                if msg.get("result"):
                    st.output.clear()
                    st.output.append(msg["result"])
                ru = codebuddy_result_usage(msg, opts.model)
                if ru:
                    st.usage = ru
                if msg.get("is_error"):
                    st.final_status = "failed"
                    st.final_error = msg.get("result", "")
                self._close_stdin(r)
            elif mtype == "log":
                log = msg.get("log")
                if log:
                    r.emit(Message(type=MessageType.LOG, level=log.get("level", ""),
                                   content=log.get("message", "")))
            elif mtype == "control_request":
                self._handle_control_request(msg, r, opts, st.session_id)

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            if not st.usage and acc_usage:
                st.usage = dict(acc_usage)
            # Faithful to the Go writeErr branch: if the prompt write failed
            # (StreamingRunner records that in final_error), no result landed
            # (session id still empty) and the run otherwise looks completed,
            # mark it failed so the daemon surfaces the write error.
            if st.final_status == "completed" and st.final_error and not st.session_id:
                st.final_status = "failed"
            st.session_id = resolve_session_id(opts.resume_session_id, st.session_id,
                                               st.final_status == "failed")
            if mcp_config_path:
                cleanup_mcp_config_temp(mcp_config_path)

        return runner.run(
            argv=[exec_path] + args, env=env, cwd=opts.cwd, on_line=on_line,
            opts=opts, cancel=cancel,
            stdin_payload=build_codebuddy_input(prompt, stdin_system_prompt),
            keep_stdin_open=True, on_finish=on_finish,
        )

    # -- handlers --

    def _handle_assistant(self, msg: dict, st: RunState, r: StreamingRunner,
                          acc_usage: Dict[str, TokenUsage]) -> None:
        content = msg.get("message")
        if isinstance(content, (bytes, str)):
            try:
                content = json.loads(content)
            except Exception:
                return
        if not isinstance(content, dict):
            return
        usage = content.get("usage")
        model = content.get("model", "")
        if usage and model:
            u = acc_usage.get(model, TokenUsage())
            u.input_tokens += int(usage.get("input_tokens", 0))
            u.output_tokens += int(usage.get("output_tokens", 0))
            u.cache_read_tokens += int(usage.get("cache_read_input_tokens", 0))
            u.cache_write_tokens += int(usage.get("cache_creation_input_tokens", 0))
            acc_usage[model] = u
        for block in content.get("content", []) or []:
            btype = block.get("type")
            if btype == "text" and block.get("text"):
                st.output.append(block["text"])
                r.emit(Message(type=MessageType.TEXT, content=block["text"]))
            elif btype == "thinking" and block.get("text"):
                r.emit(Message(type=MessageType.THINKING, content=block["text"]))
            elif btype == "tool_use":
                r.emit(Message(type=MessageType.TOOL_USE, tool=block.get("name", ""),
                               call_id=block.get("id", ""), input=block.get("input")))

    def _handle_user(self, msg: dict, r: StreamingRunner) -> None:
        content = msg.get("message")
        if isinstance(content, (bytes, str)):
            try:
                content = json.loads(content)
            except Exception:
                return
        if not isinstance(content, dict):
            return
        for block in content.get("content", []) or []:
            if block.get("type") == "tool_result":
                raw = block.get("content")
                result_str = "" if raw is None else (raw if isinstance(raw, str) else json.dumps(raw))
                r.emit(Message(type=MessageType.TOOL_RESULT,
                               call_id=block.get("tool_use_id", ""), output=result_str))

    def _handle_control_request(self, msg: dict, r: StreamingRunner,
                               opts: ExecOptions, session_id: str) -> None:
        # Auto-approve tool uses in daemon mode, unless a human approval
        # callback is configured and rejects the request.
        req = msg.get("request") or {}
        input_map = req.get("input") or {}
        if not isinstance(input_map, dict):
            input_map = {}
        request_id = msg.get("request_id")
        decision = resolve_approval(opts, "codebuddy", req.get("tool_name", ""),
                                    input_map, session_id, self.cfg.logger)
        if decision is not None and decision.decision != "approved":
            inner = {"behavior": "deny", "message": decision.comment or "Rejected."}
        else:
            inner = {"behavior": "allow", "updatedInput": input_map}
        response = {
            "type": "control_response",
            "response": {"subtype": "success", "request_id": request_id, "response": inner},
        }
        self._write_stdin(r, (json.dumps(response) + "\n").encode("utf-8"))

    @staticmethod
    def _write_stdin(r: StreamingRunner, data: bytes) -> None:
        if r.proc and r.proc.stdin:
            try:
                r.proc.stdin.write(data)
                r.proc.stdin.flush()
            except Exception:
                pass

    @staticmethod
    def _close_stdin(r: StreamingRunner) -> None:
        if r.proc and r.proc.stdin:
            try:
                r.proc.stdin.close()
            except Exception:
                pass
