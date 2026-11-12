"""MCP config handling: write a controlled MCP server config to a temp file and
pass ``--mcp-config <path>`` (port of writeMcpConfigToTemp/cleanup from
claude.go plus the Windows browser-MCP hardening in browser_mcp_config.go)."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from typing import List, Optional, Tuple

_IS_WINDOWS = os.name == "nt"


def write_mcp_config_to_temp(raw: bytes) -> str:
    """Write MCP config JSON to a temp file; returns its path. Caller removes it
    via cleanup_mcp_config_temp."""
    d = tempfile.mkdtemp(prefix="multica-mcp-")
    data = harden_browser_mcp_config(raw, d)
    path = os.path.join(d, "mcp-config.json")
    with open(path, "wb") as f:
        f.write(data)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def cleanup_mcp_config_temp(path: str) -> None:
    if not path:
        return
    d = os.path.dirname(path)
    if os.path.basename(d).startswith("multica-mcp-"):
        shutil.rmtree(d, ignore_errors=True)
        return
    try:
        os.remove(path)
    except Exception:
        pass


# -- Windows browser-MCP hardening -------------------------------------


def harden_browser_mcp_config(raw: bytes, temp_dir: str) -> bytes:
    if not _IS_WINDOWS:
        return raw
    return _harden_windows_browser_mcp_config(raw, temp_dir)


def _harden_windows_browser_mcp_config(raw: bytes, temp_dir: str) -> bytes:
    try:
        top = json.loads(raw)
    except Exception:
        return raw
    if not isinstance(top, dict) or "mcpServers" not in top:
        return raw
    servers = top.get("mcpServers")
    if not isinstance(servers, dict):
        return raw

    changed = False
    for name, entry in servers.items():
        if not isinstance(entry, dict):
            continue
        args = entry.get("args")
        if not (isinstance(args, list) and all(isinstance(a, str) for a in args)):
            continue
        lower = name.lower()
        if lower == "playwright" or _args_contain(args, "@playwright/mcp") or _args_contain(args, "@playwright\\mcp"):
            nxt = _harden_windows_playwright_mcp_args(args, temp_dir)
            if nxt != args:
                entry["args"] = nxt
                changed = True
        elif lower == "chrome-devtools" or _args_contain(args, "chrome-devtools-mcp"):
            path, ok = _windows_chromium_fallback_executable()
            if ok and _should_pin_chrome_devtools_executable(args):
                entry["args"] = args + ["--executablePath=" + path]
                changed = True
    if not changed:
        return raw
    return json.dumps(top).encode("utf-8")


def _harden_windows_playwright_mcp_args(args: List[str], temp_dir: str) -> List[str]:
    if _has_flag(args, "--config") or _has_flag(args, "--cdp-endpoint") or _has_flag(args, "--extension"):
        return args
    config_path = os.path.join(temp_dir, "playwright-windows-browser.json")
    config = {"browser": {"launchOptions": {"args": ["--disable-gpu"]}}}
    with open(config_path, "wb") as f:
        f.write(json.dumps(config).encode("utf-8"))
    try:
        os.chmod(config_path, 0o600)
    except Exception:
        pass
    return args + ["--config", config_path]


def _windows_chromium_fallback_executable() -> Tuple[str, bool]:
    pinned = os.environ.get("AGENTRUNNER_CHROME_DEVTOOLS_EXECUTABLE_PATH", "").strip()
    if pinned:
        return pinned, True
    for root in (os.environ.get("ProgramFiles(x86)"),
                 os.environ.get("ProgramFiles"),
                 os.environ.get("LocalAppData")):
        if not root or not root.strip():
            continue
        path = root.rstrip("\\/") + "\\" + "\\".join(["Microsoft", "Edge", "Application", "msedge.exe"])
        if os.path.exists(path):
            return path, True
    return "", False


def _should_pin_chrome_devtools_executable(args: List[str]) -> bool:
    for flag in ("--executablePath", "--executable-path", "-e", "--channel",
                 "--browserUrl", "--browser-url", "-u", "--wsEndpoint",
                 "--ws-endpoint", "-w", "--autoConnect", "--auto-connect"):
        if _has_flag(args, flag):
            return False
    return True


def _args_contain(args: List[str], needle: str) -> bool:
    needle = needle.lower()
    return any(needle in a.lower() for a in args)


def _has_flag(args: List[str], flag: str) -> bool:
    return any(a == flag or a.startswith(flag + "=") for a in args)
