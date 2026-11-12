"""Overflow-safe delivery of long system prompts.

Why this module exists
----------------------
A process' command line has a hard size limit. On Windows ``CreateProcess``
caps the *whole* command line (executable + every argument + separators) at
32,767 UTF-16 code units; exceeding it fails with
``[WinError 206] The filename or extension is too long``. POSIX has an
analogous (much larger) ``ARG_MAX`` that also counts the environment block.

Several backends used to pass ``opts.system_prompt`` straight into argv
(``--append-system-prompt <whole prompt>``). A long system prompt -- easily
tens of thousands of characters for a translation/persona preamble -- blew the
Windows limit and every LLM call died before the CLI even started.

The fix, in order of preference:

1. **File hand-off** (lossless, preferred): write the prompt to a per-run temp
   file and pass the CLI's file-based flag (for the ``claude`` CLI:
   ``--append-system-prompt-file <path>``). argv then holds a short path.
   The caller deletes the file when the run finishes.
2. **stdin fold-in** (fallback, for CLIs with no file flag but a stdin frame):
   drop the flag and prepend the system prompt to the first user frame inside
   explicit delimiters. Lossy in the sense that the model sees it as user
   text rather than system text, so it is only used past the threshold.

Short prompts keep taking the plain inline flag: that is the historical
behaviour, it is what the frozen contract/golden argv expect, and it is well
under any platform limit.
"""

from __future__ import annotations

import os
import shutil
import tempfile

#: Longest ``system_prompt`` still passed inline as a single argv value.
#: Deliberately far below the ~32,767-char Windows command-line cap so that
#: the rest of argv (flags, model, cwd, mcp-config path) plus the environment
#: block can never push a normal run over the edge.
ARGV_SYSTEM_PROMPT_LIMIT = 8192

_TEMP_PREFIX = "agentrunner-sysprompt-"

#: Delimiters used by the stdin fallback (see module docstring, option 2).
SYSTEM_PROMPT_STDIN_HEADER = "<<<SYSTEM_PROMPT>>>"
SYSTEM_PROMPT_STDIN_FOOTER = "<<<END_SYSTEM_PROMPT>>>"


def system_prompt_fits_argv(text: str,
                            limit: int = ARGV_SYSTEM_PROMPT_LIMIT) -> bool:
    """True when ``text`` is short enough to stay a plain argv value."""
    return len(text or "") <= limit


def fits_argv(text: str, limit: int = ARGV_SYSTEM_PROMPT_LIMIT) -> bool:
    """True when ``text`` is short enough to stay a plain argv value.

    Generic counterpart of :func:`system_prompt_fits_argv` for backends that
    must size-check something other than ``opts.system_prompt`` -- notably the
    *user* prompt itself, which the ``agy`` backend passes as ``-p <prompt>``
    and must move to stdin once it grows past the same threshold.
    Same measurement (character count against the same default limit), so the
    two code paths cannot drift apart.
    """
    return len(text or "") <= limit


def write_system_prompt_to_temp(text: str) -> str:
    """Write ``text`` to a private temp file; returns its path.

    The caller must remove it via :func:`cleanup_system_prompt_temp` once the
    child process has exited (the CLI reads the file at startup, so deleting it
    any earlier is a race).
    """
    d = tempfile.mkdtemp(prefix=_TEMP_PREFIX)
    path = os.path.join(d, "system-prompt.txt")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def cleanup_system_prompt_temp(path: str) -> None:
    if not path:
        return
    d = os.path.dirname(path)
    if os.path.basename(d).startswith(_TEMP_PREFIX):
        shutil.rmtree(d, ignore_errors=True)
        return
    try:
        os.remove(path)
    except Exception:
        pass


def fold_system_prompt_into_prompt(prompt: str, system_prompt: str) -> str:
    """Prepend ``system_prompt`` to ``prompt`` inside explicit delimiters.

    Used by the stdin fallback for CLIs that accept a system prompt only as an
    argv value (no file flag) but do read a user frame on stdin.
    """
    if not system_prompt:
        return prompt
    return "%s\n%s\n%s\n\n%s" % (SYSTEM_PROMPT_STDIN_HEADER, system_prompt,
                                 SYSTEM_PROMPT_STDIN_FOOTER, prompt)
