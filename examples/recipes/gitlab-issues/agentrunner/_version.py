"""CLI version detection and minimum-version gating (port of version.go + the
detectCLIVersion helper from claude.go)."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from typing import Optional

from .base import popen_platform_kwargs

# Minimum required CLI version per agent type; below these are rejected.
MIN_VERSIONS = {
    "claude": "2.0.0",
    "codex": "0.100.0",   # app-server --listen stdio:// added in 0.100.0
    "copilot": "1.0.0",   # --output-format json envelope stable from 1.0.x
}

# versionRe matches "2.1.100", "v2.0.0", or "2.1.100 (Claude Code)".
_VERSION_RE = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")

# git-describe shape for dev builds, e.g. v0.2.15-235-gdaf0e935[-dirty].
_DEV_DESCRIBE_RE = re.compile(r"^v?\d+\.\d+\.\d+-\d+-g[0-9a-fA-F]+")

# Detection timeout (seconds); fail a wedged `--version` probe fast.
DETECT_VERSION_TIMEOUT = 10.0


class CLIVersionMissing(Exception):
    pass


class CLIVersionTooOld(Exception):
    pass


@dataclass(frozen=True)
class Semver:
    major: int
    minor: int
    patch: int

    def less_than(self, other: "Semver") -> bool:
        if self.major != other.major:
            return self.major < other.major
        if self.minor != other.minor:
            return self.minor < other.minor
        return self.patch < other.patch


def parse_semver(raw: str) -> Semver:
    m = _VERSION_RE.search(raw)
    if not m:
        raise ValueError("cannot parse version %r" % raw)
    return Semver(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def extract_version_line(raw: str) -> str:
    """Pull the version line out of a `<cli> --version` capture, discarding
    leading shell noise (e.g. Windows `Active code page: 65001`)."""
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        if _VERSION_RE.search(line):
            return line
    return raw.strip()


def detect_cli_version(exec_path: str, timeout: float = DETECT_VERSION_TIMEOUT) -> str:
    """Run `<cli> --version` and return the extracted version line."""
    try:
        proc = subprocess.run(
            [exec_path, "--version"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout, **popen_platform_kwargs(),
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("detect version for %s: %s" % (exec_path, exc))
    return extract_version_line(proc.stdout.decode("utf-8", "replace"))


def check_min_version(agent_type: str, detected_version: str) -> None:
    """Raise if detected_version is below the minimum for agent_type."""
    min_raw = MIN_VERSIONS.get(agent_type)
    if min_raw is None:
        return
    minimum = parse_semver(min_raw)
    detected = parse_semver(detected_version)
    if detected.less_than(minimum):
        raise CLIVersionTooOld(
            "%s version %s is below minimum required %s -- please upgrade"
            % (agent_type, detected_version, min_raw))
