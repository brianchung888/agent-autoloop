"""Kimi backend (port of kimi.go).

Spawns ``kimi acp`` (Kimi Code CLI) and reuses the shared ACP transport
(:mod:`._acp`) since Kimi speaks the same protocol as Hermes. Differences from
Hermes: no ``HERMES_YOLO_MODE`` (``kimi acp`` ignores --yolo, so the daemon
auto-approves via the ACP ``session/request_permission`` reply instead), the
system prompt IS prepended to the user turn, tool titles are re-normalised from
Kimi's capitalised form ("Read file: ...") into snake_case, no streaming gate,
and usage is attributed to ``opts.model``.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional

from .base import BlockedArgMode, Config, ExecOptions, Session
from ._acp import ACPSpec, kimi_tool_name_from_title, run_acp

_KIMI_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "acp": BlockedArgMode.BLOCKED_STANDALONE,
}


class KimiBackend:
    """Backend implementation for the Kimi Code CLI (ACP)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        spec = ACPSpec(
            label="kimi",
            default_exec="kimi",
            base_args=["acp"],
            blocked_args=_KIMI_BLOCKED_ARGS,
            resume_method="session/resume",
            prepend_system_prompt=True,
            session_new_includes_model=False,
            use_streaming_gate=False,
            extract_current_model=False,
            drain_grace=0.0,
            prompt_usage_fields=("input_tokens", "output_tokens"),
            tool_name_normalizer=kimi_tool_name_from_title,
        )
        return run_acp(self.cfg, spec, prompt, opts, cancel)
