"""Kiro backend (port of kiro.go).

Spawns ``kiro-cli acp --trust-all-tools`` and drives it over the shared ACP
transport (:mod:`._acp`). Kiro advertises loadSession, so resume goes through
``session/load``, and the prompt is sent with BOTH ``content`` and ``prompt``
fields (Kiro's docs use one, Kiro CLI 2.1.1 still requires the other).

Kiro-specific: a completed ``goal_complete`` or ``multica issue comment add``
tool result immediately before a ``session/prompt`` "Internal error / failed to
generate a response" close means the task actually finished -- so that error is
demoted back to a completed status (see :func:`_kiro_prompt_fail_hook`).
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Dict, Optional, Set, Tuple

from .base import BlockedArgMode, Config, ExecOptions, Message, MessageType, Session
from ._acp import ACPRPCError, ACPSpec, run_acp

# `acp` is the protocol subcommand; --trust-all-tools / -a cover Kiro's CLI-level
# tool gate (ACP session/request_permission auto-approval is handled separately).
# In Kiro CLI 2.1.1 `-a` is short for --trust-all-tools, not --agent, so --agent
# stays allowed for custom Kiro agents.
_KIRO_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "acp": BlockedArgMode.BLOCKED_STANDALONE,
    "-a": BlockedArgMode.BLOCKED_STANDALONE,
    "--trust-all-tools": BlockedArgMode.BLOCKED_STANDALONE,
    "--trust-tools": BlockedArgMode.BLOCKED_WITH_VALUE,
}


@dataclass
class _KiroState:
    goal_ids: Set[str] = field(default_factory=set)
    issue_ids: Set[str] = field(default_factory=set)
    saw_completed_goal: bool = False
    saw_completed_issue: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


def _kiro_on_message(msg: Message, state: _KiroState) -> None:
    if msg.type == MessageType.TOOL_USE:
        if msg.tool == "goal_complete" and msg.call_id:
            with state.lock:
                state.goal_ids.add(msg.call_id)
        if msg.call_id and _is_kiro_issue_comment_add_tool(msg):
            with state.lock:
                state.issue_ids.add(msg.call_id)
    elif msg.type == MessageType.TOOL_RESULT:
        with state.lock:
            if msg.call_id in state.goal_ids:
                state.goal_ids.discard(msg.call_id)
                state.saw_completed_goal = (msg.status == "completed")
            if msg.call_id in state.issue_ids:
                state.issue_ids.discard(msg.call_id)
                state.saw_completed_issue = (msg.status == "completed")


def _kiro_prompt_fail_hook(err: Exception, state: _KiroState) -> Optional[Tuple[str, str]]:
    with state.lock:
        completed_task = state.saw_completed_goal or state.saw_completed_issue
    if completed_task and _is_kiro_goal_complete_close_error(err):
        # session/prompt failed *after* a completed task result -- preserve the
        # completed status instead of surfacing the close error.
        return ("completed", "")
    return None


def _is_kiro_goal_complete_close_error(err: Exception) -> bool:
    if not isinstance(err, ACPRPCError):
        return False
    if err.method != "session/prompt" or err.code != -32603:
        return False
    if err.message.strip().lower() != "internal error":
        return False
    return "failed to generate a response" in err.data.lower()


def _is_kiro_issue_comment_add_tool(msg: Message) -> bool:
    if msg.tool != "terminal":
        return False
    command = ""
    if isinstance(msg.input, dict):
        command = msg.input.get("command", "") or ""
    return _is_kiro_issue_comment_add_command(command)


def _is_kiro_issue_comment_add_command(command: str) -> bool:
    parts = _trim_leading_env_assignments(command.split())
    # Unwrap a single `sh -c "..."` shell wrapper layer.
    if len(parts) >= 3 and _is_posix_shell_name(parts[0]) and parts[1] == "-c":
        inner = " ".join(parts[2:]).strip("\"'")
        parts = _trim_leading_env_assignments(inner.split())
    if len(parts) < 4:
        return False
    executable = parts[0][2:] if parts[0].startswith("./") else parts[0]
    if executable != "multica" and not executable.endswith("/multica"):
        return False
    return parts[1] == "issue" and parts[2] == "comment" and parts[3] == "add"


def _trim_leading_env_assignments(parts):
    while parts and _is_env_assignment(parts[0]):
        parts = parts[1:]
    return parts


def _is_env_assignment(tok: str) -> bool:
    eq = tok.find("=")
    if eq <= 0:
        return False
    for i, c in enumerate(tok[:eq]):
        if c == "_" or c.isalpha():
            continue
        if i > 0 and c.isdigit():
            continue
        return False
    return True


def _is_posix_shell_name(tok: str) -> bool:
    if "/" in tok:
        tok = tok.rsplit("/", 1)[1]
    return tok in ("sh", "bash", "zsh", "dash")


def kiro_tool_name_from_title(title: str) -> str:
    """Normalise Kiro's ACP tool titles into snake_case (port of
    ``kiroToolNameFromTitle``)."""
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
        "grep": "search_files", "search": "search_files", "find": "search_files",
        "glob": "glob",
        "code": "code",
        "web search": "web_search",
        "fetch": "web_fetch", "web fetch": "web_fetch",
        "todo": "todo_write", "todo write": "todo_write",
        "todo list": "todo_write", "todo_list": "todo_write",
    }
    if lower in exact:
        return exact[lower]
    return lower.replace(" ", "_")


class KiroBackend:
    """Backend implementation for the Kiro CLI (ACP)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        spec = ACPSpec(
            label="kiro",
            default_exec="kiro-cli",
            base_args=["acp", "--trust-all-tools"],
            blocked_args=_KIRO_BLOCKED_ARGS,
            resume_method="session/load",
            prepend_system_prompt=True,
            session_new_includes_model=False,
            prompt_dual_fields=True,
            use_streaming_gate=True,
            extract_current_model=True,
            drain_grace=0.0,
            prompt_usage_fields=("input_tokens", "output_tokens",
                                 "cache_read_tokens", "cache_write_tokens"),
            tool_name_normalizer=kiro_tool_name_from_title,
            make_state=_KiroState,
            on_message_hook=_kiro_on_message,
            prompt_fail_hook=_kiro_prompt_fail_hook,
        )
        return run_acp(self.cfg, spec, prompt, opts, cancel)
