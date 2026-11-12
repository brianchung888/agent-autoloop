"""Shared ACP (Agent Client Protocol) client and session driver.

Python port of the ACP transport that lives in ``hermes.go`` and is reused,
almost verbatim, by ``kimi.go``, ``kiro.go``, ``qoder.go`` and ``traecli.go``.
All five agents speak JSON-RPC 2.0 over the child process' stdin/stdout:

  * ``initialize``           -- capability handshake
  * ``session/new``          -- create a fresh session
  * ``session/resume`` /
    ``session/load``         -- resume a prior session (method varies per agent)
  * ``session/set_model``    -- optional model switch
  * ``session/prompt``       -- send the user turn, wait for the stop reason
  * ``session/update`` (notification) -- streaming agent output, thoughts,
    tool calls, usage snapshots
  * ``session/request_permission`` (agent -> client request) -- auto-approved
    with ``approve_for_session`` so the headless daemon never blocks

The Go original used goroutines + channels + a ``context`` deadline. Here the
same shape is expressed with threads: a reader thread pumps stdout lines into
:class:`ACPClient`, a stderr thread forwards + sniffs provider errors, and a
watchdog thread honours ``opts.timeout`` and the ``cancel`` :class:`threading.Event`
by killing the process group. The lifecycle driver runs on its own thread and
publishes the final :class:`Result` on a :class:`Session`.

Each agent module builds an :class:`ACPSpec` describing only what differs
(launch command, resume method, tool-name normaliser, ...) and calls
:func:`run_acp`.
"""

from __future__ import annotations

import json
import queue
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Message, MessageType, Result, Session,
    StderrTail, TokenUsage, build_env, filter_custom_args, popen_platform_kwargs,
    resolve_approval, signal_process_group, with_agent_stderr,
)

# -- JSON-RPC error frame ----------------------------------------------


class ACPRPCError(Exception):
    """A JSON-RPC error frame returned by the agent process (port of
    ``acpRPCError``). Renders like the flat string the Go code built with
    ``fmt.Errorf`` but keeps ``code``/``message``/``data`` structured so
    callers can branch on the error class (see :func:`is_acp_session_not_found`).
    """

    def __init__(self, method: str, code: int, message: str, data: str = "") -> None:
        super().__init__()
        self.method = method
        self.code = code
        self.message = message
        self.data = data

    def __str__(self) -> str:
        if self.data:
            return "%s: %s (code=%d, data=%s)" % (self.method, self.message, self.code, self.data)
        return "%s: %s (code=%d)" % (self.method, self.message, self.code)


class _ContextError(Exception):
    """Signals that a request was abandoned because the run deadline elapsed
    (``reason="timeout"``) or the ``cancel`` event fired (``reason="aborted"``).
    Mirrors Go's ``ctx.Err()`` propagation out of ``hermesClient.request``."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def is_acp_session_not_found(err: Optional[Exception]) -> bool:
    """Reports whether ``err`` is the agent rejecting a session id it no longer
    knows. Runtimes signal this with codes/wording that vary (Hermes: -32603
    "Session not found"; Kiro: -32603 with "No session found with id" in data;
    kimi-cli: -32602 invalid_params) so neither code nor text alone is
    discriminating and both are matched (port of ``isACPSessionNotFound``)."""
    if not isinstance(err, ACPRPCError):
        return False
    if err.code not in (-32603, -32602):
        return False
    text = (err.message + " " + err.data).lower()
    return "session not found" in text or "no session found" in text


# -- ACP client (JSON-RPC 2.0 transport) -------------------------------


class _Ctx:
    """Cancellation/deadline context shared by the driver and watchdog."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.reason = ""  # "timeout" | "aborted"

    def cancel(self, reason: str) -> None:
        if not self.done.is_set():
            self.reason = reason
            self.done.set()


class _Pending:
    def __init__(self, method: str) -> None:
        self.method = method
        self.event = threading.Event()
        self.result: Any = None
        self.error: Optional[Exception] = None


@dataclass
class _PendingToolCall:
    """Buffers a tool call while its arguments stream in (port of
    ``pendingToolCall``). One entry per ACP toolCallId."""

    tool_name: str = ""
    input: Optional[Dict[str, Any]] = None
    args_text: str = ""
    emitted: bool = False


@dataclass
class ACPPromptResult:
    """Result of a ``session/prompt`` turn (port of ``hermesPromptResult``)."""

    stop_reason: str = ""
    usage: TokenUsage = field(default_factory=TokenUsage)


def _acp_tool_name(params: Any) -> str:
    """Best-effort tool name from a session/request_permission params blob."""
    if isinstance(params, dict):
        tc = params.get("toolCall") or params.get("tool_call")
        if isinstance(tc, dict):
            for k in ("title", "name", "kind", "toolName"):
                v = tc.get(k)
                if isinstance(v, str) and v.strip():
                    return v.strip()
        for k in ("title", "toolName"):
            v = params.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    return "tool"


def _acp_reject_option_id(params: Any) -> str:
    """Pick a reject-kind optionId from the permission request options, if any."""
    if isinstance(params, dict):
        options = params.get("options")
        if isinstance(options, list):
            for opt in options:
                if not isinstance(opt, dict):
                    continue
                kind = str(opt.get("kind", "")).lower()
                oid = opt.get("optionId") or opt.get("id")
                if isinstance(oid, str) and kind.startswith("reject"):
                    return oid
            # Fallback: an optionId that merely looks like a rejection.
            for opt in options:
                if not isinstance(opt, dict):
                    continue
                oid = opt.get("optionId") or opt.get("id")
                if isinstance(oid, str) and "reject" in oid.lower():
                    return oid
    return ""


class ACPClient:
    """ACP JSON-RPC 2.0 transport over a child process' stdin/stdout
    (port of ``hermesClient``). Reused by every ACP backend."""

    def __init__(self, cfg: Config, proc: subprocess.Popen,
                 on_message: Callable[[Message], None],
                 on_prompt_done: Callable[[ACPPromptResult], None],
                 accept_notification: Optional[Callable[[str], bool]] = None,
                 opts: Optional[ExecOptions] = None, provider: str = "acp") -> None:
        self.cfg = cfg
        self.proc = proc
        self.opts = opts if opts is not None else ExecOptions()
        self.provider = provider
        self.on_message = on_message
        self.on_prompt_done = on_prompt_done
        # Drops ACP session updates (before they mutate usage / pending tool
        # state) when the current turn is not yet streaming. None => accept all.
        self.accept_notification = accept_notification

        self.session_id = ""

        self._write_lock = threading.Lock()
        self._lock = threading.Lock()
        self._next_id = 0
        self._pending: Dict[int, _Pending] = {}

        self._tool_lock = threading.Lock()
        self._pending_tools: Dict[str, _PendingToolCall] = {}

        self.usage_lock = threading.Lock()
        self.usage = TokenUsage()

    # -- transport --

    def write_line(self, data: bytes) -> None:
        with self._write_lock:
            assert self.proc.stdin is not None
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def request(self, ctx: _Ctx, method: str, params: Any) -> Tuple[Any, Optional[Exception]]:
        """Send a JSON-RPC request and block until the response arrives or the
        context is cancelled. Returns ``(result, err)`` (err is None on success)."""
        with self._lock:
            rid = self._next_id
            self._next_id += 1
            pr = _Pending(method)
            self._pending[rid] = pr

        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params}
        try:
            data = (json.dumps(msg) + "\n").encode("utf-8")
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._pending.pop(rid, None)
            return None, exc

        try:
            self.write_line(data)
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._pending.pop(rid, None)
            return None, Exception("write %s: %s" % (method, exc))

        while True:
            got = pr.event.wait(0.05)
            # Prioritise cancellation/deadline over a response that may have
            # been unblocked by close_all_pending when the killed process' pipe
            # closed -- otherwise a cancelled run reports "process exited"
            # instead of "aborted"/"timeout".
            if ctx.done.is_set():
                with self._lock:
                    self._pending.pop(rid, None)
                return None, _ContextError(ctx.reason)
            if got:
                return pr.result, pr.error

    def close_all_pending(self, err: Exception) -> None:
        with self._lock:
            pending = list(self._pending.items())
            self._pending.clear()
        for _, pr in pending:
            pr.error = err
            pr.event.set()

    # -- inbound line dispatch --

    def handle_line(self, line: str) -> None:
        try:
            raw = json.loads(line)
        except Exception:
            return
        if not isinstance(raw, dict):
            return

        if "id" in raw:
            if "result" in raw:
                self._handle_response(raw)
                return
            if "error" in raw:
                self._handle_response(raw)
                return
            if "method" in raw:
                self._handle_agent_request(raw)
                return

        if "method" in raw:
            self._handle_notification(raw)

    def _handle_agent_request(self, raw: dict) -> None:
        """Reply to agent -> client requests. The only one we act on today is
        ``session/request_permission``: the daemon is headless and cannot prompt
        a user, so we auto-approve every action with ``approve_for_session`` so
        subsequent identical actions don't round-trip through us (port of
        ``handleAgentRequest``)."""
        method = raw.get("method", "")
        if "id" not in raw:
            return
        rid = raw["id"]

        if method == "session/request_permission":
            params = raw.get("params") or {}
            decision = resolve_approval(self.opts, self.provider,
                                        _acp_tool_name(params), params,
                                        self.session_id, self.cfg.logger)
            if decision is not None and decision.decision != "approved":
                reject_id = _acp_reject_option_id(params)
                outcome = ({"outcome": "selected", "optionId": reject_id}
                           if reject_id else {"outcome": "cancelled"})
                resp = {"jsonrpc": "2.0", "id": rid, "result": {"outcome": outcome}}
                self.cfg.logger.info("acp: permission rejected by callback", method=method)
            else:
                resp = {
                    "jsonrpc": "2.0",
                    "id": rid,
                    "result": {"outcome": {"outcome": "selected", "optionId": "approve_for_session"}},
                }
                self.cfg.logger.debug("auto-approved agent permission request", method=method)
        else:
            resp = {
                "jsonrpc": "2.0",
                "id": rid,
                "error": {"code": -32601, "message": "method not found: " + method},
            }
            self.cfg.logger.debug("unhandled agent->client request", method=method)

        try:
            self.write_line((json.dumps(resp) + "\n").encode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            self.cfg.logger.warn("write agent-request response", method=method, error=str(exc))

    def _handle_response(self, raw: dict) -> None:
        try:
            rid = int(raw["id"])
        except (TypeError, ValueError):
            return
        with self._lock:
            pr = self._pending.pop(rid, None)
        if pr is None:
            return

        if "error" in raw and raw["error"] is not None:
            err_obj = raw["error"] or {}
            code = int(err_obj.get("code", 0))
            message = err_obj.get("message", "")
            data = err_obj.get("data")
            detail = ""
            if data is not None:
                detail = data if isinstance(data, str) else json.dumps(data)
            pr.error = ACPRPCError(pr.method, code, message, detail)
            pr.event.set()
            return

        result = raw.get("result")
        if pr.method == "session/prompt":
            self._extract_prompt_result(result)
        pr.result = result
        pr.event.set()

    def _extract_prompt_result(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        pr = ACPPromptResult(stop_reason=data.get("stopReason", "") or "")
        usage = data.get("usage")
        if usage is not None and usage != {}:
            pr.usage = parse_acp_token_usage(usage)
        if self.on_prompt_done is not None:
            self.on_prompt_done(pr)

    def _handle_notification(self, raw: dict) -> None:
        method = raw.get("method", "")
        if method not in ("session/update", "session/notification"):
            return
        params = raw.get("params") or {}
        if not isinstance(params, dict):
            return
        update = params.get("update")
        if not update:
            return

        update_type, update_data = normalize_acp_update(update)
        if self.accept_notification is not None and not self.accept_notification(update_type):
            return

        if update_type == "agent_message_chunk":
            self._handle_agent_message(update_data)
        elif update_type == "agent_thought_chunk":
            self._handle_agent_thought(update_data)
        elif update_type == "tool_call":
            self._handle_tool_call_start(update_data)
        elif update_type == "tool_call_update":
            self._handle_tool_call_update(update_data)
        elif update_type == "usage_update":
            self._handle_usage_update(update_data)
        elif update_type == "turn_end":
            self._extract_prompt_result(update_data)

    def _handle_agent_message(self, data: Any) -> None:
        text = _content_text(data)
        if text and self.on_message is not None:
            self.on_message(Message(type=MessageType.TEXT, content=text))

    def _handle_agent_thought(self, data: Any) -> None:
        text = _content_text(data)
        if text and self.on_message is not None:
            self.on_message(Message(type=MessageType.THINKING, content=text))

    def _handle_tool_call_start(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        call_id = data.get("toolCallId", "") or ""
        title = data.get("title", "") or ""
        kind = data.get("kind", "") or ""
        raw_input = data.get("rawInput")
        if raw_input is None:
            raw_input = data.get("input")
        if raw_input is None:
            raw_input = data.get("parameters")

        tool_name = hermes_tool_name_from_title(title, kind)
        if not tool_name:
            tool_name = data.get("name", "") or ""

        if raw_input is not None:
            self._track_tool(call_id, _PendingToolCall(tool_name=tool_name, input=raw_input, emitted=True))
            if self.on_message is not None:
                self.on_message(Message(type=MessageType.TOOL_USE, tool=tool_name,
                                        call_id=call_id, input=raw_input))
            return

        # Kimi streams args token-by-token across tool_call_update frames; defer
        # emission so the UI never sees a half-written command like `{"comma`.
        self._track_tool(call_id, _PendingToolCall(
            tool_name=tool_name,
            args_text=extract_acp_tool_call_text(data.get("content")),
            emitted=False,
        ))

    def _handle_tool_call_update(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        call_id = data.get("toolCallId", "") or ""
        status = data.get("status", "") or ""
        raw_input = data.get("rawInput")
        if raw_input is None:
            raw_input = data.get("input")
        if raw_input is None:
            raw_input = data.get("parameters")
        title = data.get("title", "") or ""
        if not title:
            title = data.get("name", "") or ""
        kind = data.get("kind", "") or ""

        if status not in ("completed", "failed"):
            pending = self._get_pending_tool(call_id)
            if pending is not None and not pending.emitted:
                text = extract_acp_tool_call_text(data.get("content"))
                if text:
                    pending.args_text = text
            return

        pending = self._take_pending_tool(call_id)
        self._emit_deferred_tool_use(pending, call_id, title, kind, raw_input)

        output = data.get("rawOutput") or ""
        if not output:
            output = data.get("output") or ""
        if not output:
            output = extract_acp_tool_call_text(data.get("content"))
        if self.on_message is not None:
            self.on_message(Message(type=MessageType.TOOL_RESULT, call_id=call_id,
                                    output=output, status=status))

    def _track_tool(self, call_id: str, p: _PendingToolCall) -> None:
        with self._tool_lock:
            self._pending_tools[call_id] = p

    def _get_pending_tool(self, call_id: str) -> Optional[_PendingToolCall]:
        with self._tool_lock:
            return self._pending_tools.get(call_id)

    def _take_pending_tool(self, call_id: str) -> Optional[_PendingToolCall]:
        with self._tool_lock:
            return self._pending_tools.pop(call_id, None)

    def _emit_deferred_tool_use(self, p: Optional[_PendingToolCall], call_id: str,
                                update_title: str, update_kind: str,
                                update_raw_input: Optional[Dict[str, Any]]) -> None:
        if p is not None and p.emitted:
            return
        if p is not None and p.input is not None:
            tool_name = p.tool_name
            input_map: Optional[Dict[str, Any]] = p.input
        elif p is not None:
            tool_name = p.tool_name
            input_map = parse_tool_args_json(p.args_text)
        else:
            tool_name = hermes_tool_name_from_title(update_title, update_kind)
            input_map = update_raw_input
        if self.on_message is None:
            return
        self.on_message(Message(type=MessageType.TOOL_USE, tool=tool_name,
                                call_id=call_id, input=input_map))

    def _handle_usage_update(self, data: Any) -> None:
        if not isinstance(data, dict):
            return
        usage = parse_acp_token_usage(data.get("usage"))
        with self.usage_lock:
            # ACP usage updates are cumulative snapshots, so take the latest.
            if usage.input_tokens > self.usage.input_tokens:
                self.usage.input_tokens = usage.input_tokens
            if usage.output_tokens > self.usage.output_tokens:
                self.usage.output_tokens = usage.output_tokens
            if usage.cache_read_tokens > self.usage.cache_read_tokens:
                self.usage.cache_read_tokens = usage.cache_read_tokens
            if usage.cache_write_tokens > self.usage.cache_write_tokens:
                self.usage.cache_write_tokens = usage.cache_write_tokens


def _content_text(data: Any) -> str:
    if not isinstance(data, dict):
        return ""
    content = data.get("content")
    if isinstance(content, dict):
        return content.get("text", "") or ""
    return ""


# -- ACP update normalisation ------------------------------------------


def normalize_acp_update(data: Any) -> Tuple[str, Any]:
    """Return ``(normalised_type, update_data)`` from a session update, coping
    with the three shapes ACP implementations use: ``sessionUpdate`` tag,
    ``type`` tag, or a single-key externally-tagged wrapper (port of
    ``normalizeACPUpdate``)."""
    if not isinstance(data, dict):
        return "", data
    su = data.get("sessionUpdate")
    if isinstance(su, str) and su != "":
        return normalize_acp_update_type(su), data
    t = data.get("type")
    if isinstance(t, str) and t != "":
        return normalize_acp_update_type(t), data
    if len(data) == 1:
        for k, v in data.items():
            return normalize_acp_update_type(k), v
    return "", data


def normalize_acp_update_type(t: str) -> str:
    key = t.strip().replace("_", "").replace("-", "").lower()
    return {
        "agentmessagechunk": "agent_message_chunk",
        "agentthoughtchunk": "agent_thought_chunk",
        "toolcall": "tool_call",
        "toolcallupdate": "tool_call_update",
        "usageupdate": "usage_update",
        "turnend": "turn_end",
        "endturn": "turn_end",
    }.get(key, "")


def parse_tool_args_json(args_text: str) -> Optional[Dict[str, Any]]:
    """Turn kimi's accumulated args string into a structured map. On malformed
    input the raw text is preserved under a ``text`` key (port of
    ``parseToolArgsJSON``)."""
    args_text = (args_text or "").strip()
    if not args_text:
        return None
    try:
        m = json.loads(args_text)
        if isinstance(m, dict):
            return m
    except Exception:
        pass
    return {"text": args_text}


def extract_acp_tool_call_text(blocks: Any) -> str:
    """Concatenate the rendered text of ACP ``content`` blocks. Handles
    ``content`` (plain text) and ``diff`` (rendered as a minimal unified-diff
    header) blocks; terminal/image/unknown blocks are skipped (port of
    ``extractACPToolCallText``)."""
    if not isinstance(blocks, list):
        return ""
    pieces: List[str] = []

    def append_piece(piece: str) -> None:
        if piece:
            pieces.append(piece)

    for raw in blocks:
        if not isinstance(raw, dict):
            continue
        kind = raw.get("type")
        if kind == "content":
            inner = raw.get("content")
            if not isinstance(inner, dict):
                continue
            if inner.get("type") != "text":
                continue
            append_piece(inner.get("text", "") or "")
        elif kind == "diff":
            path = raw.get("path") or ""
            if not path:
                continue
            old_text = raw.get("oldText") or ""
            new_text = raw.get("newText") or ""
            piece = "--- " + path + "\n+++ " + path
            if old_text == "":
                piece += "\n(new file, %d bytes)" % len(new_text)
            else:
                piece += "\n(edited: %d → %d bytes)" % (len(old_text), len(new_text))
            append_piece(piece)
        # terminal / image / unknown -> ignore
    return "\n".join(pieces)


# -- token usage parsing -----------------------------------------------


def parse_acp_token_usage(data: Any) -> TokenUsage:
    if not isinstance(data, dict):
        return TokenUsage()
    return TokenUsage(
        input_tokens=_acp_usage_int(data, "inputTokens", "input_tokens"),
        output_tokens=_acp_usage_int(data, "outputTokens", "output_tokens"),
        cache_read_tokens=_acp_usage_int(
            data, "cachedReadTokens", "cacheReadTokens", "cached_input_tokens",
            "cache_read_tokens", "cache_read_input_tokens"),
        cache_write_tokens=_acp_usage_int(
            data, "cachedWriteTokens", "cacheWriteTokens", "cache_write_tokens",
            "cache_creation_input_tokens"),
    )


def _acp_usage_int(fields: Dict[str, Any], *names: str) -> int:
    for name in names:
        if name not in fields:
            continue
        raw = fields[name]
        if isinstance(raw, bool):
            continue
        if isinstance(raw, (int, float)):
            return int(raw)
        if isinstance(raw, str):
            try:
                return int(raw.strip())
            except ValueError:
                continue
    return 0


# -- session helpers ---------------------------------------------------


def extract_acp_session_id(result: Any) -> str:
    if isinstance(result, dict):
        sid = result.get("sessionId")
        if isinstance(sid, str):
            return sid
    return ""


def extract_acp_current_model_id(result: Any) -> str:
    """Pull the model the ACP runtime selected out of a session/new or resume
    response so usage can be attributed even without an explicit model override
    (port of ``extractACPCurrentModelID``)."""
    if not isinstance(result, dict):
        return ""
    models = result.get("models")
    candidates: List[Any] = []
    if isinstance(models, dict):
        candidates.append(models.get("currentModelId"))
        candidates.append(models.get("current_model_id"))
    candidates.append(result.get("currentModelId"))
    candidates.append(result.get("current_model_id"))
    for c in candidates:
        if isinstance(c, str) and c.strip():
            return c.strip()
    return ""


def resolve_resumed_session_id(requested: str, response: Any) -> Tuple[str, bool]:
    """Pick which session id to treat as live after a resume round-trip. Prefer
    the canonical id the server returns; fall back to the requested id when the
    response omits it (port of ``resolveResumedSessionID``)."""
    got = extract_acp_session_id(response)
    if got == "":
        return requested, False
    return got, got != requested


def build_session_params(cwd: str, model: str, mcp_servers: List[Any],
                         include_model: bool) -> Dict[str, Any]:
    """Construct ``session/new`` params. ``model`` is only included when
    ``include_model`` is set and non-empty (Hermes; port of
    ``buildHermesSessionParams``)."""
    if mcp_servers is None:
        mcp_servers = []
    params: Dict[str, Any] = {"cwd": cwd, "mcpServers": mcp_servers}
    if include_model and model:
        params["model"] = model
    return params


# -- MCP config translation --------------------------------------------


def build_acp_mcp_servers(raw: Optional[bytes], logger) -> List[Any]:
    """Translate an agent's Claude-style mcp_config into the array shape ACP's
    ``session/new`` / ``session/load`` expect. Raises ``ValueError`` on
    malformed top-level JSON (fail closed); individual bad entries are skipped
    with a warning (port of ``buildACPMcpServers``)."""
    if not raw:
        return []
    trimmed = raw.strip() if isinstance(raw, (bytes, bytearray)) else raw
    if not trimmed or trimmed == b"null":
        return []
    try:
        parsed = json.loads(trimmed)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("parse mcp_config json: %s" % exc)
    if not isinstance(parsed, dict):
        return []
    servers = parsed.get("mcpServers")
    if not isinstance(servers, dict) or not servers:
        return []

    out: List[Any] = []
    for name in sorted(servers.keys()):
        try:
            entry = convert_acp_mcp_server(name, servers[name])
        except Exception as exc:  # noqa: BLE001
            if logger is not None:
                logger.warn("skipping invalid mcp_config entry", name=name, error=str(exc))
            continue
        out.append(entry)
    return out


def convert_acp_mcp_server(name: str, raw: Any) -> Dict[str, Any]:
    """Convert one Claude-style entry into the ACP McpServer wire shape (port of
    ``convertACPMcpServer``). Raises for entries with neither command nor url."""
    if not isinstance(raw, dict):
        raise ValueError("parse entry: not an object")
    command = (raw.get("command") or "").strip()
    url = (raw.get("url") or "").strip()

    if command:
        args = raw.get("args")
        if not isinstance(args, list):
            args = []
        env = raw.get("env") or {}
        env_arr = [{"name": k, "value": env[k]} for k in sorted(env.keys())] if isinstance(env, dict) else []
        return {"name": name, "command": command, "args": args, "env": env_arr}

    if url:
        t = (raw.get("type") or "").strip().lower()
        if t == "sse":
            t = "sse"
        elif t in ("", "http", "streamable-http", "http_streamable"):
            t = "http"
        else:
            t = "http"
        headers = raw.get("headers") or {}
        header_arr = [{"name": k, "value": headers[k]} for k in sorted(headers.keys())] if isinstance(headers, dict) else []
        return {"type": t, "name": name, "url": url, "headers": header_arr}

    raise ValueError("entry has neither command nor url")


@dataclass
class _McpCapabilities:
    http: bool = False
    sse: bool = False


def extract_acp_mcp_capabilities(result: Any) -> _McpCapabilities:
    """Read ``agentCapabilities.mcpCapabilities.{http,sse}`` from an initialize
    response. Missing fields stay False -- the runtime must opt in to remote MCP
    transports (port of ``extractACPMcpCapabilities``)."""
    if not isinstance(result, dict):
        return _McpCapabilities()
    caps = (((result.get("agentCapabilities") or {}).get("mcpCapabilities")) or {})
    if not isinstance(caps, dict):
        return _McpCapabilities()
    return _McpCapabilities(http=bool(caps.get("http")), sse=bool(caps.get("sse")))


def filter_acp_mcp_servers_by_capability(servers: List[Any], caps: _McpCapabilities,
                                         backend: str, logger) -> List[Any]:
    """Drop remote MCP entries whose transport the runtime didn't advertise.
    Stdio entries (no ``type``) always pass (port of
    ``filterACPMcpServersByCapability``)."""
    if not servers:
        return servers
    filtered: List[Any] = []
    for raw in servers:
        if not isinstance(raw, dict):
            filtered.append(raw)
            continue
        transport = raw.get("type", "")
        if transport == "http" and not caps.http:
            if logger is not None:
                logger.warn("dropping http MCP server: runtime did not advertise mcpCapabilities.http",
                            backend=backend, name=raw.get("name"))
            continue
        if transport == "sse" and not caps.sse:
            if logger is not None:
                logger.warn("dropping sse MCP server: runtime did not advertise mcpCapabilities.sse",
                            backend=backend, name=raw.get("name"))
            continue
        filtered.append(raw)
    return filtered


# -- tool-name normalisation -------------------------------------------


def hermes_tool_name_from_title(title: str, kind: str) -> str:
    """Extract a tool name from an ACP tool-call title (port of
    ``hermesToolNameFromTitle``). Hermes titles look like "terminal: ls -la"."""
    title = title or ""
    kind = kind or ""
    if title == "execute code":
        return "execute_code"

    idx = title.find(":")
    if idx > 0:
        name = title[:idx].strip()
        if name == "terminal":
            return "terminal"
        if name == "read":
            return "read_file"
        if name == "write":
            return "write_file"
        if name.startswith("patch"):
            return "patch"
        if name == "search":
            return "search_files"
        if name == "web search":
            return "web_search"
        if name == "extract":
            return "web_extract"
        if name == "delegate":
            return "delegate_task"
        if name == "analyze image":
            return "vision_analyze"
        return name

    mapping = {
        "read": "read_file",
        "edit": "write_file",
        "execute": "terminal",
        "search": "search_files",
        "fetch": "web_search",
        "think": "thinking",
    }
    if kind in mapping:
        return mapping[kind]
    if title != "":
        return title
    return kind


def kimi_tool_name_from_title(title: str) -> str:
    """Normalise kimi/qoder/traecli capitalised titles into snake_case (port of
    ``kimiToolNameFromTitle``)."""
    t = (title or "").strip()
    if not t:
        return ""
    idx = t.find(":")
    if idx > 0:
        t = t[:idx].strip()
    lower = t.lower()
    exact = {
        "read": "read_file", "read file": "read_file",
        "write": "write_file", "write file": "write_file",
        "edit": "edit_file", "patch": "edit_file",
        "shell": "terminal", "bash": "terminal", "terminal": "terminal",
        "run command": "terminal", "run shell command": "terminal",
        "search": "search_files", "grep": "search_files", "find": "search_files",
        "glob": "glob",
        "web search": "web_search",
        "fetch": "web_fetch", "web fetch": "web_fetch",
        "todo": "todo_write", "todo write": "todo_write",
    }
    if lower in exact:
        return exact[lower]
    return lower.replace(" ", "_")


# -- provider-error sniffing -------------------------------------------

_ACP_ERROR_HEADER_RE = re.compile(
    r"(?:⚠️|❌|\[ERROR\]).*"
    r"(?:BadRequestError|AuthenticationError|RateLimitError|HTTP [0-9]{3}|Non-retryable|API call failed)")
_ACP_ERROR_DETAIL_RE = re.compile(r"(?:Error:|detail:|Details:)\s*(.+)")
_ACP_TERMINAL_ERROR_RE = re.compile(
    r"(?:❌|\[ERROR\]|after \d+ retr|Non-retryable|BadRequestError|AuthenticationError)")
_ACP_AGENT_OUTPUT_TERMINAL_RE = re.compile(r"API call failed after \d+ retr(?:y|ies)")
_ACP_MAX_ERROR_LINES = 8


class ACPProviderErrorSniffer:
    """Scans an ACP agent's stderr for upstream-LLM error signals. ACP agents
    report ``stopReason=end_turn`` even when the underlying HTTP call fails, so
    the actionable detail only appears on stderr. Distinguishes transient
    per-attempt warnings from terminal (retries-exhausted / non-retryable)
    failures (port of ``acpProviderErrorSniffer``)."""

    def __init__(self, provider: str) -> None:
        self.provider = provider
        self._lock = threading.Lock()
        self._remains = bytearray()
        self._lines: List[str] = []
        self._seen: Dict[str, bool] = {}
        self._terminal = False

    def write(self, p: bytes) -> int:
        with self._lock:
            data = bytes(self._remains) + p
            nl = data.rfind(b"\n")
            if nl < 0:
                self._remains = bytearray(data)
                return len(p)
            complete = data[:nl].decode("utf-8", "replace")
            self._remains = bytearray(data[nl + 1:])
            for line in complete.split("\n"):
                line = line.strip()
                if not line:
                    continue
                if not (_ACP_ERROR_HEADER_RE.search(line) or _ACP_ERROR_DETAIL_RE.search(line)):
                    continue
                if _ACP_TERMINAL_ERROR_RE.search(line):
                    self._terminal = True
                if self._seen.get(line):
                    continue
                self._seen[line] = True
                self._lines.append(line)
                if len(self._lines) > _ACP_MAX_ERROR_LINES:
                    self._lines = self._lines[len(self._lines) - _ACP_MAX_ERROR_LINES:]
        return len(p)

    def message(self) -> str:
        with self._lock:
            return self._message_locked()

    def terminal_message(self) -> str:
        with self._lock:
            if not self._terminal:
                return ""
            return self._message_locked()

    def _message_locked(self) -> str:
        prefix = self.provider + " provider error: "
        for line in self._lines:
            m = _ACP_ERROR_DETAIL_RE.search(line)
            if m:
                detail = m.group(1).strip()
                if detail:
                    return prefix + detail
        for line in self._lines:
            if _ACP_ERROR_HEADER_RE.search(line):
                return prefix + line
        return ""


def promote_acp_result_on_provider_error(final_status: str, final_error: str,
                                         final_output: str,
                                         sniffer: ACPProviderErrorSniffer) -> Tuple[str, str]:
    """Flip ``completed`` -> ``failed`` when the run actually hit a terminal
    upstream-LLM failure (port of ``promoteACPResultOnProviderError``)."""
    if final_status != "completed":
        return final_status, final_error
    msg = sniffer.terminal_message()
    if msg:
        return "failed", msg
    m = _ACP_AGENT_OUTPUT_TERMINAL_RE.search(final_output or "")
    if m:
        msg = sniffer.message()
        if not msg:
            msg = sniffer.provider + " provider error: " + m.group(0)
        return "failed", msg
    if final_output == "":
        msg = sniffer.message()
        if msg:
            return "failed", msg
    return final_status, final_error


# -- per-agent spec ----------------------------------------------------


@dataclass
class ACPSpec:
    """Describes what differs between ACP backends. Everything else is driven by
    :func:`run_acp`."""

    label: str                                  # "hermes", "kimi", ...
    default_exec: str                           # "hermes", "kimi", "kiro-cli", ...
    base_args: List[str]                        # ["acp"], ["--yolo", "--acp"], ...
    blocked_args: Dict[str, BlockedArgMode]
    resume_method: str = "session/resume"       # or "session/load"
    extra_env: Dict[str, str] = field(default_factory=dict)
    prepend_system_prompt: bool = True          # False for hermes
    session_new_includes_model: bool = False    # True for hermes
    prompt_dual_fields: bool = False            # True for kiro (content + prompt)
    use_streaming_gate: bool = True             # False for kimi
    extract_current_model: bool = True          # False for kimi
    drain_grace: float = 0.0                    # 2.0 for qoder / traecli
    # tuple of TokenUsage attrs to add from the prompt response
    prompt_usage_fields: Tuple[str, ...] = ("input_tokens", "output_tokens", "cache_read_tokens")
    # optional per-agent tool-name normaliser applied to MessageToolUse
    tool_name_normalizer: Optional[Callable[[str], str]] = None
    # optional factory for per-run mutable state passed to the hooks below
    make_state: Optional[Callable[[], Any]] = None
    # optional hook run inside on_message (after normalisation) for state tracking
    on_message_hook: Optional[Callable[[Message, Any], None]] = None
    # optional hook that may override the (status, error) of a failed
    # session/prompt; returns (status, error) or None
    prompt_fail_hook: Optional[Callable[[Exception, Any], Optional[Tuple[str, str]]]] = None


# -- shared lifecycle driver -------------------------------------------


def run_acp(cfg: Config, spec: ACPSpec, prompt: str, opts: ExecOptions,
            cancel: Optional[threading.Event] = None) -> Session:
    """Spawn the ACP agent and drive its full session lifecycle, returning a
    streaming :class:`Session`. Shared by every ACP backend."""
    exec_path = cfg.executable_path or spec.default_exec
    if shutil.which(exec_path) is None and not _is_abs(exec_path):
        raise FileNotFoundError("%s executable not found: %r" % (spec.label, exec_path))

    # Fail closed on malformed mcp_config so the launch surfaces the real error.
    mcp_servers = build_acp_mcp_servers(opts.mcp_config, cfg.logger)

    args = list(spec.base_args) + filter_custom_args(opts.custom_args, spec.blocked_args, cfg.logger)
    argv = [exec_path] + args

    env = build_env(cfg.env)
    env.update(spec.extra_env)

    cfg.logger.info("agent command", exec=exec_path, args=args)
    proc = subprocess.Popen(
        argv, cwd=opts.cwd or None, env=env,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        bufsize=0, **popen_platform_kwargs(),
    )
    cfg.logger.info("%s acp started" % spec.label, pid=proc.pid, cwd=opts.cwd)

    session = Session(capture_transcript=bool(getattr(opts, "capture_transcript", False)))
    ctx = _Ctx()
    provider_err = ACPProviderErrorSniffer(spec.label)
    stderr_tail = StderrTail(
        inner=lambda b: cfg.logger.debug("[%s:stderr] %s" % (spec.label, b.decode("utf-8", "replace").rstrip())))

    # streaming gate: for gated agents, drop history-replay updates flushed
    # during session setup until we flip the gate on just before session/prompt.
    turn_gate = threading.Event()
    if not spec.use_streaming_gate:
        turn_gate.set()

    output_lock = threading.Lock()
    output_parts: List[str] = []
    prompt_done: "queue.Queue[ACPPromptResult]" = queue.Queue(maxsize=1)
    state = spec.make_state() if spec.make_state is not None else None

    def gated() -> bool:
        return (not spec.use_streaming_gate) or turn_gate.is_set()

    def on_message(msg: Message) -> None:
        if spec.use_streaming_gate and not turn_gate.is_set():
            return
        if msg.type == MessageType.TOOL_USE and spec.tool_name_normalizer is not None:
            msg.tool = spec.tool_name_normalizer(msg.tool)
        if spec.on_message_hook is not None:
            spec.on_message_hook(msg, state)
        if msg.type == MessageType.TEXT:
            with output_lock:
                output_parts.append(msg.content)
        session._emit(msg)

    def on_prompt_done(pr: ACPPromptResult) -> None:
        if spec.use_streaming_gate and not turn_gate.is_set():
            return
        try:
            prompt_done.put_nowait(pr)
        except queue.Full:
            pass

    accept = (lambda _t: turn_gate.is_set()) if spec.use_streaming_gate else None
    client = ACPClient(cfg, proc, on_message, on_prompt_done, accept_notification=accept,
                       opts=opts, provider=spec.label)

    reader_done = threading.Event()
    stderr_done = threading.Event()

    def _read_stdout() -> None:
        assert proc.stdout is not None
        try:
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip() if isinstance(raw, bytes) else raw.strip()
                if not line:
                    continue
                client.handle_line(line)
        finally:
            client.close_all_pending(Exception("%s process exited" % spec.label))
            reader_done.set()

    def _read_stderr() -> None:
        assert proc.stderr is not None
        try:
            for chunk in iter(lambda: proc.stderr.readline(), b""):
                stderr_tail.write(chunk)
                provider_err.write(chunk)
        finally:
            stderr_done.set()

    def _watch() -> None:
        start = time.monotonic()
        deadline = start + opts.timeout if opts.timeout and opts.timeout > 0 else None
        while not ctx.done.is_set():
            if proc.poll() is not None:
                return
            if deadline is not None and time.monotonic() > deadline:
                ctx.cancel("timeout")
                signal_process_group(proc)
                return
            if cancel is not None and cancel.is_set():
                ctx.cancel("aborted")
                signal_process_group(proc)
                return
            time.sleep(0.1)

    threading.Thread(target=_read_stdout, daemon=True).start()
    threading.Thread(target=_read_stderr, daemon=True).start()
    threading.Thread(target=_watch, daemon=True).start()
    threading.Thread(target=_drive, args=(
        cfg, spec, client, ctx, prompt, opts, proc, session, turn_gate,
        output_lock, output_parts, prompt_done, state, provider_err,
        stderr_tail, reader_done, stderr_done, mcp_servers,
    ), daemon=True).start()

    return session


def _drive(cfg, spec, client, ctx, prompt, opts, proc, session, turn_gate,
           output_lock, output_parts, prompt_done, state, provider_err,
           stderr_tail, reader_done, stderr_done, mcp_servers) -> None:
    start = time.monotonic()
    final_status = "completed"
    final_error = ""
    session_id = ""
    effective_model = (opts.model or "").strip()

    def fail_early(error: str) -> None:
        # Early-exit failures (before we have any output) mirror Go: they push a
        # Result with just status/error/duration and stop.
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except Exception:
            pass
        signal_process_group(proc)
        duration_ms = int((time.monotonic() - start) * 1000)
        cfg.logger.info("%s finished" % spec.label, status="failed", duration_ms=duration_ms)
        session._set_result(Result(status="failed", error=error, duration_ms=duration_ms))
        session._close_messages()

    # 1. initialize handshake.
    init_result, err = client.request(ctx, "initialize", {
        "protocolVersion": 1,
        "clientInfo": {"name": "multica-agent-sdk", "version": "0.2.0"},
        "clientCapabilities": {},
    })
    if err is not None:
        fail_early("%s initialize failed: %s" % (spec.label, err))
        return

    mcp_servers = filter_acp_mcp_servers_by_capability(
        mcp_servers, extract_acp_mcp_capabilities(init_result), spec.label, cfg.logger)

    cwd = opts.cwd or "."

    # 2. create or resume a session.
    if opts.resume_session_id:
        result, err = client.request(ctx, spec.resume_method, {
            "cwd": cwd, "sessionId": opts.resume_session_id, "mcpServers": mcp_servers,
        })
        if err is not None:
            fail_early("%s %s failed: %s" % (spec.label, spec.resume_method, err))
            return
        session_id, changed = resolve_resumed_session_id(opts.resume_session_id, result)
        if changed:
            cfg.logger.warn("agent returned a different session id on resume - original was likely lost; continuing with the new id",
                            backend=spec.label, requested=opts.resume_session_id, actual=session_id)
        if spec.extract_current_model and effective_model == "":
            effective_model = extract_acp_current_model_id(result)
    else:
        params = build_session_params(cwd, opts.model, mcp_servers, spec.session_new_includes_model)
        result, err = client.request(ctx, "session/new", params)
        if err is not None:
            fail_early("%s session/new failed: %s" % (spec.label, err))
            return
        session_id = extract_acp_session_id(result)
        if session_id == "":
            fail_early("%s session/new returned no session ID" % spec.label)
            return
        if spec.extract_current_model and effective_model == "":
            effective_model = extract_acp_current_model_id(result)

    client.session_id = session_id
    cfg.logger.info("%s session created" % spec.label, session_id=session_id)

    # 3. optional model switch. MUST fail the task on error so the user is never
    # misled into thinking their model pick was honoured.
    if opts.model:
        _, err = client.request(ctx, "session/set_model", {
            "sessionId": session_id, "modelId": opts.model,
        })
        if err is not None:
            cfg.logger.warn("%s set_session_model failed" % spec.label, error=str(err), requested_model=opts.model)
            final_status = "failed"
            final_error = "%s could not switch to model %r: %s" % (spec.label, opts.model, err)
            if opts.resume_session_id and is_acp_session_not_found(err):
                cfg.logger.warn("resumed session not found at set_model time; clearing session id so the daemon retries fresh",
                                backend=spec.label, session_id=session_id)
                session_id = ""
            duration_ms = int((time.monotonic() - start) * 1000)
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
            except Exception:
                pass
            signal_process_group(proc)
            session._set_result(Result(status=final_status, error=final_error,
                                       duration_ms=duration_ms, session_id=session_id))
            session._close_messages()
            return
        cfg.logger.info("%s session model set" % spec.label, model=opts.model)

    # 4. build and send the prompt.
    user_text = prompt
    if spec.prepend_system_prompt and opts.system_prompt:
        user_text = opts.system_prompt + "\n\n---\n\n" + prompt

    prompt_blocks = [{"type": "text", "text": user_text}]
    prompt_params: Dict[str, Any] = {"sessionId": session_id, "prompt": prompt_blocks}
    if spec.prompt_dual_fields:
        # Kiro's docs use `content`; Kiro CLI 2.1.1 still requires `prompt`.
        prompt_params["content"] = prompt_blocks

    turn_gate.set()
    _, err = client.request(ctx, "session/prompt", prompt_params)
    if err is not None:
        if isinstance(err, _ContextError) and err.reason == "timeout":
            final_status = "timeout"
            final_error = "%s timed out after %ss" % (spec.label, opts.timeout)
        elif isinstance(err, _ContextError) and err.reason == "aborted":
            final_status = "aborted"
            final_error = "execution cancelled"
        else:
            final_status = "failed"
            final_error = "%s session/prompt failed: %s" % (spec.label, err)
            handled = False
            if spec.prompt_fail_hook is not None:
                override = spec.prompt_fail_hook(err, state)
                if override is not None:
                    final_status, final_error = override
                    handled = True
            if not handled and opts.resume_session_id and is_acp_session_not_found(err):
                cfg.logger.warn("resumed session not found at prompt time; clearing session id so the daemon retries fresh",
                                backend=spec.label, session_id=session_id)
                session_id = ""
    else:
        try:
            pr = prompt_done.get_nowait()
        except queue.Empty:
            pr = None
        if pr is not None:
            if pr.stop_reason == "cancelled":
                final_status = "aborted"
                final_error = "%s cancelled the prompt" % spec.label
            with client.usage_lock:
                for attr in spec.prompt_usage_fields:
                    setattr(client.usage, attr, getattr(client.usage, attr) + getattr(pr.usage, attr))

    cfg.logger.info("%s finished prompt" % spec.label, status=final_status)

    # Signal the child to exit, then drain output.
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except Exception:
        pass
    ctx.cancel("aborted")
    signal_process_group(proc)

    if spec.drain_grace > 0:
        deadline = time.monotonic() + spec.drain_grace
        reader_done.wait(timeout=max(0.0, deadline - time.monotonic()))
        stderr_done.wait(timeout=max(0.0, deadline - time.monotonic()))
        turn_gate.clear()
    else:
        reader_done.wait()
        stderr_done.wait()

    with output_lock:
        final_output = "".join(output_parts)

    # Promote completed->failed on a terminal upstream-LLM failure.
    final_status, final_error = promote_acp_result_on_provider_error(
        final_status, final_error, final_output, provider_err)

    with client.usage_lock:
        u = TokenUsage(client.usage.input_tokens, client.usage.output_tokens,
                       client.usage.cache_read_tokens, client.usage.cache_write_tokens)

    usage_map: Dict[str, TokenUsage] = {}
    if u.input_tokens > 0 or u.output_tokens > 0 or u.cache_read_tokens > 0 or u.cache_write_tokens > 0:
        model = effective_model or "unknown"
        usage_map = {model: u}

    if final_error:
        final_error = with_agent_stderr(final_error, spec.label, stderr_tail.tail())

    duration_ms = int((time.monotonic() - start) * 1000)
    cfg.logger.info("%s finished" % spec.label, status=final_status, duration_ms=duration_ms)
    session._set_result(Result(
        status=final_status, output=final_output, error=final_error,
        duration_ms=duration_ms, session_id=session_id, usage=usage_map,
    ))
    session._close_messages()


def _snapshot(lock, parts):
    with lock:
        return list(parts)


def _is_abs(path: str) -> bool:
    import os
    return os.path.isabs(path)
