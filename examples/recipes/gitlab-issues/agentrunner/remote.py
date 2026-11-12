"""遠端執行：透過 SSH 呼叫遠端主機上的 agentrunner CLI。

設計要點：**遠端只是另一種 transport。** `RemoteBackend` 實作與本機 backend
相同的介面，`execute()` 回傳同樣的 :class:`Session`，因此呼叫端程式碼完全不需
要改動——只是把 backend 換掉。

    本機 RemoteBackend.execute()
      └─ ssh host "agentrunner run --agent claude --output ndjson --stdin-json"
           ├─ stdin  ──► {"prompt": ..., "mcp_config": ...}
           └─ stdout ◄── NDJSON 事件流，逐行還原成 Message / Result

之所以可行，是因為 CLI 的 NDJSON 事件流本來就設計成語言無關的整合邊界。
遠端那支 `agentrunner` 是 Python 版或 Rust 版都無所謂，只要 NDJSON 欄位、
exit code 與旗標介面一致即可（見 docs/rust-rewrite-plan 的「共同憲法」）。

SSH 免費提供了認證、加密，以及行程生命週期綁定：連線中斷 → 遠端 stdin 關閉，
不會留下孤兒 agent 行程。
"""

from __future__ import annotations

import json
import shlex
import subprocess
import threading
from typing import Callable, Dict, List, Optional, Sequence

from .base import (
    Config, Diagnostic, ExecOptions, Message, MessageType, RunState, Session,
    StreamingRunner, TokenUsage, build_env, popen_platform_kwargs,
)
from ._version import parse_semver

# 遠端 CLI 至少要有這個版本（--stdin-json 與 NDJSON complete 事件由此版提供）
MIN_REMOTE_VERSION = "1.1.0"

# HTTP 客戶端看門狗的寬限秒數。伺服器端的 backend 自己也會逾時並回報一個
# 結構完整的 timeout 結果；若客戶端用同一個期限就會與之競態，搶先切斷串流、
# 把好好的 timeout 結果變成「連線中斷」。故客戶端只當後備，晚一點才動手。
HTTP_TIMEOUT_GRACE = 15.0


class RemoteVersionError(RuntimeError):
    """遠端 agentrunner 版本過舊或無法辨識。"""


def _default_transport(ssh_bin: str, ssh_args: Sequence[str], host: str):
    """回傳一個把遠端指令包成本機 argv 的函式。"""
    def build(remote_cmd: str) -> List[str]:
        return [ssh_bin, *ssh_args, host, remote_cmd]
    return build


class RemoteBackend:
    """在遠端主機上執行 agent，事件即時串流回本機。

    參數
    ----
    cfg          : Config（logger 沿用；executable_path 不使用）
    host         : ssh 目標，如 ``user@10.0.0.5``
    agent        : 遠端要驅動的 agent 類型（claude / codex / ...）
    remote_bin   : 遠端 agentrunner 執行檔名稱或絕對路徑
    ssh_bin      : 本機 ssh 執行檔
    ssh_args     : 額外 ssh 參數，如 ``("-p", "2222", "-i", "key")``
    transport    : 測試用；覆寫「如何把遠端指令變成本機 argv」
    check_version: 首次執行前是否做版本握手（預設開啟）
    """

    def __init__(self, cfg: Config, host: str = "", agent: str = "claude",
                 remote_bin: str = "agentrunner", ssh_bin: str = "ssh",
                 ssh_args: Sequence[str] = ("-o", "BatchMode=yes"),
                 transport: Optional[Callable[[str], List[str]]] = None,
                 check_version: bool = True) -> None:
        self.cfg = cfg
        self.host = host
        self.agent = agent
        self.remote_bin = remote_bin
        self._transport = transport or _default_transport(ssh_bin, ssh_args, host)
        self._check_version = check_version
        self._remote_version: Optional[str] = None
        self._version_lock = threading.Lock()

    # ── 版本握手 ────────────────────────────────────────────────

    def remote_version(self) -> str:
        """取得並快取遠端 agentrunner 版本（``agentrunner --version``）。"""
        with self._version_lock:
            if self._remote_version is not None:
                return self._remote_version
            argv = self._transport("%s --version" % shlex.quote(self.remote_bin))
            try:
                proc = subprocess.run(argv, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, timeout=30,
                                      **popen_platform_kwargs())
            except Exception as exc:                            # noqa: BLE001
                raise RemoteVersionError("無法連線遠端主機取得版本：%s" % exc)
            out = (proc.stdout or b"").decode("utf-8", "replace").strip()
            if proc.returncode != 0 or not out:
                err = (proc.stderr or b"").decode("utf-8", "replace").strip()
                raise RemoteVersionError(
                    "遠端未回報版本（exit=%s）：%s" % (proc.returncode, err or out))
            self._remote_version = out.split()[-1]
            return self._remote_version

    def _ensure_version(self) -> None:
        """版本過舊時明確報錯，而不是讓未知旗標造成神祕失敗。"""
        if not self._check_version:
            return
        ver = self.remote_version()
        try:
            ok = not parse_semver(ver).less_than(parse_semver(MIN_REMOTE_VERSION))
        except ValueError:
            raise RemoteVersionError("無法解析遠端版本字串：%r" % ver)
        if not ok:
            raise RemoteVersionError(
                "遠端 agentrunner %s 過舊，本機需要 >= %s（請升級遠端主機）"
                % (ver, MIN_REMOTE_VERSION))

    # ── 遠端指令組裝 ────────────────────────────────────────────

    def build_remote_command(self, opts: ExecOptions) -> str:
        """組出要在遠端 shell 執行的指令字串（已做 shell 跳脫）。

        注意：機密（mcp_config）走 stdin 的 JSON 封包，不放在命令列上，
        以免出現在遠端的 ``ps`` 輸出中。
        """
        parts = [shlex.quote(self.remote_bin), "run",
                 "--agent", shlex.quote(self.agent),
                 "--output", "ndjson", "--stdin-json"]
        if opts.cwd:
            parts += ["--cwd", shlex.quote(opts.cwd)]
        if opts.model:
            parts += ["--model", shlex.quote(opts.model)]
        if opts.thinking_level:
            parts += ["--effort", shlex.quote(opts.thinking_level)]
        if opts.system_prompt:
            parts += ["--system-prompt", shlex.quote(opts.system_prompt)]
        if opts.max_turns > 0:
            parts += ["--max-turns", str(int(opts.max_turns))]
        if opts.timeout and opts.timeout > 0:
            parts += ["--timeout", repr(float(opts.timeout))]
        if opts.resume_session_id:
            parts += ["--resume", shlex.quote(opts.resume_session_id)]
        for a in opts.custom_args or []:
            parts += ["--custom-arg", shlex.quote(a)]
        # 遠端不做互動審批：本機的 on_approval_request 需要雙向通道，
        # 第一版僅支援 auto / deny（見模組文件與 docs）。
        parts += ["--approve", "deny" if _rejects_everything(opts) else "auto"]
        return " ".join(parts)

    def build_stdin_payload(self, prompt: str, opts: ExecOptions) -> bytes:
        payload: Dict[str, object] = {"prompt": prompt}
        if opts.mcp_config:
            raw = opts.mcp_config
            try:
                payload["mcp_config"] = json.loads(
                    raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
            except Exception:                                   # noqa: BLE001
                payload["mcp_config"] = (raw.decode("utf-8", "replace")
                                         if isinstance(raw, (bytes, bytearray)) else raw)
        return (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")

    # ── 執行 ────────────────────────────────────────────────────

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        self._ensure_version()

        remote_cmd = self.build_remote_command(opts)
        argv = self._transport(remote_cmd)
        self.cfg.logger.info("remote execute", host=self.host or "(local transport)",
                             agent=self.agent, cmd=remote_cmd)

        runner = StreamingRunner(self.cfg, "remote:%s" % self.agent)
        parser = _NdjsonEventParser()

        def on_line(line: str, st: RunState, r: StreamingRunner) -> None:
            parser.feed(line, st, r)

        def on_finish(st: RunState, r: StreamingRunner) -> None:
            parser.finalize(st, r)

        return runner.run(
            argv=argv, env=build_env(self.cfg.env), cwd="",
            on_line=on_line, opts=opts, cancel=cancel,
            stdin_payload=self.build_stdin_payload(prompt, opts),
            keep_stdin_open=False, on_finish=on_finish,
        )


def _rejects_everything(opts: ExecOptions) -> bool:
    """本機設了審批 callback 時，遠端第一版採保守策略：一律拒絕。

    理由：互動審批需要雙向通道，SSH 雖然雙向但本版尚未實作回程協定。
    與其讓使用者以為審批生效、實際卻全部放行（安全假象），不如明確拒絕。
    """
    return getattr(opts, "on_approval_request", None) is not None


class _NdjsonEventParser:
    """把遠端 CLI 的 NDJSON 事件流還原成本機 Message / Result 狀態。"""

    def __init__(self) -> None:
        self._acc_text = ""          # NDJSON 的 generating 送的是累積文字
        self._saw_complete = False

    def feed(self, line: str, st: RunState, r: StreamingRunner) -> None:
        try:
            ev = json.loads(line)
        except Exception:                                       # noqa: BLE001
            return
        if not isinstance(ev, dict):
            return
        status = ev.get("status", "")

        if status == "analyzing":
            r.emit(Message(type=MessageType.STATUS, status="running"))
        elif status == "thinking":
            r.emit(Message(type=MessageType.THINKING, content=ev.get("response", "")))
        elif status == "generating":
            acc = ev.get("response", "") or ""
            delta = acc[len(self._acc_text):] if acc.startswith(self._acc_text) else acc
            self._acc_text = acc
            if delta:
                st.output.append(delta)
                r.emit(Message(type=MessageType.TEXT, content=delta))
        elif status == "querying":
            r.emit(Message(type=MessageType.TOOL_USE, tool=ev.get("tool", "") or "",
                           call_id=ev.get("call_id", "") or "", input=ev.get("input")))
        elif status == "tool_result":
            r.emit(Message(type=MessageType.TOOL_RESULT,
                           call_id=ev.get("call_id", "") or "",
                           output=ev.get("output", "") or ""))
        elif status == "error":
            r.emit(Message(type=MessageType.ERROR, content=ev.get("response", "")))
        elif status == "complete":
            self._apply_complete(ev, st, r)

    def _apply_complete(self, ev: dict, st: RunState, r: StreamingRunner) -> None:
        self._saw_complete = True
        st.output.clear()
        st.output.append(ev.get("response", "") or "")
        st.session_id = ev.get("session_id", "") or ""
        st.final_status = ev.get("agent_status", "completed") or "completed"
        st.final_error = ev.get("error", "") or ""
        for model, u in (ev.get("usage") or {}).items():
            st.usage[model] = TokenUsage(
                input_tokens=int(u.get("input_tokens", 0)),
                output_tokens=int(u.get("output_tokens", 0)),
                cache_read_tokens=int(u.get("cache_read_tokens", 0)),
                cache_write_tokens=int(u.get("cache_write_tokens", 0)))
        for d in (ev.get("diagnostics") or []):
            st.diagnostics.append(Diagnostic(
                code=d.get("code", ""), message=d.get("message", ""),
                severity=d.get("severity", "error"),
                raw_provider_message=d.get("raw_provider_message", "") or "",
                stderr_tail=d.get("stderr_tail", "") or ""))

    def finalize(self, st: RunState, r: StreamingRunner) -> None:
        """沒收到 complete 代表連線中斷或遠端崩潰——不可當成成功。"""
        if self._saw_complete:
            return
        if st.final_status == "completed":
            st.final_status = "failed"
            if not st.final_error:
                st.final_error = ("遠端未回傳 complete 事件："
                                  "連線中斷或遠端 agentrunner 異常結束")


# ══════════════════════════════════════════════════════════════════════
#  路徑二：HTTP（agentrunner serve）
# ══════════════════════════════════════════════════════════════════════


class HttpRemoteBackend:
    """透過 ``agentrunner serve`` 的 HTTP API 執行遠端 agent。

    與 SSH 版（:class:`RemoteBackend`）介面相同，但多支援**互動審批**——
    HTTP 提供獨立回程通道，因此 ``opts.on_approval_request`` 可以真正生效：
    伺服器把審批請求推進事件流，本機裁決後 POST 回去解除阻塞。

        backend = new_remote("http://10.0.0.5:8700", "claude", token="…")
    """

    def __init__(self, cfg: Config, base_url: str, agent: str = "claude",
                 token: str = "", connect_timeout: float = 30.0,
                 check_version: bool = True) -> None:
        self.cfg = cfg
        self.base_url = base_url.rstrip("/")
        self.agent = agent
        self.token = token
        self.connect_timeout = connect_timeout
        self._check_version = check_version
        self._remote_version: Optional[str] = None

    # ── 版本握手 ────────────────────────────────────────────────

    def remote_version(self) -> str:
        if self._remote_version is None:
            data = self._get_json("/health")
            self._remote_version = str(data.get("version", ""))
        return self._remote_version

    def _ensure_version(self) -> None:
        if not self._check_version:
            return
        ver = self.remote_version()
        try:
            ok = not parse_semver(ver).less_than(parse_semver(MIN_REMOTE_VERSION))
        except ValueError:
            raise RemoteVersionError("無法解析遠端版本字串：%r" % ver)
        if not ok:
            raise RemoteVersionError(
                "遠端 agentrunner %s 過舊，本機需要 >= %s" % (ver, MIN_REMOTE_VERSION))

    # ── HTTP 小工具（純標準函式庫）────────────────────────────

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json; charset=utf-8"}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    def _get_json(self, path: str) -> dict:
        import urllib.error
        import urllib.request
        req = urllib.request.Request(self.base_url + path, headers=self._headers())
        try:
            with urllib.request.urlopen(req, timeout=self.connect_timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RemoteVersionError("遠端回應 HTTP %s：%s"
                                     % (exc.code, exc.read().decode("utf-8", "replace")))
        except Exception as exc:                                # noqa: BLE001
            raise RemoteVersionError("無法連線遠端服務 %s：%s" % (self.base_url, exc))

    def _post_json(self, path: str, payload: dict) -> None:
        import urllib.request
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base_url + path, data=body,
                                     headers=self._headers(), method="POST")
        try:
            urllib.request.urlopen(req, timeout=self.connect_timeout).close()
        except Exception as exc:                                # noqa: BLE001
            self.cfg.logger.warn("remote post failed", path=path, error=str(exc))

    # ── 執行 ────────────────────────────────────────────────────

    def build_payload(self, prompt: str, opts: ExecOptions) -> dict:
        mcp = None
        if opts.mcp_config:
            raw = opts.mcp_config
            text = (raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw)
            try:
                mcp = json.loads(text)
            except Exception:                                   # noqa: BLE001
                mcp = text
        return {
            "agent": self.agent,
            "prompt": prompt,
            "options": {
                "cwd": opts.cwd, "model": opts.model,
                "thinking_level": opts.thinking_level,
                "system_prompt": opts.system_prompt,
                "max_turns": opts.max_turns, "timeout": opts.timeout,
                "resume_session_id": opts.resume_session_id,
                "custom_args": list(opts.custom_args or []),
                "capture_transcript": opts.capture_transcript,
                "mcp_config": mcp,
                # 只有本機設了 callback 才要求伺服器走互動審批
                "interactive_approval": opts.on_approval_request is not None,
            },
        }

    def execute(self, prompt: str, opts: ExecOptions,
                cancel: Optional[threading.Event] = None) -> Session:
        import urllib.request

        self._ensure_version()
        session = Session(capture_transcript=bool(opts.capture_transcript))
        payload = json.dumps(self.build_payload(prompt, opts),
                             ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.base_url + "/v1/run", data=payload,
                                     headers=self._headers(), method="POST")
        state = _HttpRunState()

        def pump() -> None:
            import time
            start = time.monotonic()
            try:
                with urllib.request.urlopen(req, timeout=None) as resp:
                    watchdog = _start_http_watchdog(self, state, cancel, opts, resp)
                    try:
                        for raw in resp:
                            line = raw.decode("utf-8", "replace").strip()
                            if line:
                                state.feed(line, session, self, opts)
                    finally:
                        watchdog.set()
            except Exception as exc:                            # noqa: BLE001
                state.transport_error = str(exc)
            finally:
                state.finish(session, int((time.monotonic() - start) * 1000), cancel)

        threading.Thread(target=pump, daemon=True).start()
        return session


class _HttpRunState:
    """解析伺服器事件流，並保存重建 Result 所需的狀態。"""

    def __init__(self) -> None:
        self.run_id = ""
        self.output: List[str] = []
        self.session_id = ""
        self.status = "completed"
        self.error = ""
        self.usage: Dict[str, TokenUsage] = {}
        self.diagnostics: List[Diagnostic] = []
        self.saw_complete = False
        self.transport_error = ""
        self.watchdog_timeout = False

    def feed(self, line: str, session: Session, backend, opts: ExecOptions) -> None:
        try:
            ev = json.loads(line)
        except Exception:                                       # noqa: BLE001
            return
        if not isinstance(ev, dict):
            return
        st = ev.get("status", "")

        if st == "accepted":
            self.run_id = ev.get("run_id", "") or ""
        elif st == "approval_request":
            self._answer_approval(ev, backend, opts)
        elif st == "thinking":
            session._emit(Message(type=MessageType.THINKING, content=ev.get("response", "")))
        elif st == "generating_delta":
            text = ev.get("response", "") or ""
            if text:
                self.output.append(text)
                session._emit(Message(type=MessageType.TEXT, content=text))
        elif st == "querying":
            session._emit(Message(type=MessageType.TOOL_USE, tool=ev.get("tool", "") or "",
                                  call_id=ev.get("call_id", "") or "", input=ev.get("input")))
        elif st == "tool_result":
            session._emit(Message(type=MessageType.TOOL_RESULT,
                                  call_id=ev.get("call_id", "") or "",
                                  output=ev.get("output", "") or ""))
        elif st == "status":
            session._emit(Message(type=MessageType.STATUS,
                                  status=ev.get("response", "") or "",
                                  session_id=ev.get("session_id", "") or ""))
        elif st == "error":
            session._emit(Message(type=MessageType.ERROR, content=ev.get("response", "")))
        elif st == "complete":
            self._apply_complete(ev)

    def _answer_approval(self, ev: dict, backend, opts: ExecOptions) -> None:
        """本機裁決後 POST 回伺服器——這是 SSH 版沒有的回程通道。"""
        from .base import ApprovalRequest, resolve_approval
        cb = opts.on_approval_request
        decision = "approved"
        comment = ""
        if cb is not None:
            try:
                d = cb(ApprovalRequest(
                    harness=backend.agent, tool_name=ev.get("tool", "") or "",
                    tool_input=ev.get("input") or {}, session_id=self.session_id,
                    content_preview=ev.get("preview", "") or ""))
                if d is not None and getattr(d, "decision", "approved") != "approved":
                    decision, comment = "rejected", getattr(d, "comment", "")
            except Exception as exc:                            # noqa: BLE001
                backend.cfg.logger.warn("approval callback error; 放行", error=str(exc))
        backend._post_json("/v1/approve", {
            "run_id": ev.get("run_id") or self.run_id,
            "request_id": ev.get("request_id", ""),
            "decision": decision, "comment": comment})

    def _apply_complete(self, ev: dict) -> None:
        self.saw_complete = True
        self.output = [ev.get("response", "") or ""]
        self.session_id = ev.get("session_id", "") or ""
        self.status = ev.get("agent_status", "completed") or "completed"
        self.error = ev.get("error", "") or ""
        for model, u in (ev.get("usage") or {}).items():
            self.usage[model] = TokenUsage(
                input_tokens=int(u.get("input_tokens", 0)),
                output_tokens=int(u.get("output_tokens", 0)),
                cache_read_tokens=int(u.get("cache_read_tokens", 0)),
                cache_write_tokens=int(u.get("cache_write_tokens", 0)))
        for d in (ev.get("diagnostics") or []):
            self.diagnostics.append(Diagnostic(
                code=d.get("code", ""), message=d.get("message", ""),
                severity=d.get("severity", "error"),
                raw_provider_message=d.get("raw_provider_message", "") or "",
                stderr_tail=d.get("stderr_tail", "") or ""))

    def finish(self, session: Session, duration_ms: int,
               cancel: Optional[threading.Event]) -> None:
        from .base import Result, diagnostic_for_status
        if not self.saw_complete:
            # 沒有 complete 事件 = 連線中斷或伺服器異常，不得當成成功
            if cancel is not None and cancel.is_set():
                self.status, self.error = "aborted", "本機取消"
            elif self.watchdog_timeout:
                self.status = "timeout"
                self.error = "遠端逾時未回應（含 %ss 寬限）" % HTTP_TIMEOUT_GRACE
            else:
                self.status = "failed"
                self.error = self.transport_error or (
                    "遠端未回傳 complete 事件：連線中斷或伺服器異常")
        result = Result(status=self.status, output="".join(self.output),
                        error=self.error, duration_ms=duration_ms,
                        session_id=self.session_id, usage=self.usage,
                        diagnostics=self.diagnostics)
        if not result.diagnostics:
            d = diagnostic_for_status(result.status, result.error)
            if d is not None:
                result.diagnostics = [d]
        session._set_result(result)
        session._close_messages()


def _start_http_watchdog(backend, state: "_HttpRunState",
                         cancel: Optional[threading.Event],
                         opts: ExecOptions, resp) -> threading.Event:
    """監看本機 cancel / 逾時，透過 POST /v1/cancel 通知伺服器停止 agent。"""
    stop = threading.Event()

    def watch():
        import time
        deadline = ((time.monotonic() + opts.timeout + HTTP_TIMEOUT_GRACE)
                    if opts.timeout and opts.timeout > 0 else None)
        while not stop.wait(0.2):
            hit_cancel = cancel is not None and cancel.is_set()
            hit_timeout = deadline is not None and time.monotonic() > deadline
            if hit_cancel or hit_timeout:
                if hit_timeout:
                    state.watchdog_timeout = True
                if state.run_id:
                    backend._post_json("/v1/cancel", {"run_id": state.run_id})
                try:
                    resp.close()          # 中止串流讀取
                except Exception:
                    pass
                return

    threading.Thread(target=watch, daemon=True).start()
    return stop
