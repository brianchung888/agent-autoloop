"""Hermes backend (port of hermes.go).

Spawns ``hermes acp`` and drives it over the shared ACP JSON-RPC 2.0 transport
(see :mod:`._acp`). Hermes-specific launch details: the ``acp`` subcommand is
protocol-critical (blocked from custom_args), ``HERMES_YOLO_MODE=1`` is set so
Hermes auto-approves all tool executions, the chosen model is passed to
``session/new`` (and switched via ``session/set_model``), and the runtime loads
cwd-scoped context files (AGENTS.md, ...) itself so ``opts.system_prompt`` is
deliberately NOT prepended to the user turn.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional

from .base import BlockedArgMode, Config, ExecOptions, Session
from ._acp import ACPSpec, run_acp

# `acp` is the protocol subcommand that drives the ACP transport; overriding it
# would break the daemon<->Hermes contract.
_HERMES_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "acp": BlockedArgMode.BLOCKED_STANDALONE,
}


class HermesBackend:
    """Backend implementation for the Hermes ACP CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        spec = ACPSpec(
            label="hermes",
            default_exec="hermes",
            base_args=["acp"],
            blocked_args=_HERMES_BLOCKED_ARGS,
            resume_method="session/resume",
            extra_env={"HERMES_YOLO_MODE": "1"},
            prepend_system_prompt=False,
            session_new_includes_model=True,
            use_streaming_gate=True,
            extract_current_model=True,
            drain_grace=0.0,
            prompt_usage_fields=("input_tokens", "output_tokens", "cache_read_tokens"),
            tool_name_normalizer=None,  # client already maps via hermes titles
        )
        return run_acp(self.cfg, spec, prompt, opts, cancel)
