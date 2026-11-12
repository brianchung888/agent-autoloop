"""OpenClaw backend (port of openclaw.go).

Spawns ``openclaw agent [--local] --json --session-id <id> [--timeout N]
[--agent <model>] <custom_args> --message <prompt>`` and reads its JSON output
from stdout.

OpenClaw 2026.5.x emits a single pretty-printed JSON result blob; the parser
tries a whole-buffer parse first and falls back to a line-by-line NDJSON
scanner for forward compatibility. Because we buffer all stdout lines and parse
them once the process exits, this backend is not truly streaming today -- which
matches the Go implementation's ``io.ReadAll`` behaviour.

Routing (issue #3260): ``openclaw agent`` defaults to Gateway routing; --local
is the embedded-mode opt-in. The daemon forces --local unless
``opts.openclaw_mode == "gateway"``, in which case --local is dropped so
openclaw dials its configured Gateway. --local stays blocked so it cannot be
smuggled back in via custom_args under gateway mode.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env, filter_custom_args,
    popen_platform_kwargs,
)

# Canonical error string surfaced when no usable JSON can be extracted. The
# exact phrase is depended on by external log-grep / dashboard alerts; do not
# change it without also updating those consumers.
OPENCLAW_NO_PARSEABLE_OUTPUT = "openclaw returned no parseable output"

# Lowest openclaw version that emits its --json result on stdout (PR #2101).
MIN_OPENCLAW_VERSION = "2026.5.5"

# Extracts a three-segment dotted version from arbitrary --version output.
_OPENCLAW_VERSION_PATTERN = re.compile(r"(\d+)\.(\d+)\.(\d+)")

# Flags hardcoded by the daemon that user custom_args must not override.
_OPENCLAW_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "--local": BlockedArgMode.BLOCKED_STANDALONE,       # local mode is mode-controlled
    "--json": BlockedArgMode.BLOCKED_STANDALONE,        # JSON output for daemon comms
    "--session-id": BlockedArgMode.BLOCKED_WITH_VALUE,  # managed by daemon
    "--message": BlockedArgMode.BLOCKED_WITH_VALUE,     # prompt set by daemon
    "--model": BlockedArgMode.BLOCKED_WITH_VALUE,       # openclaw agent takes no --model
    "--system-prompt": BlockedArgMode.BLOCKED_WITH_VALUE,  # injected into --message
}


def build_openclaw_args(prompt: str, session_id: str, opts: ExecOptions,
                        logger: Logger) -> List[str]:
    """Assemble the argv for a one-shot `openclaw agent` invocation.

    The CLI accepts --local, --json, --session-id, --timeout, --message (plus
    pass-through flags like --agent / --channel via custom_args). It does NOT
    accept --model or --system-prompt: model is bound at agent registration
    time, and instructions are injected inline into --message.
    """
    args = ["agent"]
    if opts.openclaw_mode != "gateway":
        args.append("--local")
    args += ["--json", "--session-id", session_id]
    if opts.timeout and opts.timeout > 0:
        args += ["--timeout", str(int(opts.timeout))]
    # opts.model here is an openclaw *agent* id (not a real model), passed via
    # --agent. Only inject when the user hasn't already set --agent themselves.
    custom_args = filter_custom_args(opts.custom_args, _OPENCLAW_BLOCKED_ARGS, logger)
    if opts.model and not _custom_args_contains(custom_args, "--agent"):
        args += ["--agent", opts.model]
    args += custom_args

    if opts.system_prompt:
        prompt = opts.system_prompt + "\n\n" + prompt
    args += ["--message", prompt]
    return args


def _custom_args_contains(args: List[str], flag: str) -> bool:
    prefix = flag + "="
    return any(a == flag or a.startswith(prefix) for a in args)


# -- Version gating ----------------------------------------------------


def parse_openclaw_version(raw: str) -> Tuple[str, bool]:
    m = _OPENCLAW_VERSION_PATTERN.search(raw)
    if not m:
        return "", False
    return m.group(0), True


def compare_openclaw_version(a: str, b: str) -> int:
    """Compare two three-segment dotted versions numerically (-1/0/+1)."""
    a_parts = a.split(".")
    b_parts = b.split(".")
    for i in range(3):
        try:
            ai = int(a_parts[i]) if i < len(a_parts) else 0
        except ValueError:
            ai = 0
        try:
            bi = int(b_parts[i]) if i < len(b_parts) else 0
        except ValueError:
            bi = 0
        if ai < bi:
            return -1
        if ai > bi:
            return 1
    return 0


def check_openclaw_version(exec_path: str) -> None:
    """Raise RuntimeError when the installed openclaw is below the minimum."""
    try:
        proc = subprocess.run(
            [exec_path, "--version"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            **popen_platform_kwargs(),
        )
    except Exception as exc:
        raise RuntimeError("openclaw --version failed: %s" % exc)
    if proc.returncode != 0:
        raise RuntimeError("openclaw --version failed: exit status %s"
                           % proc.returncode)
    out = proc.stdout.decode("utf-8", "replace")
    detected, ok = parse_openclaw_version(out)
    if not ok:
        raise RuntimeError(
            "could not parse openclaw version from output: %r" % out.strip())
    if compare_openclaw_version(detected, MIN_OPENCLAW_VERSION) < 0:
        raise RuntimeError(
            "openclaw %s is below the minimum supported version %s. Run "
            "`openclaw update` to upgrade and try again."
            % (detected, MIN_OPENCLAW_VERSION))


class OpenclawBackend:
    """Backend implementation for the OpenClaw CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        import os
        import shutil

        exec_path = self.cfg.executable_path or "openclaw"
        if shutil.which(exec_path) is None and not (
                os.path.isabs(exec_path) and os.path.exists(exec_path)):
            raise FileNotFoundError(
                "openclaw executable not found at %r" % exec_path)

        check_openclaw_version(exec_path)

        session_id = opts.resume_session_id or ("multica-%d" % time.time_ns())
        args = build_openclaw_args(prompt, session_id, opts, self.cfg.logger)

        env = build_env(self.cfg.env)

        runner = StreamingRunner(self.cfg, "openclaw")
        state_extra: Dict[str, Any] = {"lines": []}

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            # OpenClaw's happy path is one pretty-printed JSON blob spanning
            # many lines, so we buffer everything and parse once at finish
            # (mirrors the Go io.ReadAll behaviour).
            state_extra["lines"].append(line)

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            buf = "\n".join(state_extra["lines"])
            parsed = self._process_output(buf, r)

            st.session_id = parsed.get("sessionID") or st.session_id
            st.output = [parsed.get("output", "")]

            u: TokenUsage = parsed.get("usage") or TokenUsage()
            if (u.input_tokens > 0 or u.output_tokens > 0
                    or u.cache_read_tokens > 0 or u.cache_write_tokens > 0):
                model = parsed.get("model") or opts.model or "unknown"
                st.usage = {model: u}

            p_status = parsed.get("status", "completed")
            p_err = parsed.get("errMsg", "")
            # StreamingRunner has already decided timeout/aborted/exit-error.
            # Timeout/aborted take precedence over the parse result (but the
            # parsed output/session/usage above are still used, matching Go).
            if st.final_status in ("timeout", "aborted"):
                return
            # Otherwise st.final_status is "completed" (clean exit) or "failed"
            # (non-zero exit set by the runner). Non-zero exit only overrides a
            # parse that itself reports "completed"; a parse-detected failure
            # keeps its own message.
            exited_error = st.final_status == "failed"
            if p_status == "completed" and exited_error:
                # keep the runner's "openclaw exited with error" message
                st.final_status = "failed"
            else:
                st.final_status = p_status
                st.final_error = p_err

        return runner.run(
            argv=[exec_path] + args, env=env, cwd=opts.cwd, on_line=on_line,
            opts=opts, cancel=cancel, on_finish=on_finish,
        )

    # -- output parsing --

    def _process_output(self, buf: str, r: StreamingRunner) -> Dict[str, Any]:
        """Parse openclaw stdout: whole-buffer fast path, then NDJSON scanner."""
        # Whole-buffer fast path: single pretty-printed JSON result blob.
        result, ok = parse_whole_buffer_openclaw_result(buf)
        if ok:
            output: List[str] = []
            return self._build_event_result(result, r, output)

        # Fall-back NDJSON line scanner.
        output = []
        session_id = ""
        model = ""
        usage = TokenUsage()
        final_status = "completed"
        final_error = ""
        got_events = False
        raw_lines: List[str] = []

        for line in buf.split("\n"):
            line = line.strip()
            if not line:
                continue

            event, ev_ok = try_parse_openclaw_event(line)
            if ev_ok:
                got_events = True
                if event.get("sessionId"):
                    session_id = event["sessionId"]
                etype = event.get("type")
                if etype == "text":
                    text = event.get("text", "")
                    if text:
                        output.append(text)
                        r.emit(Message(type=MessageType.TEXT, content=text))
                elif etype == "tool_use":
                    input_map = event.get("input")
                    if not isinstance(input_map, dict):
                        input_map = None
                    r.emit(Message(type=MessageType.TOOL_USE,
                                   tool=event.get("tool", ""),
                                   call_id=event.get("callId", ""),
                                   input=input_map))
                elif etype == "tool_result":
                    r.emit(Message(type=MessageType.TOOL_RESULT,
                                   tool=event.get("tool", ""),
                                   call_id=event.get("callId", ""),
                                   output=event.get("text", "")))
                elif etype == "error":
                    err_msg = openclaw_event_error_message(event)
                    self.cfg.logger.warn("openclaw error event", error=err_msg)
                    r.emit(Message(type=MessageType.ERROR, content=err_msg))
                    final_status = "failed"
                    final_error = err_msg
                elif etype == "lifecycle":
                    phase = event.get("phase")
                    if phase in ("error", "failed", "cancelled"):
                        err_msg = openclaw_event_error_message(event)
                        self.cfg.logger.warn("openclaw lifecycle failure",
                                             phase=phase, error=err_msg)
                        r.emit(Message(type=MessageType.ERROR, content=err_msg))
                        final_status = "failed"
                        final_error = err_msg
                elif etype == "step_start":
                    r.emit(Message(type=MessageType.STATUS, status="running"))
                elif etype == "step_finish":
                    if isinstance(event.get("usage"), dict):
                        u = parse_openclaw_usage(event["usage"])
                        usage.input_tokens += u.input_tokens
                        usage.output_tokens += u.output_tokens
                        usage.cache_read_tokens += u.cache_read_tokens
                        usage.cache_write_tokens += u.cache_write_tokens
                continue

            result, res_ok = try_parse_openclaw_result(line)
            if res_ok:
                got_events = True
                res = self._build_event_result(result, r, output)
                if res.get("sessionID"):
                    session_id = res["sessionID"]
                if res.get("model"):
                    model = res["model"]
                ru: TokenUsage = res.get("usage") or TokenUsage()
                if (ru.input_tokens > 0 or ru.output_tokens > 0
                        or ru.cache_read_tokens > 0 or ru.cache_write_tokens > 0):
                    usage = ru
                continue

            # Not JSON -- treat as a log line.
            self.cfg.logger.debug("[openclaw:stdout] " + line)
            raw_lines.append(line)

        if not got_events:
            trimmed = "\n".join(raw_lines).strip()
            if trimmed:
                return {"status": "completed", "output": trimmed}
            return {"status": "failed", "errMsg": OPENCLAW_NO_PARSEABLE_OUTPUT}

        return {
            "status": final_status,
            "errMsg": final_error,
            "output": "".join(output),
            "sessionID": session_id,
            "usage": usage,
            "model": model,
        }

    def _build_event_result(self, result: dict, r: StreamingRunner,
                            output: List[str]) -> Dict[str, Any]:
        """Extract text + metadata from a final result blob."""
        for p in result.get("payloads") or []:
            text = p.get("text", "") if isinstance(p, dict) else ""
            if text:
                output.append(text)
                r.emit(Message(type=MessageType.TEXT, content=text))

        session_id = ""
        model = ""
        usage = TokenUsage()
        meta = result.get("meta") or {}
        agent_meta = meta.get("agentMeta")
        if isinstance(agent_meta, dict):
            sid = agent_meta.get("sessionId")
            if isinstance(sid, str):
                session_id = sid
            m = agent_meta.get("model")
            if isinstance(m, str):
                model = m.strip()
            u = agent_meta.get("usage")
            if isinstance(u, dict):
                usage = parse_openclaw_usage(u)

        return {
            "status": "completed",
            "output": "".join(output),
            "sessionID": session_id,
            "usage": usage,
            "model": model,
        }


# -- JSON parsing helpers ----------------------------------------------


def parse_whole_buffer_openclaw_result(buf: str) -> Tuple[dict, bool]:
    """Try to parse the entire buffer as one openclaw final-result blob,
    stripping any leading non-JSON log lines."""
    trimmed = buf.strip()
    if trimmed == "":
        return {}, False
    result, ok = try_parse_openclaw_result(trimmed)
    if ok:
        return result, True
    lines = trimmed.split("\n")
    for i, line in enumerate(lines):
        if len(line) > 0 and line[0] == "{":
            candidate = "\n".join(lines[i:]).strip()
            result, ok = try_parse_openclaw_result(candidate)
            if ok:
                return result, True
            return {}, False
    return {}, False


def try_parse_openclaw_event(line: str) -> Tuple[dict, bool]:
    """Parse a line as a streaming NDJSON event (must have a non-empty type)."""
    if len(line) == 0 or line[0] != "{":
        return {}, False
    try:
        event = json.loads(line)
    except Exception:
        return {}, False
    if not isinstance(event, dict) or not event.get("type"):
        return {}, False
    return event, True


def try_parse_openclaw_result(raw: str) -> Tuple[dict, bool]:
    """Parse a line/buffer as a final result blob (payloads + meta)."""
    if len(raw) == 0 or raw[0] != "{":
        return {}, False
    try:
        result = json.loads(raw)
    except Exception:
        return {}, False
    if not isinstance(result, dict):
        return {}, False
    payloads = result.get("payloads")
    meta = result.get("meta") or {}
    duration_ms = meta.get("durationMs", 0) if isinstance(meta, dict) else 0
    if payloads is None and not duration_ms:
        return {}, False
    return result, True


def openclaw_event_error_message(event: dict) -> str:
    """Human-readable error message from an event's error/text/message fields."""
    err = event.get("error")
    if isinstance(err, dict):
        msg = openclaw_error_message(err)
        if msg:
            return msg
    if event.get("text"):
        return event["text"]
    if event.get("message"):
        return event["message"]
    return "unknown openclaw error"


def openclaw_error_message(err: dict) -> str:
    data = err.get("data")
    if isinstance(data, dict) and data.get("message"):
        return data["message"]
    if err.get("message"):
        return err["message"]
    if err.get("name"):
        return err["name"]
    return ""


def parse_openclaw_usage(data: Dict[str, Any]) -> TokenUsage:
    """Extract token usage supporting the field-name variants across versions."""
    return TokenUsage(
        input_tokens=_int64_first_of(data, "input", "inputTokens", "input_tokens"),
        output_tokens=_int64_first_of(data, "output", "outputTokens", "output_tokens"),
        cache_read_tokens=_int64_first_of(
            data, "cacheRead", "cachedInputTokens", "cached_input_tokens",
            "cache_read", "cache_read_input_tokens"),
        cache_write_tokens=_int64_first_of(
            data, "cacheWrite", "cacheCreationInputTokens",
            "cache_creation_input_tokens", "cache_write"),
    )


def _int64_first_of(data: Dict[str, Any], *keys: str) -> int:
    for key in keys:
        v = _int64(data, key)
        if v != 0:
            return v
    return 0


def _int64(data: Dict[str, Any], key: str) -> int:
    if key not in data:
        return 0
    v = data[key]
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    return 0
