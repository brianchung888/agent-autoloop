"""TRAE CLI backend (port of traecli.go).

Spawns ``traecli acp serve --yolo`` and drives it over the shared ACP transport
(:mod:`._acp`). Targets ByteDance's official TRAE CLI (the ``traecli`` binary,
NOT the open-source ``trae-cli``). traecli is ACP-native: it advertises
``loadSession`` and ``mcpCapabilities {http, sse}`` from ``initialize``, returns
its model catalog from ``session/new``, and supports ``session/load`` (resume),
``session/set_model`` and ``session/prompt``. Like Qoder it may keep its pipes
open briefly after the prompt returns, so a bounded 2s drain window is used.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional

from .base import BlockedArgMode, Config, ExecOptions, Session
from ._acp import ACPSpec, kimi_tool_name_from_title, run_acp

# `acp`/`serve` are the protocol subcommand/action; `-y`/`--yolo` is daemon-owned
# (bypass-permissions). `--print`/`-p` and `--output-format` would switch traecli
# out of ACP into print mode; `--permission-mode` is owned by the daemon.
_TRAECLI_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "acp": BlockedArgMode.BLOCKED_STANDALONE,
    "serve": BlockedArgMode.BLOCKED_STANDALONE,
    "-y": BlockedArgMode.BLOCKED_STANDALONE,
    "--yolo": BlockedArgMode.BLOCKED_STANDALONE,
    "-p": BlockedArgMode.BLOCKED_STANDALONE,
    "--print": BlockedArgMode.BLOCKED_STANDALONE,
    "--output-format": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--permission-mode": BlockedArgMode.BLOCKED_WITH_VALUE,
}


class TraecliBackend:
    """Backend implementation for ByteDance's TRAE CLI (ACP)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        spec = ACPSpec(
            label="traecli",
            default_exec="traecli",
            base_args=["acp", "serve", "--yolo"],
            blocked_args=_TRAECLI_BLOCKED_ARGS,
            resume_method="session/load",
            prepend_system_prompt=True,
            session_new_includes_model=False,
            use_streaming_gate=True,
            extract_current_model=True,
            drain_grace=2.0,
            prompt_usage_fields=("input_tokens", "output_tokens", "cache_read_tokens"),
            tool_name_normalizer=kimi_tool_name_from_title,
        )
        return run_acp(self.cfg, spec, prompt, opts, cancel)
