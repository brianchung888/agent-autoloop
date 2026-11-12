"""agentrunner -- one Python interface for running coding agents.

Implementation ported from Multica's ``server/pkg/agent`` Go package
(https://github.com/multica-ai/multica), with structured diagnostics and
the approval-callback design borrowed from AgentSpace's AgentRouter.

A unified, in-process interface for driving coding-agent CLIs (Claude Code,
CodeBuddy, Codex, Copilot, OpenCode, OpenClaw, Hermes, Pi, Cursor, Kimi, Kiro,
Antigravity, Qoder, Trae) and consuming their native streaming output as
structured events -- "call the CLI like an API".

Usage::

    from agentrunner import new, Config, ExecOptions

    backend = new("claude", Config(executable_path="claude"))
    session = backend.execute("List the files here", ExecOptions(cwd="/repo"))
    for msg in session.messages():
        print(msg.type, msg.content or msg.tool)
    result = session.result()
    print(result.status, result.output, result.usage)
"""

from __future__ import annotations

from .base import (
    ApprovalDecision, ApprovalRequest, Backend, BlockedArgMode, Config,
    Diagnostic, DiagnosticCode, DiagnosticSeverity, ExecOptions, Logger,
    Message, MessageType, Result, Session, TokenUsage, create_diagnostic,
    resolve_approval,
)
from ._version import (
    MIN_VERSIONS, check_min_version, detect_cli_version, parse_semver,
)

# Backend implementations
from .antigravity import AntigravityBackend
from .claude import ClaudeBackend
from .codebuddy import CodebuddyBackend
from .codex import CodexBackend
from .copilot import CopilotBackend
from .cursor import CursorBackend
from .hermes import HermesBackend
from .kimi import KimiBackend
from .kiro import KiroBackend
from .openclaw import OpenclawBackend
from .opencode import OpencodeBackend
from .pi import PiBackend
from .qoder import QoderBackend
from .traecli import TraecliBackend
from .remote import HttpRemoteBackend, RemoteBackend, RemoteVersionError

__version__ = "1.1.0"

__all__ = [
    "__version__", "new", "new_remote", "SUPPORTED_TYPES", "is_supported_type", "launch_header",
    "detect_version",
    "Backend", "Config", "ExecOptions", "Session", "Message", "MessageType",
    "Result", "TokenUsage", "Logger", "BlockedArgMode",
    "Diagnostic", "DiagnosticCode", "DiagnosticSeverity", "create_diagnostic",
    "ApprovalRequest", "ApprovalDecision", "resolve_approval",
    "MIN_VERSIONS", "check_min_version", "parse_semver",
    "RemoteBackend", "HttpRemoteBackend", "RemoteVersionError",
]

# Canonical whitelist of agent types eligible to back a custom runtime profile.
SUPPORTED_TYPES = [
    "claude", "codebuddy", "codex", "copilot", "opencode", "openclaw",
    "hermes", "pi", "cursor", "kimi", "kiro", "antigravity", "qoder", "traecli",
]

_BACKENDS = {
    "claude": ClaudeBackend,
    "codebuddy": CodebuddyBackend,
    "codex": CodexBackend,
    "copilot": CopilotBackend,
    "opencode": OpencodeBackend,
    "openclaw": OpenclawBackend,
    "hermes": HermesBackend,
    "pi": PiBackend,
    "cursor": CursorBackend,
    "kimi": KimiBackend,
    "kiro": KiroBackend,
    "antigravity": AntigravityBackend,
    "qoder": QoderBackend,
    "traecli": TraecliBackend,
}

# User-visible launch skeleton per agent type (LaunchHeader in Go).
_LAUNCH_HEADERS = {
    "antigravity": "agy -p (non-interactive)",
    "claude": "claude (stream-json)",
    "codebuddy": "codebuddy (stream-json)",
    "codex": "codex app-server",
    "copilot": "copilot (json)",
    "cursor": "cursor-agent (stream-json)",
    "hermes": "hermes acp",
    "kimi": "kimi acp",
    "kiro": "kiro-cli acp",
    "openclaw": "openclaw agent (json)",
    "opencode": "opencode run (json)",
    "pi": "pi (json mode)",
    "qoder": "qodercli --acp",
    "traecli": "traecli acp serve",
}


def is_supported_type(agent_type: str) -> bool:
    """Report whether ``agent_type`` is in the SUPPORTED_TYPES whitelist."""
    return agent_type in SUPPORTED_TYPES


def new(agent_type: str, cfg: Config = None) -> Backend:
    """Create a :class:`Backend` for the given agent type (mirrors Go's New)."""
    if cfg is None:
        cfg = Config()
    if cfg.logger is None:
        cfg.logger = Logger()
    try:
        return _BACKENDS[agent_type](cfg)
    except KeyError:
        raise ValueError(
            "unknown agent type: %r (supported: %s)"
            % (agent_type, ", ".join(SUPPORTED_TYPES)))


def launch_header(agent_type: str) -> str:
    """Return the user-visible launch skeleton for ``agent_type`` ("" if unknown)."""
    return _LAUNCH_HEADERS.get(agent_type, "")


def detect_version(executable_path: str) -> str:
    """Run the agent CLI with --version and return the extracted version line."""
    return detect_cli_version(executable_path)


def new_remote(host: str, agent_type: str = "claude", cfg: Config = None, **kwargs):
    """建立在遠端主機上執行的 Backend。

    介面與 :func:`new` 相同——``execute()`` 回傳一樣的 Session，呼叫端無需改動。

        backend = new_remote("user@10.0.0.5", "claude")            # SSH
        backend = new_remote("http://10.0.0.5:8700", "claude", token="…")  # HTTP 服務
        session = backend.execute("修好測試", ExecOptions(cwd="/repo"))   # cwd 指遠端路徑

    ``host`` 以 ``http://`` / ``https://`` 開頭時走 HTTP（需遠端跑 ``agentrunner
    serve``，並以 ``token=`` 提供憑證），否則視為 ssh 目標。

    兩者介面相同，差別在：HTTP 版支援**互動審批**（有獨立回程通道），SSH 版
    則需要遠端 shell 帳號但不需常駐服務。
    """
    if cfg is None:
        cfg = Config()
    if cfg.logger is None:
        cfg.logger = Logger()
    if not is_supported_type(agent_type):
        raise ValueError("unknown agent type: %r (supported: %s)"
                         % (agent_type, ", ".join(SUPPORTED_TYPES)))
    if host.startswith("http://") or host.startswith("https://"):
        return HttpRemoteBackend(cfg, base_url=host, agent=agent_type, **kwargs)
    return RemoteBackend(cfg, host=host, agent=agent_type, **kwargs)
