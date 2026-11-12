"""Qoder backend (port of qoder.go).

Spawns ``qodercli --yolo --acp`` and drives it over the shared ACP transport
(:mod:`._acp`). Qoder enters ACP mode via the global ``--acp`` flag (not an
``acp`` subcommand), and ``--yolo`` is daemon-owned so headless ACP always runs
in bypass-permissions mode. Qoder may keep the process (and its pipes) open
briefly after ``session/prompt`` returns, so a bounded 2s drain window is used
before finalising (the shared driver flips the streaming gate off after it).
Tool titles are re-normalised with the shared kimi-style mapper.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional

from .base import BlockedArgMode, Config, ExecOptions, Session
from ._acp import ACPSpec, kimi_tool_name_from_title, run_acp

# Qoder enters ACP mode via the global `--acp` flag; `--yolo` is daemon-owned.
# The legacy `acp` subcommand is blocked so custom_args cannot switch modes.
_QODER_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "--acp": BlockedArgMode.BLOCKED_STANDALONE,
    "acp": BlockedArgMode.BLOCKED_STANDALONE,
    "--yolo": BlockedArgMode.BLOCKED_STANDALONE,
}


class QoderBackend:
    """Backend implementation for the Qoder CLI (ACP)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        spec = ACPSpec(
            label="qoder",
            default_exec="qodercli",
            base_args=["--yolo", "--acp"],
            blocked_args=_QODER_BLOCKED_ARGS,
            resume_method="session/resume",
            prepend_system_prompt=True,
            session_new_includes_model=False,
            use_streaming_gate=True,
            extract_current_model=True,
            drain_grace=2.0,
            prompt_usage_fields=("input_tokens", "output_tokens", "cache_read_tokens"),
            tool_name_normalizer=kimi_tool_name_from_title,
        )
        return run_acp(self.cfg, spec, prompt, opts, cancel)
