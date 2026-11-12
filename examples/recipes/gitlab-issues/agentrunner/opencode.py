"""OpenCode backend (port of opencode.go + opencode_mcp.go).

Spawns ``opencode run --format json --dangerously-skip-permissions`` with the
prompt as the final positional argument and parses the streaming JSON events
from stdout into the unified Message/Result types -- the same pattern as the
Claude backend.

Unlike Claude, MCP configuration is not passed via ``--mcp-config``. Instead
``agent.mcp_config`` is translated into the ``mcp`` slice of OpenCode's config
schema and injected through the ``OPENCODE_CONFIG_CONTENT`` environment
variable (OpenCode's inline-config injection mechanism), leaving any
``<workdir>/opencode.json`` untouched.
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import threading
from typing import Any, Dict, List, Optional, Tuple

from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType,
    RunState, Session, StreamingRunner, TokenUsage, build_env, filter_custom_args,
)

# Flags hardcoded by the daemon that user custom_args must not override.
_OPENCODE_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "--format": BlockedArgMode.BLOCKED_WITH_VALUE,            # json output format
    "--dir": BlockedArgMode.BLOCKED_WITH_VALUE,               # task workdir anchor
    "--variant": BlockedArgMode.BLOCKED_WITH_VALUE,           # owned by thinking_level
    "--dangerously-skip-permissions": BlockedArgMode.BLOCKED_STANDALONE,
}


def build_opencode_args(opts: ExecOptions, logger: Logger) -> List[str]:
    """Assemble the argv (minus the trailing prompt) for `opencode run`.

    Known limitation -- argv size: OpenCode takes *both* the system prompt
    (``--prompt``) and the user prompt (trailing positional) on the command
    line, and ``opencode run --help`` exposes no file-based alternative and no
    stdin frame. A command line is size-capped (Windows ``CreateProcess``:
    32,767 UTF-16 units for the whole line -> ``[WinError 206]``; POSIX
    ``ARG_MAX``), so a very long prompt pair cannot be delivered safely here.
    Unlike :mod:`agentrunner.claude` (``--append-system-prompt-file``) and
    :mod:`agentrunner.codebuddy` (stdin fold-in), there is nothing to switch
    to: folding the system prompt into the positional prompt would not shrink
    the command line at all. Long instructions should instead be delivered via
    ``AGENTS.md`` in ``opts.cwd``, which OpenCode discovers on its own.
    """
    args = ["run", "--format", "json", "--dangerously-skip-permissions"]
    # Anchor OpenCode's project discovery (AGENTS.md walk-up + .opencode/skills)
    # at the task workdir; PWD is also overridden in execute() for the same
    # reason (OpenCode prefers PWD over cwd when --dir is absent).
    if opts.cwd:
        args += ["--dir", opts.cwd]
    if opts.model:
        args += ["--model", opts.model]
    if opts.thinking_level:
        args += ["--variant", opts.thinking_level]
    if opts.system_prompt:
        args += ["--prompt", opts.system_prompt]
    if opts.max_turns > 0:
        logger.warn("opencode does not support --max-turns; ignoring",
                    maxTurns=opts.max_turns)
    if opts.resume_session_id:
        args += ["--session", opts.resume_session_id]
    args += filter_custom_args(opts.custom_args, _OPENCODE_BLOCKED_ARGS, logger)
    return args


def extract_tool_output(output: Any) -> str:
    """Convert a tool state output (string or structured object) into a string."""
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output)
    except Exception:
        return ""


def opencode_error_message(err: dict) -> str:
    """Human-readable message from an opencode error event object."""
    data = err.get("data")
    if isinstance(data, dict) and data.get("message"):
        return data["message"]
    if err.get("name"):
        return err["name"]
    return ""


# -- Windows native-binary shim resolution -----------------------------


def _opencode_windows_package_candidates(goarch: str) -> List[str]:
    if goarch == "arm64":
        return ["opencode-windows-arm64", "opencode-windows-x64",
                "opencode-windows-x64-baseline"]
    return ["opencode-windows-x64", "opencode-windows-x64-baseline",
            "opencode-windows-arm64"]


def resolve_opencode_native_from_shim(shim_path: str,
                                      exists_fn=os.path.exists) -> str:
    """Return the bundled native opencode.exe for a `.cmd` npm shim on Windows.

    Windows batch argv forwarding via ``%*`` truncates multi-line positional
    arguments at the first newline; spawning the native binary directly skips
    the cmd.exe layer. Returns "" when shim isn't a .cmd or no candidate exists.
    """
    if os.path.splitext(shim_path)[1].lower() != ".cmd":
        return ""
    prefix = os.path.dirname(shim_path)
    arch = platform.machine().lower()
    goarch = "arm64" if arch in ("arm64", "aarch64") else "amd64"
    for pkg in _opencode_windows_package_candidates(goarch):
        candidate = os.path.join(prefix, "node_modules", "opencode-ai",
                                 "node_modules", pkg, "bin", "opencode.exe")
        if exists_fn(candidate):
            return candidate
    return ""


class OpencodeBackend:
    """Backend implementation for the OpenCode CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        exec_path = self.cfg.executable_path or "opencode"
        resolved = shutil.which(exec_path)
        if resolved is None:
            if os.path.isabs(exec_path) and os.path.exists(exec_path):
                resolved = exec_path
            else:
                raise FileNotFoundError(
                    "opencode executable not found at %r" % exec_path)
        if os.name == "nt":
            native = resolve_opencode_native_from_shim(resolved)
            if native:
                self.cfg.logger.info(
                    "opencode resolved to native binary to avoid .cmd shim "
                    "argv truncation", shim=resolved, native=native)
                resolved = native
        exec_path = resolved

        args = build_opencode_args(opts, self.cfg.logger)
        args = args + [prompt]

        env = build_env(self.cfg.env)
        # Override PWD so the child resolves its discovery root to the workdir.
        if opts.cwd:
            env["PWD"] = opts.cwd
        # Project agent.mcp_config into OpenCode via OPENCODE_CONFIG_CONTENT.
        mcp_content = build_opencode_mcp_config_content(opts.mcp_config)
        if mcp_content:
            if "OPENCODE_CONFIG_CONTENT" in self.cfg.env:
                self.cfg.logger.warn(
                    "agent.custom_env sets OPENCODE_CONFIG_CONTENT but "
                    "agent.mcp_config takes precedence and overrides it")
            env["OPENCODE_CONFIG_CONTENT"] = mcp_content

        runner = StreamingRunner(self.cfg, "opencode")
        state_extra = {"usage": TokenUsage()}

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            try:
                event = json.loads(line)
            except Exception:
                return
            if not isinstance(event, dict):
                return
            sid = event.get("sessionID")
            if sid:
                st.session_id = sid
            etype = event.get("type")
            part = event.get("part") or {}
            if etype == "text":
                self._handle_text(part, st, r)
            elif etype == "tool_use":
                self._handle_tool_use(part, r)
            elif etype == "error":
                self._handle_error(event, st, r)
            elif etype == "step_start":
                r.emit(Message(type=MessageType.STATUS, status="running"))
            elif etype == "step_finish":
                self._accumulate_usage(part, state_extra)

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            u = state_extra["usage"]
            if (u.input_tokens > 0 or u.output_tokens > 0
                    or u.cache_read_tokens > 0 or u.cache_write_tokens > 0):
                model = opts.model or "unknown"
                st.usage = {model: u}

        return runner.run(
            argv=[exec_path] + args, env=env, cwd=opts.cwd, on_line=on_line,
            opts=opts, cancel=cancel, on_finish=on_finish,
        )

    # -- handlers --

    def _handle_text(self, part: dict, st: RunState, r: StreamingRunner) -> None:
        text = part.get("text", "")
        if text:
            st.output.append(text)
            r.emit(Message(type=MessageType.TEXT, content=text))

    def _handle_tool_use(self, part: dict, r: StreamingRunner) -> None:
        state = part.get("state") or {}
        input_map: Optional[Dict[str, Any]] = None
        raw_in = state.get("input") if isinstance(state, dict) else None
        if raw_in is not None:
            if isinstance(raw_in, dict):
                input_map = raw_in
            elif isinstance(raw_in, (str, bytes)):
                try:
                    parsed = json.loads(raw_in)
                    if isinstance(parsed, dict):
                        input_map = parsed
                except Exception:
                    input_map = None
        r.emit(Message(type=MessageType.TOOL_USE, tool=part.get("tool", ""),
                       call_id=part.get("callID", ""), input=input_map))
        if isinstance(state, dict) and state.get("status") == "completed":
            output_str = extract_tool_output(state.get("output"))
            r.emit(Message(type=MessageType.TOOL_RESULT, tool=part.get("tool", ""),
                           call_id=part.get("callID", ""), output=output_str))

    def _handle_error(self, event: dict, st: RunState, r: StreamingRunner) -> None:
        err = event.get("error") or {}
        err_msg = opencode_error_message(err) if isinstance(err, dict) else ""
        if not err_msg:
            err_msg = "unknown opencode error"
        self.cfg.logger.warn("opencode error event", error=err_msg)
        r.emit(Message(type=MessageType.ERROR, content=err_msg))
        st.final_status = "failed"
        st.final_error = err_msg

    @staticmethod
    def _accumulate_usage(part: dict, extra: dict) -> None:
        tokens = part.get("tokens")
        if not isinstance(tokens, dict):
            return
        u: TokenUsage = extra["usage"]
        u.input_tokens += int(tokens.get("input", 0) or 0)
        u.output_tokens += int(tokens.get("output", 0) or 0)
        cache = tokens.get("cache")
        if isinstance(cache, dict):
            u.cache_read_tokens += int(cache.get("read", 0) or 0)
            u.cache_write_tokens += int(cache.get("write", 0) or 0)


# =====================================================================
# MCP config translation (port of opencode_mcp.go)
# =====================================================================


class OpencodeMCPConfigError(ValueError):
    """Raised when agent.mcp_config cannot be translated for OpenCode."""


def build_opencode_mcp_config_content(raw: Optional[bytes]) -> str:
    """Translate an agent.mcp_config payload into a JSON string carrying just
    the `mcp` slice of OpenCode's schema, for OPENCODE_CONFIG_CONTENT. Returns
    "" when raw is empty or yields no servers."""
    if not raw:
        return ""
    servers = translate_mcp_config_for_opencode(raw)
    if not servers:
        return ""
    return json.dumps({"mcp": servers})


def translate_mcp_config_for_opencode(raw: bytes) -> Dict[str, Any]:
    """Convert an agent.mcp_config payload into OpenCode's `mcp` map.

    Accepts Claude-style ``{"mcpServers": {...}}`` (translated) and native
    OpenCode ``{"mcp": {...}}`` (validated / passed through)."""
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise OpencodeMCPConfigError(
            "opencode mcp_config: parse mcp_config: %s" % exc)
    if not isinstance(payload, dict):
        raise OpencodeMCPConfigError(
            "opencode mcp_config: parse mcp_config: not a JSON object")

    mcp_servers = payload.get("mcpServers")
    if not isinstance(mcp_servers, dict):
        mcp_servers = {}
    mcp = payload.get("mcp")
    if not isinstance(mcp, dict):
        mcp = None

    if len(mcp_servers) == 0:
        if mcp is None:
            return {}
        return validate_opencode_native_mcp_map(mcp)

    servers: Dict[str, Any] = {}
    for name, raw_entry in (mcp or {}).items():
        servers[name] = validate_opencode_native_mcp_entry(name, raw_entry)
    for name, server in mcp_servers.items():
        translated = translate_mcp_server_for_opencode(name, server)
        # Re-validate translated Claude-style entries through the same schema.
        servers[name] = validate_opencode_native_mcp_entry(name, translated)
    return servers


def validate_opencode_native_mcp_map(mcp: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for name, raw in mcp.items():
        out[name] = validate_opencode_native_mcp_entry(name, raw)
    return out


_LOCAL_ALLOWED = {"type", "command", "environment", "enabled", "timeout"}
_REMOTE_ALLOWED = {"type", "url", "headers", "oauth", "enabled", "timeout"}
_ENABLED_ONLY_ALLOWED = {"enabled"}
_OAUTH_ALLOWED = {"clientId", "clientSecret", "scope", "callbackPort", "redirectUri"}


def _wrap_mcp_err(name: str, msg: str) -> OpencodeMCPConfigError:
    return OpencodeMCPConfigError('opencode mcp_config: server "%s": %s' % (name, msg))


def _reject_unknown(name: str, entry: dict, allowed: set) -> None:
    for key in entry:
        if key not in allowed:
            raise _wrap_mcp_err(name, "unknown field %r" % key)


def validate_opencode_native_mcp_entry(name: str, raw: Any) -> Dict[str, Any]:
    """Strict-validate one native-shape MCP entry against OpenCode's schema and
    return its dict representation."""
    if not isinstance(raw, dict):
        raise _wrap_mcp_err(name, "entry must be a JSON object")

    if "type" in raw and not isinstance(raw["type"], str):
        raise _wrap_mcp_err(name, "`type` must be a string, got %r" % raw["type"])
    type_str = raw.get("type", "")

    if type_str == "local":
        _reject_unknown(name, raw, _LOCAL_ALLOWED)
        command = raw.get("command")
        if not isinstance(command, list) or not all(isinstance(c, str) for c in command):
            if command is not None:
                raise _wrap_mcp_err(name, "`command` must be an array of strings")
        if not command:
            raise _wrap_mcp_err(name, "local server missing required field `command`")
        _validate_optional_timeout(name, raw)
        _validate_optional_env(name, raw, "environment")
    elif type_str == "remote":
        _reject_unknown(name, raw, _REMOTE_ALLOWED)
        url = raw.get("url")
        if not isinstance(url, str) or url == "":
            raise _wrap_mcp_err(name, "remote server missing required field `url`")
        _validate_optional_timeout(name, raw)
        _validate_optional_env(name, raw, "headers")
        if "oauth" in raw:
            try:
                validate_opencode_oauth(raw["oauth"])
            except OpencodeMCPConfigError:
                raise
            except ValueError as exc:
                raise _wrap_mcp_err(name, "`oauth`: %s" % exc)
    elif type_str == "":
        # No `type` field: only the bare {"enabled": bool} override is valid.
        if set(raw.keys()) - _ENABLED_ONLY_ALLOWED or not isinstance(
                raw.get("enabled"), bool):
            raise _wrap_mcp_err(
                name, 'missing required field `type` (must be "local" or '
                '"remote", or use bare {"enabled": bool} to override an '
                'inherited server)')
    else:
        raise _wrap_mcp_err(
            name, 'invalid type "%s" (must be "local" or "remote")' % type_str)

    return dict(raw)


def _validate_optional_timeout(name: str, entry: dict) -> None:
    if "timeout" in entry and entry["timeout"] is not None:
        t = entry["timeout"]
        if not isinstance(t, int) or isinstance(t, bool) or t <= 0:
            raise _wrap_mcp_err(name, "`timeout` must be a positive integer, got %r" % t)


def _validate_optional_env(name: str, entry: dict, key: str) -> None:
    if key in entry and entry[key] is not None:
        v = entry[key]
        if not isinstance(v, dict):
            raise _wrap_mcp_err(name, "`%s` must be an object" % key)


def validate_opencode_oauth(oauth: Any) -> None:
    """Enforce the `oauth: McpOAuthConfig | false` union from the schema."""
    if oauth is False:
        return
    if not isinstance(oauth, dict):
        raise ValueError("must be an object or `false`, got %r" % oauth)
    for key in oauth:
        if key not in _OAUTH_ALLOWED:
            raise ValueError("unknown field %r" % key)
    cp = oauth.get("callbackPort")
    if cp is not None:
        if not isinstance(cp, int) or isinstance(cp, bool) or cp < 1 or cp > 65535:
            raise ValueError("`callbackPort` must be in 1..65535, got %r" % cp)


def translate_mcp_server_for_opencode(name: str, server: Any) -> Dict[str, Any]:
    """Convert one Claude-style mcpServers entry into an OpenCode native entry."""
    if not isinstance(server, dict):
        raise _wrap_mcp_err(name, "entry must be a JSON object")

    url = server.get("url")
    if isinstance(url, str) and url != "":
        out: Dict[str, Any] = {"type": "remote", "url": url}
        if isinstance(server.get("enabled"), bool):
            out["enabled"] = server["enabled"]
        _copy_if_present(out, server, "headers")
        _copy_if_present(out, server, "oauth")
        _copy_if_present(out, server, "timeout")
        return out

    command = opencode_command(name, server)
    if not command:
        raise _wrap_mcp_err(name, "has neither url nor command")
    out = {"type": "local", "command": command}
    if isinstance(server.get("enabled"), bool):
        out["enabled"] = server["enabled"]
    if "env" in server:
        out["environment"] = server["env"]
    else:
        _copy_if_present(out, server, "environment")
    _copy_if_present(out, server, "timeout")
    return out


def opencode_command(name: str, server: dict) -> List[str]:
    """Normalise the `command` field into a string list (string + args, or an
    existing array)."""
    if "command" not in server:
        return []
    raw = server["command"]
    if isinstance(raw, str):
        cmd = [raw]
        cmd += _string_slice_field(name, server, "args")
        return cmd
    if isinstance(raw, list):
        out: List[str] = []
        for item in raw:
            if not isinstance(item, str):
                raise _wrap_mcp_err(name, "command array must contain only strings")
            out.append(item)
        return out
    raise _wrap_mcp_err(name, "command must be a string or string array")


def _string_slice_field(name: str, m: dict, key: str) -> List[str]:
    if key not in m:
        return []
    raw = m[key]
    if not isinstance(raw, list):
        raise _wrap_mcp_err(name, "%s must be an array" % key)
    out: List[str] = []
    for item in raw:
        if not isinstance(item, str):
            raise _wrap_mcp_err(name, "%s must contain only strings" % key)
        out.append(item)
    return out


def _copy_if_present(dst: dict, src: dict, key: str) -> None:
    if key in src:
        dst[key] = src[key]
