"""Model listing and per-provider discovery (Python port of models.go).

Ports the ``Model`` / ``ModelThinking`` / ``ThinkingLevel`` data types, the
static model catalogs, and every dynamic-discovery path (CLI help parsing,
``opencode models``, ``codex debug models`` via the thinking module, the ACP
``initialize`` + ``session/new`` handshake, etc.) from Multica's Go
``server/pkg/agent`` package.

Thinking-level annotation lives in ``_thinking.py``. To mirror the Go call
direction (``models`` calls into ``thinking``) without creating an import
cycle, ``_thinking`` imports the data types from this module at load time while
this module imports the ``annotate_*`` / ``codebuddy_help_output`` helpers
lazily, inside the functions that need them.
"""

from __future__ import annotations

import functools
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

from .base import popen_platform_kwargs

# -- Data types --------------------------------------------------------


@dataclass
class ThinkingLevel:
    """One entry in a :class:`ModelThinking` supported-levels list.

    ``value`` is the literal token passed to the CLI (Claude ``--effort
    <value>`` or Codex ``model_reasoning_effort=<value>``); ``label`` is a
    display string; ``description`` is optional helper copy lifted from the
    upstream catalog (Codex's ``description`` field).
    """

    value: str
    label: str
    description: str = ""


@dataclass
class ModelThinking:
    """Per-model reasoning/effort catalog surfaced by an agent runtime.

    Values are runtime-native. ``default_level`` empty means "the runtime
    picks, we don't know".
    """

    supported_levels: List[ThinkingLevel] = field(default_factory=list)
    default_level: str = ""


@dataclass
class Model:
    """A single LLM model exposed by an agent provider.

    ``default`` is a display hint only. ``thinking`` is ``None`` when the
    runtime/model has no thinking-level control or discovery failed.
    """

    id: str
    label: str = ""
    provider: str = ""
    default: bool = False
    thinking: Optional[ModelThinking] = None


# -- Discovery timeouts (seconds) --------------------------------------

_OPENCODE_DISCOVERY_TIMEOUT = 15.0
_PI_DISCOVERY_TIMEOUT = 15.0
_CURSOR_DISCOVERY_TIMEOUT = 15.0
_ACP_DISCOVERY_TIMEOUT = 15.0
_ACP_READ_TIMEOUT = 12.0
_ANTIGRAVITY_DISCOVERY_TIMEOUT = 10.0
_OPENCLAW_DISCOVERY_TIMEOUT = 30.0


# -- small helpers -----------------------------------------------------


def _go_title(s: str) -> str:
    """Mimic Go's ``strings.Title``: title-case the first letter of each word
    (a word begins after any non-letter)."""
    out = []
    prev_is_letter = False
    for ch in s:
        if not prev_is_letter and ch.isalpha():
            out.append(ch.upper())
        else:
            out.append(ch)
        prev_is_letter = ch.isalpha()
    return "".join(out)


def _json_valid(raw: str) -> bool:
    try:
        json.loads(raw)
        return True
    except Exception:
        return False


def _cmd_output(argv: List[str], timeout: float) -> Tuple[str, int]:
    """Run ``argv`` and return (stdout_text, returncode); mirrors exec.Cmd.Output
    (stderr captured separately and discarded). Returns ("", -1) on any error."""
    try:
        proc = subprocess.run(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, **popen_platform_kwargs(),
        )
    except Exception:
        return "", -1
    return proc.stdout.decode("utf-8", "replace"), proc.returncode


# -- ListModels --------------------------------------------------------


def list_models(provider_type: str, executable_path: str = "") -> List[Model]:
    """Return the models supported by the given agent provider.

    Static catalogs are returned baked-in; dynamic providers shell out (with
    caching) and fall back to a static list on failure. For claude/codex/
    codebuddy the catalog is augmented with discovered thinking levels.

    Raises ``ValueError`` for an unknown provider type.
    """
    if provider_type == "claude":
        models = claude_static_models()
        from ._thinking import annotate_claude_thinking
        annotate_claude_thinking(models, executable_path)
        return models
    if provider_type == "codex":
        models = codex_static_models()
        from ._thinking import annotate_codex_thinking
        annotate_codex_thinking(models, executable_path)
        return models
    if provider_type == "antigravity":
        return cached_discovery(
            provider_type,
            lambda: discover_antigravity_models(executable_path),
        )
    if provider_type == "traecli":
        return cached_discovery(
            provider_type,
            lambda: discover_traecli_models(executable_path),
        )
    if provider_type == "cursor":
        return cached_discovery(
            provider_type,
            lambda: discover_cursor_models(executable_path),
        )
    if provider_type == "copilot":
        return cached_discovery(
            provider_type,
            lambda: discover_copilot_models(executable_path),
        )
    if provider_type == "hermes":
        return cached_discovery(
            provider_type,
            lambda: discover_hermes_models(executable_path),
        )
    if provider_type == "kimi":
        return cached_discovery(
            provider_type,
            lambda: discover_kimi_models(executable_path),
        )
    if provider_type == "kiro":
        return cached_discovery(
            provider_type,
            lambda: discover_kiro_models(executable_path),
        )
    if provider_type == "qoder":
        return cached_discovery(
            provider_type,
            lambda: discover_qoder_models(executable_path),
        )
    if provider_type == "opencode":
        return cached_discovery(
            discovery_cache_key(provider_type, executable_path),
            lambda: discover_opencode_models(executable_path),
        )
    if provider_type == "pi":
        return cached_discovery(
            provider_type,
            lambda: discover_pi_models(executable_path),
        )
    if provider_type == "openclaw":
        return cached_discovery(
            provider_type,
            lambda: discover_openclaw_agents(executable_path),
        )
    if provider_type == "codebuddy":
        def _discover() -> List[Model]:
            models = discover_codebuddy_models(executable_path)
            from ._thinking import annotate_codebuddy_thinking
            annotate_codebuddy_thinking(models, executable_path)
            return models
        return cached_discovery(provider_type, _discover)
    raise ValueError("unknown agent type: %r" % provider_type)


def model_selection_supported(provider_type: str) -> bool:
    """Every built-in provider honours ``opts.model`` end-to-end."""
    return True


def model_known_incompatible_with_provider(provider_type: str, model: str) -> bool:
    """Report whether a saved model is a known mismatch for a target runtime."""
    model = model.strip()
    if model == "":
        return False
    accepted = _accepted_model_ids_for_provider(provider_type)
    if accepted is None:
        return False
    if model in accepted:
        return False
    return _is_runtime_specific_model_id(model)


def _accepted_model_ids_for_provider(provider_type: str) -> Optional[Dict[str, bool]]:
    if provider_type == "claude":
        return _model_id_set(claude_static_models())
    if provider_type == "codex":
        return _model_id_set(codex_static_models())
    return None


def _model_id_set(models: List[Model]) -> Dict[str, bool]:
    return {m.id: True for m in models}


def _is_runtime_specific_model_id(model: str) -> bool:
    if "/" in model:
        return True
    return (
        _model_has_known_prefix(model)
        or model in _model_id_set(claude_static_models())
        or model in _model_id_set(codex_static_models())
    )


def _model_has_known_prefix(model: str) -> bool:
    return (
        model.startswith("claude-")
        or model.startswith("gpt-")
        or model.startswith("gemini-")
        or model.startswith("auto-gemini-")
        or is_openai_reasoning_series_id(model)
    )


# -- discovery cache ---------------------------------------------------

_MODEL_CACHE_TTL = 60.0  # seconds

_model_cache_mu = threading.Lock()
_model_cache: Dict[str, Tuple[List[Model], float]] = {}

# 停用探測快取的環境變數（共同憲法的一部分，兩版實作都必須支援）。
#
# 為什麼需要它：本模組多數 provider 的快取 key 就是 provider_type 本身，
# **不含 executable_path**，所以同一個行程內先後用兩支不同的假 CLI 探測同一
# 個 provider，第二次會直接吃到第一次的結果——fixture 換了輸出也不會變，
# parity 會假綠。驗收工具一律帶上這個變數。
_NO_DISCOVERY_CACHE_ENV = "AGENTRUNNER_NO_DISCOVERY_CACHE"


def discovery_cache_disabled() -> bool:
    """``AGENTRUNNER_NO_DISCOVERY_CACHE`` 是否要求停用所有探測快取。

    空字串、``0``、``false`` 視為未啟用；其餘任何值都視為啟用。
    """
    return os.environ.get(_NO_DISCOVERY_CACHE_ENV, "").strip().lower() \
        not in ("", "0", "false", "no", "off")


def cached_discovery(key: str, fn: Callable[[], List[Model]]) -> List[Model]:
    """Invoke ``fn`` and cache the result for ``_MODEL_CACHE_TTL``.

    Empty results are never cached (they're almost always transient failures),
    so the next request retries immediately.
    """
    if discovery_cache_disabled():
        return fn()
    with _model_cache_mu:
        entry = _model_cache.get(key)
        if entry is not None and time.monotonic() < entry[1]:
            return entry[0]

    models = fn()
    if not models:
        return models

    with _model_cache_mu:
        _model_cache[key] = (models, time.monotonic() + _MODEL_CACHE_TTL)
    return models


def discovery_cache_key(provider_type: str, executable_path: str) -> str:
    if executable_path == "":
        return provider_type
    return provider_type + ":" + executable_path


# -- Static catalogs ---------------------------------------------------


def claude_static_models() -> List[Model]:
    return [
        Model(id="claude-sonnet-5", label="Claude Sonnet 5", provider="anthropic"),
        Model(id="claude-sonnet-4-6", label="Claude Sonnet 4.6", provider="anthropic", default=True),
        Model(id="claude-fable-5", label="Claude Fable 5", provider="anthropic"),
        Model(id="claude-opus-4-8", label="Claude Opus 4.8", provider="anthropic"),
        Model(id="claude-opus-4-7", label="Claude Opus 4.7", provider="anthropic"),
        Model(id="claude-haiku-4-5-20251001", label="Claude Haiku 4.5", provider="anthropic"),
        Model(id="claude-opus-4-6", label="Claude Opus 4.6", provider="anthropic"),
        Model(id="claude-sonnet-4-5", label="Claude Sonnet 4.5", provider="anthropic"),
    ]


def codex_static_models() -> List[Model]:
    return [
        Model(id="gpt-5.5", label="GPT-5.5", provider="openai", default=True),
        Model(id="gpt-5.5-mini", label="GPT-5.5 mini", provider="openai"),
        Model(id="gpt-5.4", label="GPT-5.4", provider="openai"),
        Model(id="gpt-5.4-mini", label="GPT-5.4 mini", provider="openai"),
        Model(id="gpt-5.3-codex", label="GPT-5.3 Codex", provider="openai"),
        Model(id="gpt-5", label="GPT-5", provider="openai"),
        Model(id="o3", label="o3", provider="openai"),
        Model(id="o3-mini", label="o3-mini", provider="openai"),
    ]


def cursor_static_models() -> List[Model]:
    return [Model(id="auto", label="Auto", provider="cursor", default=True)]


def copilot_static_models() -> List[Model]:
    return [
        Model(id="gpt-5.5", label="GPT-5.5", provider="openai"),
        Model(id="gpt-5.4", label="GPT-5.4", provider="openai"),
        Model(id="gpt-5.4-mini", label="GPT-5.4 mini", provider="openai"),
        Model(id="gpt-5.3-codex", label="GPT-5.3-Codex", provider="openai"),
        Model(id="gpt-5.2-codex", label="GPT-5.2-Codex", provider="openai"),
        Model(id="gpt-5.2", label="GPT-5.2", provider="openai"),
        Model(id="gpt-5-mini", label="GPT-5 mini", provider="openai"),
        Model(id="gpt-4.1", label="GPT-4.1", provider="openai"),
        Model(id="claude-opus-4.7", label="Claude Opus 4.7", provider="anthropic"),
        Model(id="claude-sonnet-4.6", label="Claude Sonnet 4.6", provider="anthropic"),
        Model(id="claude-sonnet-4.5", label="Claude Sonnet 4.5", provider="anthropic"),
        Model(id="claude-haiku-4.5", label="Claude Haiku 4.5", provider="anthropic"),
    ]


def infer_copilot_provider(model_id: str) -> str:
    if model_id.startswith("gpt-") or is_openai_reasoning_series_id(model_id):
        return "openai"
    if model_id.startswith("claude-"):
        return "anthropic"
    if model_id.startswith("gemini-"):
        return "google"
    if model_id.startswith("grok-"):
        return "xai"
    return ""


def is_openai_reasoning_series_id(model_id: str) -> bool:
    """Match OpenAI's ``o``-prefixed reasoning family: lowercase ``o`` followed
    by digits then end-of-string or ``-`` (e.g. ``o3``, ``o3-mini``)."""
    if len(model_id) < 2 or model_id[0] != "o":
        return False
    i = 1
    while i < len(model_id) and model_id[i].isdigit():
        i += 1
    if i == 1:
        return False
    return i == len(model_id) or model_id[i] == "-"


# -- OpenCode discovery ------------------------------------------------


def discover_opencode_models(executable_path: str) -> List[Model]:
    exec_path = executable_path or "opencode"
    if shutil.which(exec_path) is None:
        return []
    out, _ = _cmd_output([exec_path, "models", "--verbose"], _OPENCODE_DISCOVERY_TIMEOUT)
    models = parse_opencode_models(out)
    if not models:
        out, _ = _cmd_output([exec_path, "models"], _OPENCODE_DISCOVERY_TIMEOUT)
        models = parse_opencode_models(out)
    if not models:
        return []
    return models


def parse_opencode_models(output: str) -> List[Model]:
    lines = output.split("\n")
    models: List[Model] = []
    index_by_id: Dict[str, int] = {}
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line == "":
            i += 1
            continue
        mid = parse_opencode_model_id_line(line)
        if mid == "":
            i += 1
            continue
        idx = index_by_id.get(mid)
        if idx is None:
            provider = ""
            slash = mid.find("/")
            if slash > 0:
                provider = mid[:slash]
            idx = len(models)
            index_by_id[mid] = idx
            models.append(Model(id=mid, label=mid, provider=provider))

        nxt = i + 1
        while nxt < len(lines) and lines[nxt].strip() == "":
            nxt += 1
        if nxt >= len(lines) or not lines[nxt].strip().startswith("{"):
            i += 1
            continue
        raw, resume_at = collect_opencode_model_json(lines, nxt)
        if _json_valid(raw):
            annotate_opencode_model_metadata(models[idx], raw)
        i = resume_at
    return models


def parse_opencode_model_id_line(line: str) -> str:
    fields = line.split()
    if len(fields) == 0:
        return ""
    mid = fields[0]
    if mid.startswith('"') or mid.startswith("{") or mid.startswith("["):
        return ""
    if "/" not in mid:
        return ""
    if mid == mid.upper():
        return ""
    return mid


def collect_opencode_model_json(lines: List[str], start: int) -> Tuple[str, int]:
    parts: List[str] = []
    i = start
    while i < len(lines):
        line = lines[i].strip()
        if i > start and parse_opencode_model_id_line(line) != "":
            return "\n".join(parts), i
        parts.append(lines[i])
        candidate = "\n".join(parts)
        if _json_valid(candidate):
            return candidate, i + 1
        i += 1
    return "\n".join(parts), len(lines)


_OPENCODE_VARIANT_LABEL = {
    "none": "None",
    "minimal": "Minimal",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "xhigh": "Extra high",
    "max": "Max",
}

_OPENCODE_VARIANT_ORDER = {
    "none": 0,
    "minimal": 1,
    "low": 2,
    "medium": 3,
    "high": 4,
    "xhigh": 5,
    "max": 6,
}


def annotate_opencode_model_metadata(model: Model, raw: str) -> None:
    try:
        meta = json.loads(raw)
    except Exception:
        return
    if not isinstance(meta, dict):
        return
    variants = meta.get("variants") or {}
    if not meta.get("reasoning", False) and not opencode_variants_look_reasoning(variants):
        return
    levels = opencode_thinking_levels_from_variants(variants)
    if not levels:
        return
    model.thinking = ModelThinking(supported_levels=levels)


def opencode_variants_look_reasoning(variants: Dict[str, dict]) -> bool:
    for name, variant in variants.items():
        if name in _OPENCODE_VARIANT_ORDER:
            return True
        if not isinstance(variant, dict):
            continue
        if variant.get("reasoningEffort", "") != "":
            return True
        if variant.get("thinking") is not None:
            return True
    return False


def opencode_thinking_levels_from_variants(variants: Dict[str, dict]) -> List[ThinkingLevel]:
    if not variants:
        return []
    values: List[str] = []
    for value, variant in variants.items():
        disabled = isinstance(variant, dict) and variant.get("disabled", False)
        if value == "" or disabled:
            continue
        values.append(value)

    def _cmp(a: str, b: str) -> int:
        left_known = a in _OPENCODE_VARIANT_ORDER
        right_known = b in _OPENCODE_VARIANT_ORDER
        if left_known and right_known:
            la, ra = _OPENCODE_VARIANT_ORDER[a], _OPENCODE_VARIANT_ORDER[b]
            return -1 if la < ra else (1 if la > ra else 0)
        if left_known != right_known:
            return -1 if left_known else 1
        return -1 if a < b else (1 if a > b else 0)

    values.sort(key=functools.cmp_to_key(_cmp))
    levels: List[ThinkingLevel] = []
    for value in values:
        label = _OPENCODE_VARIANT_LABEL.get(value)
        if label is None:
            label = _go_title(value.replace("-", " "))
        levels.append(ThinkingLevel(value=value, label=label))
    return levels


# -- Pi discovery ------------------------------------------------------


def discover_pi_models(executable_path: str) -> List[Model]:
    exec_path = executable_path or "pi"
    if shutil.which(exec_path) is None:
        return []
    try:
        proc = subprocess.run(
            [exec_path, "--list-models"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=_PI_DISCOVERY_TIMEOUT, **popen_platform_kwargs(),
        )
    except Exception:
        return []
    stdout = proc.stdout or b""
    stderr = proc.stderr or b""
    if proc.returncode != 0 and len(stdout) == 0 and len(stderr) == 0:
        return []
    text = stdout.decode("utf-8", "replace")
    if text.strip() == "":
        text = stderr.decode("utf-8", "replace")
    return parse_pi_models(text)


def parse_pi_models(output: str) -> List[Model]:
    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for raw_line in output.split("\n"):
        line = raw_line.strip()
        if line == "":
            continue
        if is_pi_discovery_noise(line):
            continue
        fields = line.split()
        if len(fields) == 0:
            continue
        first = fields[0]
        if first.lower() == "provider":
            continue
        if ":" in first or "/" in first:
            mid = first.replace(":", "/", 1)
        elif len(fields) >= 2:
            mid = first + "/" + fields[1]
        else:
            continue
        slash = mid.find("/")
        if slash <= 0 or slash == len(mid) - 1:
            continue
        if seen.get(mid):
            continue
        seen[mid] = True
        provider = ""
        i = mid.find("/")
        if i > 0:
            provider = mid[:i]
        models.append(Model(id=mid, label=mid, provider=provider))
    return models


def is_pi_discovery_noise(line: str) -> bool:
    lower = line.lower()
    if "no models match pattern" in lower:
        return True
    return (
        lower.startswith("warning:")
        or lower.startswith("error:")
        or lower.startswith("info:")
    )


# -- ACP-based discovery (hermes/kimi/kiro/qoder/copilot/traecli) -------


@dataclass
class AcpDiscoveryProvider:
    default_bin: str
    client_name: str
    extra_env: List[str] = field(default_factory=list)
    tmpdir_prefix: str = ""
    acp_args: List[str] = field(default_factory=list)


def discover_traecli_models(executable_path: str) -> List[Model]:
    return discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="traecli",
        client_name="multica-model-discovery",
        tmpdir_prefix="multica-traecli-discovery-",
        acp_args=["acp", "serve", "--yolo"],
    ))


def discover_hermes_models(executable_path: str) -> List[Model]:
    return discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="hermes",
        client_name="multica-model-discovery",
        extra_env=["HERMES_YOLO_MODE=1"],
        tmpdir_prefix="multica-hermes-discovery-",
    ))


def discover_kimi_models(executable_path: str) -> List[Model]:
    return discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="kimi",
        client_name="multica-model-discovery",
        tmpdir_prefix="multica-kimi-discovery-",
    ))


def discover_kiro_models(executable_path: str) -> List[Model]:
    return discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="kiro-cli",
        client_name="multica-model-discovery",
        tmpdir_prefix="multica-kiro-discovery-",
    ))


def discover_qoder_models(executable_path: str) -> List[Model]:
    return discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="qodercli",
        client_name="multica-model-discovery",
        acp_args=["--yolo", "--acp"],
        tmpdir_prefix="multica-qoder-discovery-",
    ))


def discover_copilot_models(executable_path: str) -> List[Model]:
    models = discover_acp_models(executable_path, AcpDiscoveryProvider(
        default_bin="copilot",
        client_name="multica-model-discovery",
        tmpdir_prefix="multica-copilot-discovery-",
        acp_args=["--acp"],
    ))
    if not models:
        return copilot_static_models()
    for m in models:
        if m.provider == "":
            m.provider = infer_copilot_provider(m.id)
    return models


def discover_acp_models(executable_path: str, p: AcpDiscoveryProvider) -> List[Model]:
    """Run the ACP ``initialize`` + ``session/new`` handshake and parse the
    model catalog from the ``session/new`` response."""
    exec_path = executable_path or p.default_bin
    if shutil.which(exec_path) is None:
        return []

    cmd_args = p.acp_args if p.acp_args else ["acp"]
    env = None
    if p.extra_env:
        env = dict(os.environ)
        for kv in p.extra_env:
            k, _, v = kv.partition("=")
            env[k] = v

    try:
        proc = subprocess.Popen(
            [exec_path, *cmd_args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, **popen_platform_kwargs(),
        )
    except Exception:
        return []

    try:
        tmp = tempfile.mkdtemp(prefix=p.tmpdir_prefix or "multica-acp-discovery-")
    except Exception:
        _reap(proc)
        return []

    result: Dict[str, Optional[List[Model]]] = {"models": None}
    done = threading.Event()

    def _reader() -> None:
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if line == "":
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not isinstance(obj, dict):
                    continue
                if str(obj.get("id")) != "2":
                    continue
                res = obj.get("result")
                if not res:
                    continue
                result["models"] = parse_acp_session_new_models(res)
                return
        except Exception:
            pass
        finally:
            done.set()

    reader = threading.Thread(target=_reader, daemon=True)
    reader.start()

    def _write_acp(msg_id: int, method: str, params: dict) -> None:
        assert proc.stdin is not None
        data = (json.dumps({
            "jsonrpc": "2.0", "id": msg_id, "method": method, "params": params,
        }) + "\n").encode("utf-8")
        proc.stdin.write(data)
        proc.stdin.flush()

    try:
        _write_acp(1, "initialize", {
            "protocolVersion": 1,
            "clientInfo": {"name": p.client_name, "version": "0.1.0"},
            "clientCapabilities": {},
        })
        _write_acp(2, "session/new", {"cwd": tmp, "mcpServers": []})
    except Exception:
        pass

    done.wait(timeout=_ACP_READ_TIMEOUT)
    models = result["models"]

    _reap(proc)
    shutil.rmtree(tmp, ignore_errors=True)
    return models if models else []


def _reap(proc: "subprocess.Popen") -> None:
    try:
        if proc.stdin is not None:
            proc.stdin.close()
    except Exception:
        pass
    try:
        proc.kill()
    except Exception:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:
        pass


def parse_acp_session_new_models(res: dict) -> Optional[List[Model]]:
    if not isinstance(res, dict):
        return None
    models_obj = res.get("models")
    if not isinstance(models_obj, dict):
        return None
    available = models_obj.get("availableModels")
    if not available and models_obj.get("available_models") is not None:
        available = models_obj.get("available_models")
    available = available or []
    current = (models_obj.get("currentModelId") or "").strip()
    if current == "":
        current = (models_obj.get("current_model_id") or "").strip()

    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for m in available:
        if not isinstance(m, dict):
            continue
        model_id = (m.get("modelId") or "").strip()
        if model_id == "":
            model_id = (m.get("model_id") or "").strip()
        if model_id == "" or seen.get(model_id):
            continue
        seen[model_id] = True
        label = acp_model_label(m.get("name", ""), model_id)
        provider = ""
        idx = model_id.find(":")
        if idx > 0:
            provider = model_id[:idx]
        models.append(Model(
            id=model_id, label=label, provider=provider,
            default=model_id == current,
        ))
    return models


def acp_model_label(name: str, model_id: str) -> str:
    label = (name or "").strip()
    if label == "" or label.lower() == "unknown":
        return model_id
    return label


# -- Antigravity discovery ---------------------------------------------


def discover_antigravity_models(executable_path: str) -> List[Model]:
    exec_path = executable_path or "agy"
    if shutil.which(exec_path) is None:
        return []
    out, rc = _cmd_output([exec_path, "models"], _ANTIGRAVITY_DISCOVERY_TIMEOUT)
    if rc != 0 and out == "":
        return []
    return parse_antigravity_models(out)


def parse_antigravity_models(output: str) -> List[Model]:
    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for raw_line in output.split("\n"):
        name = raw_line.strip()
        if name == "" or seen.get(name):
            continue
        seen[name] = True
        models.append(Model(id=name, label=name, provider="antigravity"))
    return models


# -- Cursor discovery --------------------------------------------------


def discover_cursor_models(executable_path: str) -> List[Model]:
    exec_path = executable_path or "cursor-agent"
    if shutil.which(exec_path) is None:
        return cursor_static_models()
    out, rc = _cmd_output([exec_path, "--list-models"], _CURSOR_DISCOVERY_TIMEOUT)
    if rc != 0 and out == "":
        return cursor_static_models()
    models = parse_cursor_models(out)
    if not models:
        return cursor_static_models()
    return models


def parse_cursor_models(output: str) -> List[Model]:
    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for raw_line in output.split("\n"):
        line = raw_line.strip()
        if line == "":
            continue
        idx = line.find(" - ")
        if idx <= 0:
            continue
        mid = line[:idx].strip()
        label = line[idx + 3:].strip()
        if not is_openclaw_identifier(mid):
            continue
        if seen.get(mid):
            continue
        seen[mid] = True
        is_default = "default" in label
        paren = label.find("(")
        if paren > 0:
            label = label[:paren].strip()
        if label == "":
            label = mid
        models.append(Model(
            id=mid, label=label, provider="cursor", default=is_default,
        ))
    return models


# -- OpenClaw discovery ------------------------------------------------


def discover_openclaw_agents(executable_path: str) -> List[Model]:
    exec_path = executable_path or "openclaw"
    if shutil.which(exec_path) is None:
        return []

    for json_args in (
        ["agents", "list", "--json"],
        ["agents", "list", "--output", "json"],
        ["agents", "list", "-o", "json"],
    ):
        out, rc = _cmd_output([exec_path, *json_args], _OPENCLAW_DISCOVERY_TIMEOUT)
        if rc != 0 and out == "":
            continue
        models, ok = parse_openclaw_agents_json(out)
        if ok:
            return models

    out, rc = _cmd_output([exec_path, "agents", "list"], _OPENCLAW_DISCOVERY_TIMEOUT)
    if rc != 0 and out == "":
        return []
    return parse_openclaw_agents(out)


def parse_openclaw_agents_json(raw: str) -> Tuple[List[Model], bool]:
    raw = raw.strip()
    if raw == "":
        return [], False
    try:
        parsed = json.loads(raw)
    except Exception:
        return [], False
    if isinstance(parsed, list):
        return openclaw_entries_to_models(parsed), True
    if isinstance(parsed, dict) and parsed.get("agents") is not None:
        agents = parsed.get("agents")
        if isinstance(agents, list):
            return openclaw_entries_to_models(agents), True
    return [], False


def openclaw_entries_to_models(entries: List[dict]) -> List[Model]:
    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for e in entries:
        if not isinstance(e, dict):
            continue
        mid = e.get("id") or ""
        if mid == "":
            mid = e.get("name") or ""
        if mid == "" or seen.get(mid):
            continue
        seen[mid] = True
        display_name = e.get("name") or ""
        if display_name == "":
            display_name = mid
        label = display_name
        model_field = e.get("model") or ""
        if model_field != "":
            label = display_name + " (" + model_field + ")"
        models.append(Model(id=mid, label=label, provider="openclaw"))
    return models


def parse_openclaw_agents(output: str) -> List[Model]:
    models: List[Model] = []
    seen: Dict[str, bool] = {}
    for raw_line in output.split("\n"):
        line = raw_line.strip()
        if line == "":
            continue
        fields = line.split()
        if len(fields) < 2:
            continue
        name, model = fields[0], fields[1]
        if not is_openclaw_identifier(name) or not is_openclaw_identifier(model):
            continue
        if seen.get(name):
            continue
        seen[name] = True
        models.append(Model(
            id=name, label=name + " (" + model + ")", provider="openclaw",
        ))
    return models


def is_openclaw_identifier(s: str) -> bool:
    if s == "" or s.endswith(":"):
        return False
    first = s[0]
    if not (("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    for r in s:
        if "a" <= r <= "z" or "A" <= r <= "Z" or "0" <= r <= "9":
            continue
        if r in ("-", "_", ".", "/"):
            continue
        return False
    return True


# -- CodeBuddy model discovery -----------------------------------------

# Matches `--model <model> ... Currently supported: (m1, m2, ...)`.
_CODEBUDDY_MODEL_RE = re.compile(
    r"--model\s*<[^>]+>\s*.*?Currently supported:\s*\(([^)]+)\)"
)


def discover_codebuddy_models(executable_path: str) -> List[Model]:
    exec_path = executable_path or "codebuddy"
    if shutil.which(exec_path) is None:
        return codebuddy_static_models()
    from ._thinking import codebuddy_help_output
    help_out = codebuddy_help_output(exec_path)
    if help_out == "":
        return codebuddy_static_models()
    models = parse_codebuddy_models(help_out)
    if not models:
        return codebuddy_static_models()
    return models


def parse_codebuddy_models(help_output: str) -> List[Model]:
    match = _CODEBUDDY_MODEL_RE.search(help_output)
    if not match:
        return []
    models: List[Model] = []
    for s in match.group(1).split(","):
        mid = s.strip()
        if mid == "":
            continue
        models.append(Model(
            id=mid,
            label=codebuddy_model_label(mid),
            provider=codebuddy_model_provider(mid),
            default=len(models) == 0,
        ))
    return models


def codebuddy_model_provider(model_id: str) -> str:
    if model_id.startswith("claude-"):
        return "anthropic"
    if model_id.startswith("gemini-"):
        return "google"
    if model_id.startswith("gpt-"):
        return "openai"
    if model_id.startswith("glm-"):
        return "zhipu"
    if model_id.startswith("minimax-"):
        return "minimax"
    if model_id.startswith("kimi-"):
        return "kimi"
    if len(model_id) >= 3 and model_id[0] == "h" and model_id[1] == "y" and "0" <= model_id[2] <= "9":
        return "hunyuan"
    if model_id.startswith("deepseek-"):
        return "deepseek"
    return ""


def codebuddy_model_label(model_id: str) -> str:
    parts = model_id.split("-")
    for i, p in enumerate(parts):
        if p.lower() == "gpt" or p.lower() == "glm":
            parts[i] = p.upper()
        elif p.lower() == "ioa":
            parts[i] = "IOA"
        elif len(p) > 0:
            parts[i] = p[:1].upper() + p[1:]
    return " ".join(parts)


def codebuddy_static_models() -> List[Model]:
    return [
        Model(id="claude-sonnet-4.6", label="Claude Sonnet 4.6", provider="anthropic", default=True),
        Model(id="claude-opus-4.7", label="Claude Opus 4.7", provider="anthropic"),
        Model(id="gemini-3.1-pro", label="Gemini 3.1 Pro", provider="google"),
        Model(id="gpt-5.5", label="GPT 5.5", provider="openai"),
        Model(id="deepseek-v3-2-volc-ioa", label="Deepseek V3 2 Volc IOA", provider="deepseek"),
    ]
