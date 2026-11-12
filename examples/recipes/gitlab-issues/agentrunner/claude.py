"""Claude Code backend (port of claude.go).

Spawns the `claude` CLI with `--output-format stream-json --input-format
stream-json`, writes the prompt as a single user frame on stdin, keeps stdin
open to answer `control_request` events, and parses the stream-json events into
the unified Message/Result types.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any, Dict, List, Optional

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env, filter_custom_args,
    resolve_approval,
)
from ._mcp import cleanup_mcp_config_temp, write_mcp_config_to_temp
from ._promptfile import (
    cleanup_system_prompt_temp, system_prompt_fits_argv, write_system_prompt_to_temp,
)

# Flags hardcoded by the daemon that user custom_args must not override.
_CLAUDE_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_STANDALONE,
    "--output-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--input-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--permission-mode": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--mcp-config": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--effort": BlockedArgMode.BLOCKED_WITH_VALUE,
}


def build_claude_args(opts: ExecOptions, logger: Logger,
                      temp_files: Optional[List[str]] = None) -> List[str]:
    """Assemble the argv (minus the executable) for a `claude -p` run.

    System prompt handling -- why it is not simply ``--append-system-prompt``:
    a process command line is size-capped (Windows ``CreateProcess``: 32,767
    UTF-16 units for the *entire* line, failing with ``[WinError 206] The
    filename or extension is too long``; POSIX: ``ARG_MAX``, which also counts
    the environment block). A long persona/instruction preamble passed as one
    argv value therefore killed the run before the CLI started.

    So:

    * ``len(system_prompt) <= ARGV_SYSTEM_PROMPT_LIMIT`` (8192) -- unchanged
      historical behaviour: inline ``--append-system-prompt <prompt>``. Short
      prompts can never overflow, and the frozen contract argv stays identical.
    * longer -- the prompt is written to a per-run temp file and passed as
      ``--append-system-prompt-file <path>``, so argv only carries a path. The
      flag is accepted by the ``claude`` CLI (documented under ``--bare``;
      the CLI validates the path and reports "Append system prompt file not
      found" for a bad one). Each created path is appended to ``temp_files``
      so the caller can delete it after the child exits -- ``execute()`` does
      that in its ``on_finish`` hook. Pass ``temp_files=None`` only if you
      take care of the cleanup yourself (the path is in the returned argv).
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
    if opts.system_prompt:
        if system_prompt_fits_argv(opts.system_prompt):
            args += ["--append-system-prompt", opts.system_prompt]
        else:
            path = write_system_prompt_to_temp(opts.system_prompt)
            if temp_files is not None:
                temp_files.append(path)
            logger.info("claude: long system prompt passed via file to stay "
                        "under the OS command-line limit",
                        chars=len(opts.system_prompt), path=path)
            args += ["--append-system-prompt-file", path]
    if opts.resume_session_id:
        args += ["--resume", opts.resume_session_id]
    args += filter_custom_args(opts.extra_args, _CLAUDE_BLOCKED_ARGS, logger)
    args += filter_custom_args(opts.custom_args, _CLAUDE_BLOCKED_ARGS, logger)
    return args


def build_claude_input(prompt: str) -> bytes:
    payload = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
    }
    return (json.dumps(payload) + "\n").encode("utf-8")


def _usage_has_tokens(*vals: int) -> bool:
    return any(v > 0 for v in vals)


def claude_result_usage(msg: dict, fallback_model: str) -> Dict[str, TokenUsage]:
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
    if failed and requested_resume and emitted and emitted != requested_resume:
        return ""
    return emitted


def _args_request_bypass(args: List[str]) -> bool:
    for i, a in enumerate(args):
        if a == "--dangerously-skip-permissions":
            return True
        if a == "--permission-mode" and i + 1 < len(args) and args[i + 1] == "bypassPermissions":
            return True
    return False


def _env_has_sandbox(env: Dict[str, str]) -> bool:
    v = env.get("IS_SANDBOX")
    return isinstance(v, str) and v.lower() in ("1", "true", "yes", "on")


def claude_root_sudo_preflight(args: List[str], env: Dict[str, str]) -> None:
    if not _args_request_bypass(args):
        return
    if os.name == "nt":
        return
    if hasattr(os, "geteuid") and os.geteuid() == 0 and not _env_has_sandbox(env):
        raise RuntimeError(
            "Claude Code refuses bypassPermissions under root/sudo privileges. "
            "Run as a non-root user, or set IS_SANDBOX=1 in a genuine container/sandbox")


class ClaudeBackend:
    """Backend implementation for the Claude Code CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_path = self.cfg.executable_path or "claude"
        # Temp files created for argv-overflow-safe flag values (long system
        # prompt); removed in on_finish once the child has exited.
        temp_files: List[str] = []
        args = build_claude_args(opts, self.cfg.logger, temp_files)

        mcp_config_path = ""
        if opts.mcp_config:
            mcp_config_path = write_mcp_config_to_temp(opts.mcp_config)
            args += ["--mcp-config", mcp_config_path]

        env = build_env(self.cfg.env)
        try:
            claude_root_sudo_preflight(args, env)
        except Exception:
            for path in temp_files:
                cleanup_system_prompt_temp(path)
            raise

        runner = StreamingRunner(self.cfg, "claude")
        state_extra = {"saw_async_launch": False, "acc_usage": {}}

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            try:
                msg = json.loads(line)
            except Exception:
                return
            mtype = msg.get("type")
            if mtype == "assistant":
                self._handle_assistant(msg, st, r, state_extra)
            elif mtype == "user":
                if self._handle_user(msg, r):
                    state_extra["saw_async_launch"] = True
            elif mtype == "system":
                if msg.get("session_id"):
                    st.session_id = msg["session_id"]
                r.emit(Message(type=MessageType.STATUS, status="running", session_id=st.session_id))
            elif mtype == "result":
                st.session_id = msg.get("session_id", st.session_id)
                if msg.get("result"):
                    st.output.clear()
                    st.output.append(msg["result"])
                ru = claude_result_usage(msg, opts.model)
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
            if not st.usage and state_extra["acc_usage"]:
                st.usage = dict(state_extra["acc_usage"])
            if st.final_status == "completed" and state_extra["saw_async_launch"]:
                st.final_status = "failed"
                st.final_error = ("claude launched an async background task; "
                                  "Multica-managed runs require foreground execution")
            st.session_id = resolve_session_id(opts.resume_session_id, st.session_id,
                                               st.final_status == "failed")
            if mcp_config_path:
                cleanup_mcp_config_temp(mcp_config_path)
            for path in temp_files:
                cleanup_system_prompt_temp(path)
            temp_files.clear()

        try:
            return runner.run(
                argv=[exec_path] + args, env=env, cwd=opts.cwd, on_line=on_line,
                opts=opts, cancel=cancel, stdin_payload=build_claude_input(prompt),
                keep_stdin_open=True, on_finish=on_finish,
            )
        except Exception:
            # The child never started, so on_finish will not run.
            for path in temp_files:
                cleanup_system_prompt_temp(path)
            raise

    # -- handlers --

    def _handle_assistant(self, msg: dict, st: RunState, r: StreamingRunner,
                          extra: dict) -> None:
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
            acc = extra["acc_usage"]
            u = acc.get(model, TokenUsage())
            u.input_tokens += int(usage.get("input_tokens", 0))
            u.output_tokens += int(usage.get("output_tokens", 0))
            u.cache_read_tokens += int(usage.get("cache_read_input_tokens", 0))
            u.cache_write_tokens += int(usage.get("cache_creation_input_tokens", 0))
            acc[model] = u
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

    def _handle_user(self, msg: dict, r: StreamingRunner) -> bool:
        content = msg.get("message")
        if isinstance(content, (bytes, str)):
            try:
                content = json.loads(content)
            except Exception:
                return False
        if not isinstance(content, dict):
            return False
        saw_async = False
        for block in content.get("content", []) or []:
            if block.get("type") == "tool_result":
                raw = block.get("content")
                result_str = json.dumps(raw) if not isinstance(raw, str) else raw
                if _tool_result_has_async_launch(raw):
                    saw_async = True
                r.emit(Message(type=MessageType.TOOL_RESULT,
                               call_id=block.get("tool_use_id", ""), output=result_str))
        return saw_async

    def _handle_control_request(self, msg: dict, r: StreamingRunner,
                               opts: ExecOptions, session_id: str) -> None:
        req = msg.get("request") or {}
        input_map = req.get("input") or {}
        if not isinstance(input_map, dict):
            input_map = {}
        if input_map.get("run_in_background") is True:
            input_map["run_in_background"] = False
            self.cfg.logger.info("claude: forced foreground tool execution",
                                 request_id=msg.get("request_id"), tool=req.get("tool_name"))
        request_id = msg.get("request_id")
        # Human-in-the-loop: honor a rejection if a callback is configured;
        # otherwise fall through to the historical auto-allow behavior.
        decision = resolve_approval(opts, "claude", req.get("tool_name", ""),
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


def _tool_result_has_async_launch(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("status") == "async_launched":
            return True
        content = value.get("content")
        if isinstance(content, list):
            return any(isinstance(i, dict) and i.get("status") == "async_launched" for i in content)
    elif isinstance(value, list):
        return any(isinstance(i, dict) and i.get("status") == "async_launched" for i in value)
    return False
