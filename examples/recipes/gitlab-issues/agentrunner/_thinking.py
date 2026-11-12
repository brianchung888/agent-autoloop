"""Per-model reasoning/effort discovery and validation (port of thinking.go).

Discovers the reasoning/effort catalogs for the claude, codex, and codebuddy
backends by probing the local CLI (``--help`` / ``debug models``) so the daemon
can advertise them to the UI without hard-coding what's installed. Also holds
the shared validation gates (:func:`validate_thinking_level`,
:func:`is_known_thinking_value`) and the provider effort enums.

MUL-2339: claude's ``low|medium|high|xhigh|max`` and codex's
``none|minimal|low|medium|high|xhigh`` are deliberately NOT flattened onto a
shared enum -- values must round-trip exactly through each CLI's own vocabulary.

This module imports the data types and ``list_models`` from ``models`` at load
time; ``models`` imports the ``annotate_*`` / :func:`codebuddy_help_output`
helpers lazily, so there is no import cycle.
"""

from __future__ import annotations

import json
import re
import subprocess
import threading
import time
from typing import Dict, List, Optional

from .base import popen_platform_kwargs
from ._version import detect_cli_version
from .models import (
    Model,
    ModelThinking,
    ThinkingLevel,
    claude_static_models,
    discovery_cache_disabled,
    list_models,
    _go_title,
)

# CLI probe timeouts (seconds).
_CLAUDE_HELP_TIMEOUT = 35.0
_CODEX_DEBUG_MODELS_TIMEOUT = 20.0
_CODEBUDDY_HELP_TIMEOUT = 35.0


def _detect_version_safe(exec_path: str) -> str:
    """DetectVersion analogue that swallows errors (mirrors ``version, _ :=``)."""
    try:
        return detect_cli_version(exec_path)
    except Exception:
        return ""


# ── Discovery cache ───────────────────────────────────────────────────
#
# Keyed on (provider, executable_path, cli_version) so bumping the local CLI
# invalidates entries that referenced the older version's help / debug output.

_THINKING_DISCOVERY_TTL = 10 * 60.0  # 10 minutes

_thinking_cache_mu = threading.Lock()
# key -> (mapping, expires_at); mapping is {model_id: ModelThinking}
_thinking_cache: Dict[tuple, tuple] = {}


def _thinking_cache_get(key: tuple) -> Optional[Dict[str, ModelThinking]]:
    # AGENTRUNNER_NO_DISCOVERY_CACHE：見 models.discovery_cache_disabled 的說明。
    if discovery_cache_disabled():
        return None
    with _thinking_cache_mu:
        entry = _thinking_cache.get(key)
        if entry is None or time.monotonic() > entry[1]:
            return None
        return entry[0]


def _thinking_cache_put(key: tuple, value: Dict[str, ModelThinking]) -> None:
    if discovery_cache_disabled():
        return
    with _thinking_cache_mu:
        _thinking_cache[key] = (value, time.monotonic() + _THINKING_DISCOVERY_TTL)


def reset_thinking_cache_for_tests() -> None:
    """Test-only cache reset; production relies on the TTL / process restart."""
    global _thinking_cache
    with _thinking_cache_mu:
        _thinking_cache = {}


# ── Claude ─────────────────────────────────────────────────────────────

# Matches the `claude --help` line advertising `--effort <level> ... (low, ...)`.
_CLAUDE_EFFORT_RE = re.compile(
    r"--effort\s*(?:<[^>]+>)?\s*(?:Effort level[^(]*)?\(([^)]+)\)"
)

_CLAUDE_EFFORT_LABEL = {
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
}

# Per-model allow-list; missing model = use the parsed superset as-is.
_CLAUDE_MODEL_EFFORT_ALLOW: Dict[str, Dict[str, bool]] = {
    "claude-opus-4-8": {"low": True, "medium": True, "high": True, "xhigh": True, "max": True},
    "claude-opus-4-7": {"low": True, "medium": True, "high": True, "xhigh": True, "max": True},
    "claude-opus-4-6": {"low": True, "medium": True, "high": True, "xhigh": True, "max": True},
    "claude-sonnet-4-6": {"low": True, "medium": True, "high": True, "max": True},
    "claude-sonnet-4-5": {"low": True, "medium": True, "high": True, "max": True},
    "claude-haiku-4-5-20251001": {"low": True, "medium": True, "high": True},
}

_CLAUDE_STATIC_EFFORT_FALLBACK = ["low", "medium", "high"]
_CLAUDE_STATIC_EFFORT_FULL_SUPERSET = ["low", "medium", "high", "xhigh", "max"]


def annotate_claude_thinking(models: List[Model], executable_path: str) -> None:
    mapping = load_claude_thinking_by_model(executable_path)
    for m in models:
        t = mapping.get(m.id)
        if t is not None:
            m.thinking = t


def load_claude_thinking_by_model(executable_path: str) -> Dict[str, ModelThinking]:
    exec_path = executable_path or "claude"
    version = _detect_version_safe(exec_path)
    key = ("claude", exec_path, version)
    cached = _thinking_cache_get(key)
    if cached is not None:
        return cached

    superset = claude_effort_superset(exec_path)
    result: Dict[str, ModelThinking] = {}
    for m in claude_static_models():
        allow = _CLAUDE_MODEL_EFFORT_ALLOW.get(m.id)
        levels = project_claude_levels(superset, allow)
        if len(levels) == 0:
            continue
        result[m.id] = ModelThinking(supported_levels=levels, default_level="medium")
    _thinking_cache_put(key, result)
    return result


def claude_effort_superset(executable_path: str) -> List[str]:
    try:
        proc = subprocess.run(
            [executable_path, "--help"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=_CLAUDE_HELP_TIMEOUT, **popen_platform_kwargs(),
        )
    except Exception:
        return list(_CLAUDE_STATIC_EFFORT_FALLBACK)
    if proc.returncode != 0:
        return list(_CLAUDE_STATIC_EFFORT_FALLBACK)
    return claude_effort_levels_from_help(proc.stdout.decode("utf-8", "replace"))


def claude_effort_levels_from_help(help_text: str) -> List[str]:
    parsed = parse_claude_effort_help(help_text)
    if len(parsed) > 0:
        return parsed
    if "--effort" in help_text:
        return list(_CLAUDE_STATIC_EFFORT_FULL_SUPERSET)
    return []


def parse_claude_effort_help(help_text: str) -> List[str]:
    match = _CLAUDE_EFFORT_RE.search(help_text)
    if not match:
        return []
    out: List[str] = []
    for raw in match.group(1).split(","):
        token = raw.strip()
        if token == "":
            continue
        out.append(token)
    return out


def project_claude_levels(superset: List[str], allow: Optional[Dict[str, bool]]) -> List[ThinkingLevel]:
    out: List[ThinkingLevel] = []
    for value in superset:
        if allow is not None and not allow.get(value, False):
            continue
        label = _CLAUDE_EFFORT_LABEL.get(value)
        if label is None:
            label = _go_title(value)
        out.append(ThinkingLevel(value=value, label=label))
    return out


# ── Codex ──────────────────────────────────────────────────────────────

_CODEX_EFFORT_LABEL = {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
}

# argv passed to discover the local Codex catalog (pinned as a module var so
# tests can assert the exact invocation, matching the Go contract).
CODEX_DEBUG_MODELS_ARGS = ["debug", "models", "--bundled"]


def annotate_codex_thinking(models: List[Model], executable_path: str) -> None:
    mapping = load_codex_thinking_by_model(executable_path)
    for m in models:
        t = mapping.get(m.id)
        if t is not None:
            m.thinking = t


def load_codex_thinking_by_model(executable_path: str) -> Dict[str, ModelThinking]:
    exec_path = executable_path or "codex"
    version = _detect_version_safe(exec_path)
    key = ("codex", exec_path, version)
    cached = _thinking_cache_get(key)
    if cached is not None:
        return cached

    raw = run_codex_debug_models(exec_path)
    if raw is None:
        # Cache the empty result so repeated UI polls don't re-shell the
        # missing binary; the TTL eventually retries.
        _thinking_cache_put(key, {})
        return {}
    parsed = parse_codex_debug_models(raw)
    _thinking_cache_put(key, parsed)
    return parsed


def run_codex_debug_models(executable_path: str) -> Optional[bytes]:
    """Return raw stdout bytes from ``codex debug models --bundled`` or None on error."""
    try:
        proc = subprocess.run(
            [executable_path, *CODEX_DEBUG_MODELS_ARGS],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=_CODEX_DEBUG_MODELS_TIMEOUT, **popen_platform_kwargs(),
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout


def parse_codex_debug_models(raw: bytes) -> Dict[str, ModelThinking]:
    """Project the JSON payload from ``codex debug models`` into a per-model
    thinking catalog. Always returns a dict (never None)."""
    out: Dict[str, ModelThinking] = {}
    try:
        resp = json.loads(raw)
    except Exception:
        return out
    if not isinstance(resp, dict):
        return out
    for m in resp.get("models", []) or []:
        if not isinstance(m, dict):
            continue
        slug = m.get("slug", "")
        supported = m.get("supported_reasoning_levels", []) or []
        if slug == "" or len(supported) == 0:
            continue
        levels: List[ThinkingLevel] = []
        for lvl in supported:
            if not isinstance(lvl, dict):
                continue
            effort = lvl.get("effort", "")
            if effort == "":
                continue
            label = _CODEX_EFFORT_LABEL.get(effort)
            if label is None:
                label = _go_title(effort)
            levels.append(ThinkingLevel(
                value=effort, label=label, description=lvl.get("description", ""),
            ))
        if len(levels) == 0:
            continue
        out[slug] = ModelThinking(
            supported_levels=levels,
            default_level=m.get("default_reasoning_level", ""),
        )
    return out


# ── CodeBuddy ────────────────────────────────────────────────────────────

_CODEBUDDY_EFFORT_RE = re.compile(r"--effort\s*(?:<[^>]+>)?\s*[^(]*\(([^)]+)\)")

_CODEBUDDY_EFFORT_LABEL = {
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
}

_CODEBUDDY_STATIC_EFFORT_FALLBACK = ["low", "medium", "high", "xhigh"]

# CodeBuddy's `--help` is slow (~30s); cache the raw output so model discovery
# (models.py) and effort discovery share a single cold invocation.
_CODEBUDDY_HELP_TTL = 60.0  # seconds

_codebuddy_help_mu = threading.Lock()
_codebuddy_help_store: Dict[str, tuple] = {}  # key -> (output, expires_at)


def codebuddy_help_output(executable_path: str) -> str:
    exec_path = executable_path or "codebuddy"
    key = exec_path
    no_cache = discovery_cache_disabled()
    if not no_cache:
        with _codebuddy_help_mu:
            entry = _codebuddy_help_store.get(key)
            if entry is not None and time.monotonic() < entry[1]:
                return entry[0]

    try:
        proc = subprocess.run(
            [exec_path, "--help"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=_CODEBUDDY_HELP_TIMEOUT, **popen_platform_kwargs(),
        )
        result = proc.stdout.decode("utf-8", "replace")
    except Exception:
        result = ""

    if result != "" and not no_cache:
        with _codebuddy_help_mu:
            _codebuddy_help_store[key] = (result, time.monotonic() + _CODEBUDDY_HELP_TTL)
    return result


def annotate_codebuddy_thinking(models: List[Model], executable_path: str) -> None:
    exec_path = executable_path or "codebuddy"
    version = _detect_version_safe(exec_path)
    key = ("codebuddy", exec_path, version)
    cached = _thinking_cache_get(key)
    if cached is not None:
        for m in models:
            t = cached.get(m.id)
            if t is not None:
                m.thinking = t
        return

    levels = codebuddy_effort_superset(exec_path)
    thinking_levels: List[ThinkingLevel] = []
    for value in levels:
        label = _CODEBUDDY_EFFORT_LABEL.get(value)
        if label is None:
            label = _go_title(value)
        thinking_levels.append(ThinkingLevel(value=value, label=label))

    result: Dict[str, ModelThinking] = {}
    if len(thinking_levels) > 0:
        thinking = ModelThinking(supported_levels=thinking_levels, default_level="medium")
        for m in models:
            result[m.id] = thinking
    _thinking_cache_put(key, result)

    for m in models:
        t = result.get(m.id)
        if t is not None:
            m.thinking = t


def codebuddy_effort_superset(executable_path: str) -> List[str]:
    help_out = codebuddy_help_output(executable_path)
    if help_out == "":
        return list(_CODEBUDDY_STATIC_EFFORT_FALLBACK)
    parsed = parse_codebuddy_effort_help(help_out)
    if len(parsed) == 0:
        return list(_CODEBUDDY_STATIC_EFFORT_FALLBACK)
    return parsed


def parse_codebuddy_effort_help(help_text: str) -> List[str]:
    match = _CODEBUDDY_EFFORT_RE.search(help_text)
    if not match:
        return []
    out: List[str] = []
    for raw in match.group(1).split(","):
        token = raw.strip()
        if token == "":
            continue
        out.append(token)
    return out


# ── Shared validation ────────────────────────────────────────────────────


def validate_thinking_level(provider_type: str, executable_path: str,
                            model: str, value: str) -> bool:
    """Report whether ``value`` is in the supported catalog for the given
    (provider, model) pair. Empty value is always valid.

    Empty model resolves to the provider's default (catalog entry flagged
    ``default``); unknown models fail closed. Consults the live catalog via
    :func:`list_models` (raises like the Go ``ListModels`` error path).
    """
    if value == "":
        return True
    models = list_models(provider_type, executable_path)
    target = model
    if target == "":
        for m in models:
            if m.default:
                target = m.id
                break
        if target == "":
            if provider_type == "opencode":
                return any_model_supports_thinking_value(models, value)
            return False
    for m in models:
        if m.id != target:
            continue
        if m.thinking is None:
            return False
        for lvl in m.thinking.supported_levels:
            if lvl.value == value:
                return True
        return False
    return False


def any_model_supports_thinking_value(models: List[Model], value: str) -> bool:
    for m in models:
        if m.thinking is None:
            continue
        for lvl in m.thinking.supported_levels:
            if lvl.value == value:
                return True
    return False


# Server-side accept-list for runtimes with a fixed reasoning-effort
# vocabulary. OpenCode is deliberately absent (its `--variant` values come from
# the local catalog / opencode.json). Keep permissive: "is this a known token
# in this runtime's universe", not "is this the right level for this model".
_PROVIDER_THINKING_ENUMS: Dict[str, Dict[str, bool]] = {
    "claude": {"low": True, "medium": True, "high": True, "xhigh": True, "max": True},
    "codex": {"none": True, "minimal": True, "low": True, "medium": True, "high": True, "xhigh": True},
    "codebuddy": {"low": True, "medium": True, "high": True, "xhigh": True},
}


def is_known_thinking_value(provider_type: str, value: str) -> bool:
    """Cheap synchronous gate: is ``value`` a recognised effort token for the
    provider? Empty is always accepted. OpenCode accepts well-formed variant
    names; unknown providers accept only empty.

    Unlike :func:`validate_thinking_level` this does NOT consult the live
    catalog or per-model subset.
    """
    if value == "":
        return True
    if provider_type == "opencode":
        return is_valid_opencode_variant_name(value)
    enum = _PROVIDER_THINKING_ENUMS.get(provider_type)
    if enum is None:
        return False
    return enum.get(value, False)


def is_valid_opencode_variant_name(value: str) -> bool:
    if len(value) > 64:
        return False
    for i, r in enumerate(value):
        valid = (
            ("a" <= r <= "z")
            or ("A" <= r <= "Z")
            or ("0" <= r <= "9")
            or r in ("-", "_", ".")
        )
        if not valid:
            return False
        if i == 0 and r in ("-", "_", "."):
            return False
    return True
