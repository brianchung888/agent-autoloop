"""Antigravity (Google `agy`) CLI backend (port of antigravity.go).

Spawns Google's Antigravity CLI in one-shot print mode
(``agy -p <prompt> --dangerously-skip-permissions --print-timeout <d>
--log-file <tmp> [--conversation <id>] [--add-dir <cwd>]``). Unlike
claude/codex/cursor/gemini, agy exposes NO structured event stream: stdout is
plain assistant text (intermediate "I will run X" narration and the final
reply, interleaved). The backend therefore streams each stdout line as a
``MessageType.TEXT`` event and accumulates the same text (newline-joined,
blank lines preserved) as the final ``Result.output``.

Two agy print-mode quirks are handled the way the Go original handles them:

* Session resumption uses ``--conversation <id>``. The conversation UUID is
  never printed to stdout; it is recovered by routing ``--log-file`` to a temp
  file and scanning its glog lines for the ``conversation=<uuid>`` token.
* A long user prompt cannot travel in argv: Windows ``CreateProcess`` caps the
  whole command line at 32,767 UTF-16 units and fails with ``[WinError 206]``,
  which killed every run whose prompt carried a folded-in system prompt. Past
  ``_promptfile.ARGV_SYSTEM_PROMPT_LIMIT`` the backend therefore drops the
  inline prompt and streams it on stdin instead (see
  :func:`build_antigravity_args` / :func:`build_antigravity_input`).
* agy 1.0.14 print mode can (a) hit its own ``--print-timeout`` yet exit 0
  ("Print mode: timed out after N polls"), (b) surface a terminal provider
  error only in the log ("agent executor error: ..."), or (c) finish a turn
  (tools run, reply produced) while emitting ZERO bytes to stdout. Each of
  these would otherwise reach the daemon as a blank-but-"completed" run, so the
  backend promotes (a)/(b) to timeout/failed and, for (c), recovers the
  assistant text from agy's per-conversation ``transcript.jsonl``.

The Go original streamed via a goroutine + channels; here a background thread
reads stdout and pushes ``Message`` objects onto the ``Session`` queue while the
caller blocks on ``Session.result()`` -- the same producer/consumer shape.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Dict, List, Optional

from ._promptfile import fits_argv
from .base import (
    BlockedArgMode, Config, ExecOptions, Logger, Message, MessageType, Result,
    Session, StderrTail, TokenUsage, build_env, filter_custom_args,
    popen_platform_kwargs, signal_process_group, with_agent_stderr,
)

# -- Timeout resolution / formatting -----------------------------------

# --print-timeout value used when the daemon configures no wall-clock cap
# (timeout <= 0). agy's --print-timeout has no "disabled" sentinel and falls
# back to a 5-minute default when omitted, so "no cap" must be a value large
# enough that agy's own guillotine never fires before the daemon's idle/tool
# watchdogs reclaim a genuinely stuck run. 24h is effectively unbounded for any
# real turn while still being a finite duration agy can parse. (seconds)
ANTIGRAVITY_NO_CAP_PRINT_TIMEOUT = 24 * 60 * 60


def antigravity_print_timeout(timeout: float) -> float:
    """Resolve the wall-clock budget handed to agy's ``--print-timeout``: the
    daemon's configured cap when positive, else the no-cap sentinel. Single
    source of truth shared by :func:`build_antigravity_args` (sets the flag) and
    :meth:`AntigravityBackend.execute` (labels a print-mode timeout)."""
    if timeout and timeout > 0:
        return timeout
    return ANTIGRAVITY_NO_CAP_PRINT_TIMEOUT


def _go_duration_string(seconds: float) -> str:
    """Render ``seconds`` in the ``<n>h<n>m<n>s`` shape agy's CLI accepts
    (Go ``time.Duration.String()`` for durations >= 1s, e.g. "20m0s",
    "1h30m0s", "24h0m0s")."""
    total = float(seconds)
    neg = total < 0
    if neg:
        total = -total
    hours = int(total // 3600)
    rem = total - hours * 3600
    minutes = int(rem // 60)
    secs = rem - minutes * 60

    def fmt_secs(s: float) -> str:
        if s == int(s):
            return str(int(s))
        return ("%.9f" % s).rstrip("0").rstrip(".")

    if hours > 0:
        out = "%dh%dm%ss" % (hours, minutes, fmt_secs(secs))
    elif minutes > 0:
        out = "%dm%ss" % (minutes, fmt_secs(secs))
    else:
        out = "%ss" % fmt_secs(secs)
    return ("-" + out) if neg else out


def antigravity_format_timeout(seconds: float) -> str:
    """Render a duration for ``--print-timeout``. Sub-second values round up to
    1s so the CLI doesn't reject the flag."""
    if seconds < 1:
        seconds = 1
    return _go_duration_string(seconds)


# -- Log-file scanners -------------------------------------------------

# Matches the glog line printmode.go writes when the CLI dispatches the user's
# message -- the only place in the log that reliably surfaces the conversation
# UUID for both fresh and resumed turns. Example:
#   I0528 13:36:23.318877 73304 printmode.go:130] Print mode:
#   conversation=b8b263a4-4b2f-4339-acc9-78b248e2b606, sending message
_ANTIGRAVITY_CONVERSATION_ID_RE = re.compile(
    r"conversation=([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}"
    r"-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)

# Matches the glog line agy writes when the print-mode wall-clock budget
# elapses before a final response. agy then prints "Error: timed out waiting
# for response" to stdout and EXITS 0. Example:
#   E0623 17:17:59.017212 65926 printmode.go:289] Print mode: timed out after
#   100 polls (printed=3)
_ANTIGRAVITY_PRINT_TIMEOUT_RE = re.compile(r"Print mode: timed out after \d+ polls")

_ANTIGRAVITY_PROVIDER_ERROR_RE = re.compile(r"agent executor error:\s*(.+)")

# Matches the glog line agy writes at startup naming its CLI app data directory
# -- the root under which per-conversation transcripts live. Example:
#   I0630 14:19:40.582492 88197 common.go:156] CLI app data directory:
#   /Users/me/.gemini/antigravity-cli
_ANTIGRAVITY_APP_DATA_DIR_RE = re.compile(r"CLI app data directory:\s*(.+)")


def _read_log_text(log_path: str) -> str:
    if not log_path:
        return ""
    try:
        with open(log_path, "rb") as fh:
            return fh.read().decode("utf-8", "replace")
    except OSError:
        return ""


def antigravity_print_timed_out(log_path: str) -> bool:
    """Whether the per-run log shows agy hit its own print-mode timeout.
    Best-effort: False if the log is missing or the marker format changes."""
    return bool(_ANTIGRAVITY_PRINT_TIMEOUT_RE.search(_read_log_text(log_path)))


def antigravity_provider_error(log_path: str) -> str:
    """Extract terminal upstream/model errors agy logs but does not necessarily
    print to stdout or reflect in its exit code. Returns the last match."""
    matches = _ANTIGRAVITY_PROVIDER_ERROR_RE.findall(_read_log_text(log_path))
    if not matches:
        return ""
    return matches[-1].strip()


def read_antigravity_conversation_id(log_path: str) -> str:
    """Scan the per-run log for the conversation UUID. The CLI logs it
    repeatedly; any non-empty UUID resolves to the same conversation, so the
    last match wins. Best-effort: "" if missing or the format changes."""
    matches = _ANTIGRAVITY_CONVERSATION_ID_RE.findall(_read_log_text(log_path))
    if not matches:
        return ""
    return matches[-1]


def read_antigravity_app_data_dir(log_path: str) -> str:
    """Extract agy's CLI app data directory from the per-run log. Best-effort:
    "" if the log is missing or the marker format changes."""
    m = _ANTIGRAVITY_APP_DATA_DIR_RE.search(_read_log_text(log_path))
    if not m:
        return ""
    return m.group(1).strip()


def read_antigravity_transcript_output(log_path: str, conversation_id: str) -> str:
    """Recover the current turn's assistant text from agy's per-conversation
    transcript when stdout carried nothing (MUL-3726, #4595). The full reply is
    durably written to::

        <appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl

    as PLANNER_RESPONSE / source=MODEL records. The transcript ACCUMULATES
    across resumed turns, so we reset on every USER_INPUT boundary and keep only
    the model text that follows the last one, requiring status=DONE to skip
    streaming/partial records. Content is JSON null for tool-only steps (skipped)
    and a non-string value is skipped. Best-effort: "" if the app data dir or
    conversation id is unknown, the transcript is missing, or it holds no model
    text for the current turn."""
    if not log_path or not conversation_id:
        return ""
    app_data_dir = read_antigravity_app_data_dir(log_path)
    if not app_data_dir:
        return ""
    transcript_path = os.path.join(
        app_data_dir, "brain", conversation_id,
        ".system_generated", "logs", "transcript.jsonl",
    )
    try:
        fh = open(transcript_path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return ""

    parts: List[str] = []
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if not isinstance(rec, dict):
                continue
            if rec.get("type") == "USER_INPUT":
                # New turn boundary: drop anything collected for prior turns so a
                # resumed conversation yields only the current turn's reply.
                parts = []
                continue
            if (rec.get("type") != "PLANNER_RESPONSE"
                    or rec.get("source") != "MODEL"
                    or rec.get("status") != "DONE"):
                continue
            content = rec.get("content")
            # null (tool-only step) -> not a str -> skipped; object -> skipped.
            if not isinstance(content, str):
                continue
            if content.strip() != "":
                parts.append(content)
    return "\n\n".join(parts)


# -- stream-json output decoding ---------------------------------------
#
# Only reached on the long-prompt path: agy refuses --input-format stream-json
# unless --output-format is stream-json too, so moving the prompt to stdin also
# replaces plain-text stdout with the NDJSON event stream sampled in
# build_antigravity_input's docstring. Short prompts keep the plain-text reader.


def antigravity_stream_event_text(event: dict) -> str:
    """Assistant text carried by one agy stream-json event ("" when none).

    Text arrives as ``text_delta`` fragments on ``step_update`` events whose
    ``step_type`` is ``agent_response`` -- partial chunks, not lines, so they
    concatenate into the reply exactly as emitted. Tool/user_input steps and
    every other event carry no assistant text."""
    if not isinstance(event, dict) or event.get("event") != "step_update":
        return ""
    step = event.get("step_update")
    if not isinstance(step, dict) or step.get("step_type") != "agent_response":
        return ""
    delta = step.get("text_delta")
    return delta if isinstance(delta, str) else ""


def antigravity_stream_result(event: dict) -> Optional[dict]:
    """The ``result`` payload of a terminal agy stream-json event, else None.

    Shape: ``{"conversation_id":..., "status":"SUCCESS"|"ERROR",
    "response":<full reply>, "error":..., "finished_reason":...}``. ``response``
    is authoritative for the turn's final text (the deltas are a prefix of it
    when agy streams, and empty when it does not)."""
    if not isinstance(event, dict) or event.get("event") != "result":
        return None
    result = event.get("result")
    return result if isinstance(result, dict) else None


def antigravity_stream_conversation_id(event: dict) -> str:
    """Conversation UUID from any agy stream-json event that names one.

    stream-json mode reports it directly (``{"event":"init",
    "conversation_id":...}`` and on every later event), so resumption no longer
    depends on scraping ``--log-file`` -- the log scan stays the fallback."""
    if not isinstance(event, dict):
        return ""
    cid = event.get("conversation_id")
    if isinstance(cid, str) and cid:
        return cid
    for key in ("init", "step_update", "result"):
        payload = event.get(key)
        if isinstance(payload, dict):
            cid = payload.get("conversation_id")
            if isinstance(cid, str) and cid:
                return cid
    return ""


# -- Argument construction --------------------------------------------

# Flags hardcoded by the daemon that user custom_args must not override.
# Overriding these would break non-interactive operation or the daemon's
# session-resume bookkeeping.
_ANTIGRAVITY_BLOCKED_ARGS: Dict[str, BlockedArgMode] = {
    "-p": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--print": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--prompt": BlockedArgMode.BLOCKED_WITH_VALUE,
    "-i": BlockedArgMode.BLOCKED_STANDALONE,  # interactive mode requires a TTY
    "--prompt-interactive": BlockedArgMode.BLOCKED_STANDALONE,
    "-c": BlockedArgMode.BLOCKED_STANDALONE,  # resume via --conversation
    "--continue": BlockedArgMode.BLOCKED_STANDALONE,
    "--conversation": BlockedArgMode.BLOCKED_WITH_VALUE,  # via ResumeSessionID
    "--model": BlockedArgMode.BLOCKED_WITH_VALUE,  # via ExecOptions.model
    "--print-timeout": BlockedArgMode.BLOCKED_WITH_VALUE,
    "--dangerously-skip-permissions": BlockedArgMode.BLOCKED_STANDALONE,
    "--log-file": BlockedArgMode.BLOCKED_WITH_VALUE,  # daemon owns it
    "--settings": BlockedArgMode.BLOCKED_WITH_VALUE,  # agy rejects it
}


# Single argv token that gives agy's -p/--print an EMPTY value. agy parses -p
# as a string flag with hand-rolled diagnostics: a bare "-p" swallows the next
# token as the prompt ("-p took \"--input-format\" as its prompt ..." -> exit 2)
# and the CLI itself tells you to "attach the prompt to the flag (-p='...')".
# "-p=" is the attached-but-empty form: print mode on, no inline prompt, the
# prompt arriving on stdin instead.
ANTIGRAVITY_EMPTY_PRINT_FLAG = "-p="


def antigravity_prompt_fits_argv(prompt: str) -> bool:
    """Whether ``prompt`` is short enough to ride in argv as ``-p <prompt>``.

    Same threshold and measurement as the long-system-prompt handling in
    :mod:`agentrunner._promptfile` (``ARGV_SYSTEM_PROMPT_LIMIT`` = 8192
    characters), so neither path can overflow the OS command-line cap while the
    other still thinks it is safe."""
    return fits_argv(prompt)


def build_antigravity_input(prompt: str) -> bytes:
    """Encode ``prompt`` as the single NDJSON user frame agy reads from stdin
    under ``--input-format stream-json``.

    Format verified against agy on 2026-11-10 (``agy --help``: "stream-json
    reads one NDJSON message per line from stdin and runs a turn for each; it
    requires --output-format stream-json")::

        echo '{"event":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with exactly: PONG-ARRAY"}]}}' \
          | agy --input-format stream-json --output-format stream-json \
                --dangerously-skip-permissions --print-timeout 500s -p=

        {"event":"init","conversation_id":"578f1256-...","init":{...}}
        {"event":"step_update","step_update":{...,"step_type":"user_input","state":"DONE"}}
        {"event":"step_update","step_update":{...,"step_type":"agent_response","state":"ACTIVE","text_delta":"PONG-ARRAY"}}
        {"event":"step_update","step_update":{...,"step_type":"agent_response","state":"DONE","text_delta":"\\n","usage":{...}}}
        {"event":"result","result":{"conversation_id":"578f1256-...","status":"SUCCESS","response":"PONG-ARRAY\\n",...}}

    Notes from that experiment, all load-bearing:

    * The envelope key is ``event``, not ``type`` (a Claude-shaped
      ``{"type":"user",...}`` frame is rejected with ``stream input message is
      missing the "event" field``, and an unknown event name only warns:
      ``ignoring unsupported stream input message event "..."``).
    * ``content`` accepts BOTH the Claude-compatible block list used here and a
      plain string (``{"role":"user","content":"..."}``); both produced the
      correct reply. The block list is kept so the frame matches the shape the
      other stdin-fed backends build.
    * agy runs exactly one turn and exits once stdin reaches EOF, so the writer
      closes stdin right after the frame (no ``keep_stdin_open``).
    """
    payload = {
        "event": "user",
        "message": {"role": "user",
                    "content": [{"type": "text", "text": prompt}]},
    }
    return (json.dumps(payload) + "\n").encode("utf-8")


def build_antigravity_args(prompt: str, log_path: str, timeout: float,
                           opts: ExecOptions, logger: Logger) -> List[str]:
    """Assemble the argv for a daemon-compatible one-shot agy invocation::

        agy -p <prompt> --dangerously-skip-permissions [--model <display name>]
            --print-timeout <duration> --log-file <tmp>
            [--conversation <id>] [--add-dir <cwd>]

    opts.model is the exact human display string ``agy models`` prints (e.g.
    "Claude Opus 4.6 (Thinking)"), passed verbatim as a single arg. agy exposes
    no --system-prompt; runtime instructions are delivered via AGENTS.md in the
    task workdir. --print-timeout is ALWAYS passed (it defaults to 5m when
    omitted, silently guillotining long turns -- MUL-3570).

    Long prompts never enter argv. Past
    :func:`antigravity_prompt_fits_argv` (8192 chars -- a folded-in system
    prompt alone clears that easily) the inline ``-p <prompt>`` pair is
    replaced by::

        agy -p= --input-format stream-json --output-format stream-json ...

    and the prompt is handed over as one NDJSON frame on stdin
    (:func:`build_antigravity_input`); otherwise the whole command line blows
    the 32,767-unit Windows ``CreateProcess`` cap and the run dies with
    ``[WinError 206] The filename or extension is too long`` before agy starts.
    Short prompts keep the byte-identical historical argv (and the plain-text
    stdout contract that goes with it)."""
    if antigravity_prompt_fits_argv(prompt):
        args: List[str] = [
            "-p", prompt,
            "--dangerously-skip-permissions",
        ]
    else:
        logger.info("agy: long prompt moved to stdin (stream-json) to stay "
                    "under the OS command-line limit", chars=len(prompt))
        args = [
            ANTIGRAVITY_EMPTY_PRINT_FLAG,
            # agy REQUIRES stream-json output whenever input is stream-json.
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--dangerously-skip-permissions",
        ]
    if opts.model:
        args += ["--model", opts.model]
    args += ["--print-timeout",
             antigravity_format_timeout(antigravity_print_timeout(timeout))]
    args += ["--log-file", log_path]
    if opts.resume_session_id:
        args += ["--conversation", opts.resume_session_id]
    if opts.cwd:
        args += ["--add-dir", os.path.normpath(opts.cwd)]
    args += filter_custom_args(opts.extra_args, _ANTIGRAVITY_BLOCKED_ARGS, logger)
    args += filter_custom_args(opts.custom_args, _ANTIGRAVITY_BLOCKED_ARGS, logger)
    return args


# -- Backend -----------------------------------------------------------


class AntigravityBackend:
    """Backend implementation for the Antigravity (`agy`) CLI."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        logger = self.cfg.logger
        exec_path = self.cfg.executable_path or "agy"
        if shutil.which(exec_path) is None and not os.path.isabs(exec_path):
            raise FileNotFoundError("agy executable not found at %r" % exec_path)

        timeout = opts.timeout

        # Route --log-file to a temp file so we can recover the conversation id,
        # print-timeout / provider markers, and (if stdout is empty) the
        # transcript. Removed when the run finishes.
        fd, log_path = tempfile.mkstemp(prefix="multica-agy-log-", suffix=".log")
        os.close(fd)

        args = build_antigravity_args(prompt, log_path, timeout, opts, logger)
        env = build_env(self.cfg.env)
        argv = [exec_path] + args

        # Long prompt -> argv carries no prompt and agy speaks stream-json on
        # both ends; the prompt goes in as one NDJSON frame on stdin.
        stream_mode = not antigravity_prompt_fits_argv(prompt)
        stdin_payload = build_antigravity_input(prompt) if stream_mode else None

        session = Session(capture_transcript=bool(getattr(opts, "capture_transcript", False)))
        stderr_tail = StderrTail(
            inner=lambda b: logger.debug(
                "[agy:stderr] %s" % b.decode("utf-8", "replace").rstrip())
        )

        popen_kw = popen_platform_kwargs()
        logger.info("agent command", exec=exec_path, args=args)
        try:
            proc = subprocess.Popen(
                argv, cwd=opts.cwd or None, env=env,
                stdin=subprocess.PIPE if stream_mode else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, bufsize=0, **popen_kw,
            )
        except Exception:
            try:
                os.remove(log_path)
            except OSError:
                pass
            raise

        logger.info("agy started", pid=proc.pid, cwd=opts.cwd, model=opts.model)

        def _drain_stderr() -> None:
            assert proc.stderr is not None
            for chunk in iter(lambda: proc.stderr.readline(), b""):
                stderr_tail.write(chunk)

        threading.Thread(target=_drain_stderr, daemon=True).start()

        # Hand the prompt over and close stdin: agy runs one turn per NDJSON
        # line and finishes the run at EOF.
        stream_state: Dict[str, object] = {"result": None, "stdin_error": ""}

        def _write_stdin() -> None:
            if proc.stdin is None:
                return
            try:
                if stdin_payload is not None:
                    proc.stdin.write(stdin_payload)
                    proc.stdin.flush()
            except Exception as exc:  # noqa: BLE001
                logger.warn("agy: stdin write failed", error=str(exc))
                stream_state["stdin_error"] = "write agy input: %s" % exc
            finally:
                try:
                    proc.stdin.close()
                except Exception:
                    pass

        if stream_mode:
            threading.Thread(target=_write_stdin, daemon=True).start()

        def _supervise() -> None:
            start = time.monotonic()
            timed_out = {"v": False}
            aborted = {"v": False}
            deadline = start + timeout if timeout and timeout > 0 else None
            stop_watch = threading.Event()

            def _watch() -> None:
                while not stop_watch.wait(0.1):
                    if proc.poll() is not None:
                        return
                    if deadline is not None and time.monotonic() > deadline:
                        timed_out["v"] = True
                        signal_process_group(proc)
                        _close_stdout()
                        return
                    if cancel is not None and cancel.is_set():
                        aborted["v"] = True
                        signal_process_group(proc)
                        _close_stdout()
                        return

            def _close_stdout() -> None:
                try:
                    if proc.stdout is not None:
                        proc.stdout.close()
                except Exception:
                    pass

            threading.Thread(target=_watch, daemon=True).start()

            session._emit(Message(type=MessageType.STATUS, status="running"))

            # Stream stdout line-by-line. Every line (including blank ones) is
            # accumulated into output, newline-joined; only non-blank lines are
            # emitted as MessageText events (mirrors antigravity.go).
            output_parts: List[str] = []
            stream_session_id = {"v": ""}
            assert proc.stdout is not None
            try:
                for raw in proc.stdout:
                    line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
                    if line.endswith("\n"):
                        line = line[:-1]
                    if line.endswith("\r"):
                        line = line[:-1]
                    if stream_mode:
                        # NDJSON event stream: decode, stream text deltas, and
                        # keep the terminal result for the status mapping below.
                        if line.strip() == "":
                            continue
                        try:
                            event = json.loads(line)
                        except Exception:
                            # agy also writes human-readable notices (e.g.
                            # "[agy] print timeout after ...") to stdout.
                            logger.debug("agy non-JSON stdout line", line=line)
                            continue
                        cid = antigravity_stream_conversation_id(event)
                        if cid:
                            stream_session_id["v"] = cid
                        result_payload = antigravity_stream_result(event)
                        if result_payload is not None:
                            stream_state["result"] = result_payload
                            continue
                        text = antigravity_stream_event_text(event)
                        if text:
                            output_parts.append(text)
                            session._emit(Message(type=MessageType.TEXT, content=text))
                        continue
                    if output_parts:
                        output_parts.append("\n")
                    output_parts.append(line)
                    if line.strip() != "":
                        session._emit(Message(type=MessageType.TEXT, content=line))
            except Exception as exc:  # noqa: BLE001
                logger.warn("agy stdout scanner error", err=str(exc))
            finally:
                stop_watch.set()

            proc.wait()
            duration_ms = int((time.monotonic() - start) * 1000)

            # stream-json names the conversation on every event; the log scan
            # stays the fallback (and the only source in plain-text mode).
            session_id = stream_session_id["v"] or read_antigravity_conversation_id(log_path)

            stream_result = stream_state["result"]
            if not isinstance(stream_result, dict):
                stream_result = {}
            stream_finished = str(stream_result.get("finished_reason") or "")
            stream_failed = str(stream_result.get("status") or "") == "ERROR"

            final_status = "completed"
            final_error = ""
            if timed_out["v"]:
                final_status = "timeout"
                final_error = "agy timed out after %s" % _go_duration_string(timeout)
            elif aborted["v"]:
                final_status = "aborted"
                final_error = "execution cancelled"
            elif stream_finished == "print_timeout":
                # stream-json spells the print-mode guillotine out in its
                # terminal event (and exits non-zero); surface it as a timeout
                # rather than a generic exit-code failure.
                final_status = "timeout"
                final_error = (
                    "agy --print-timeout elapsed after %s waiting for the agent "
                    "response; the response is partial"
                    % _go_duration_string(antigravity_print_timeout(timeout))
                )
            elif stream_failed:
                final_status = "failed"
                final_error = "agy error: %s" % (
                    str(stream_result.get("error") or "").strip()
                    or "status ERROR with no message")
            elif proc.returncode not in (0, None):
                final_status = "failed"
                final_error = "agy exited with error: exit status %s" % proc.returncode
            elif stream_state["stdin_error"]:
                final_status = "failed"
                final_error = str(stream_state["stdin_error"])
            elif antigravity_print_timed_out(log_path):
                # agy hit its own --print-timeout: printed a timeout line and
                # EXITED 0, so neither the deadline nor the exit code tripped.
                # Surface it as a real timeout instead of a truncated success
                # the user can't distinguish from a finished task (MUL-3570).
                final_status = "timeout"
                final_error = (
                    "agy --print-timeout elapsed after %s waiting for the agent "
                    "response; a long-running command likely outlived the print "
                    "timeout" % _go_duration_string(antigravity_print_timeout(timeout))
                )
            else:
                provider_err = antigravity_provider_error(log_path)
                if provider_err:
                    # Terminal model/provider failure surfaced only in the log
                    # while exiting 0 with empty stdout; without promoting it the
                    # daemon records a failed turn as a blank success.
                    final_status = "failed"
                    final_error = "agy provider error: %s" % provider_err

            if final_error:
                final_error = with_agent_stderr(final_error, "agy", stderr_tail.tail())

            final_output = "".join(output_parts)
            # The terminal event's "response" is the authoritative full reply
            # (the streamed deltas are a prefix of it, and empty when agy chose
            # not to stream), so it wins whenever present.
            stream_response = stream_result.get("response")
            if isinstance(stream_response, str) and stream_response.strip() != "":
                if stream_response != final_output:
                    if final_output.strip() == "":
                        session._emit(Message(type=MessageType.TEXT,
                                              content=stream_response))
                    final_output = stream_response
            if final_status == "completed" and final_output.strip() == "":
                # agy 1.0.14 print mode can finish a turn (tools executed, reply
                # produced) without writing anything to stdout, leaving a blank
                # but "completed" run none of the guards above catch (MUL-3726).
                # Recover the assistant text agy persisted to its transcript and
                # emit it as a MessageText event so the transcript catches up.
                recovered = read_antigravity_transcript_output(log_path, session_id)
                if recovered:
                    final_output = recovered
                    session._emit(Message(type=MessageType.TEXT, content=recovered))
                    logger.info("agy recovered empty stdout from transcript",
                                bytes=len(recovered))

            logger.info("agy finished", pid=proc.pid, status=final_status,
                        duration_ms=duration_ms)

            session._set_result(Result(
                status=final_status,
                output=final_output,
                error=final_error,
                duration_ms=duration_ms,
                session_id=session_id,
                # agy's plain-text print mode surfaces no per-turn token usage;
                # leave usage empty rather than report misleading zeros. (Its
                # stream-json events DO carry a usage block, but it is keyed by
                # nothing resembling a model id and would only appear for long
                # prompts, so reporting it would make usage path-dependent.)
                usage={},
            ))
            session._close_messages()

            try:
                os.remove(log_path)
            except OSError:
                pass

        threading.Thread(target=_supervise, daemon=True).start()
        return session
