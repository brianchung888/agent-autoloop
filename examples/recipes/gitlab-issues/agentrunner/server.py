"""``agentrunner serve`` —— 輕量常駐 HTTP 服務。

與路徑一（SSH）的取捨：不需要遠端 shell 帳號、可長連線重用，代價是要自己處理
認證與傳輸安全。**但它換來一個 SSH 版做不到的能力：遠端互動審批。**
HTTP 提供了獨立的回程通道，因此工具核准可以由本機的人即時裁決：

    client                                   server
      │  POST /v1/run  ─────────────────────►  spawn agent
      │  ◄──── NDJSON 事件流（chunked）
      │  ◄──── {"status":"approval_request","request_id":…}
      │  POST /v1/approve {request_id, decision} ──►  解除阻塞，回覆 agent
      │  ◄──── 事件繼續流

端點
----
``GET  /health``       健康檢查與版本（免認證，供 LB 探測）
``GET  /v1/agents``    支援的 agent 清單
``POST /v1/run``       執行；回應為 NDJSON 事件串流
``POST /v1/approve``   回覆一筆待審批
``POST /v1/cancel``    取消執行中的任務

安全性
------
此服務等同**開放遠端執行任意指令**，因此：

* 預設只綁 ``127.0.0.1``；要對外請自行評估並明確指定 ``--host``。
* 一律需要 bearer token（未提供時自動產生並印出）。
* 不內建 TLS——請放在反向代理（nginx/Caddy）後面終止 TLS。
"""

from __future__ import annotations

import json
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple

from . import SUPPORTED_TYPES, Config, ExecOptions, Logger, __version__, new
from .base import ApprovalDecision, MessageType

# 等待客戶端回覆審批的預設上限（秒）；逾時採保守策略：拒絕。
DEFAULT_APPROVAL_TIMEOUT = 300.0


class _PendingApproval:
    def __init__(self) -> None:
        self.event = threading.Event()
        self.decision: Optional[ApprovalDecision] = None


class RunHandle:
    """一次執行的伺服器端狀態。"""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.cancel = threading.Event()
        self._approvals: Dict[str, _PendingApproval] = {}
        self._lock = threading.Lock()

    def new_approval(self) -> Tuple[str, _PendingApproval]:
        rid = uuid.uuid4().hex[:12]
        pending = _PendingApproval()
        with self._lock:
            self._approvals[rid] = pending
        return rid, pending

    def resolve(self, request_id: str, decision: ApprovalDecision) -> bool:
        with self._lock:
            pending = self._approvals.pop(request_id, None)
        if pending is None:
            return False
        pending.decision = decision
        pending.event.set()
        return True

    def abandon_all(self) -> None:
        """連線中斷時解除所有等待中的審批，避免執行緒卡住。"""
        with self._lock:
            pendings = list(self._approvals.values())
            self._approvals.clear()
        for p in pendings:
            p.event.set()


class RunRegistry:
    def __init__(self) -> None:
        self._runs: Dict[str, RunHandle] = {}
        self._lock = threading.Lock()

    def create(self) -> RunHandle:
        h = RunHandle(uuid.uuid4().hex)
        with self._lock:
            self._runs[h.run_id] = h
        return h

    def get(self, run_id: str) -> Optional[RunHandle]:
        with self._lock:
            return self._runs.get(run_id)

    def drop(self, run_id: str) -> None:
        with self._lock:
            self._runs.pop(run_id, None)


def make_handler(token: str, logger: Logger, registry: RunRegistry,
                 approval_timeout: float, default_bin: str = ""):

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "agentrunner/%s" % __version__

        # ── 基礎工具 ──

        def log_message(self, fmt, *a):          # noqa: A003
            logger.debug("http " + (fmt % a))

        def _authorized(self) -> bool:
            got = self.headers.get("Authorization", "")
            expected = "Bearer " + token
            # 定值比較，避免 timing 洩漏
            return secrets.compare_digest(got, expected)

        def _read_json(self) -> Optional[dict]:
            try:
                n = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(n) if n else b"{}"
                data = json.loads(raw.decode("utf-8"))
                return data if isinstance(data, dict) else None
            except Exception:                                   # noqa: BLE001
                return None

        def _send_json(self, code: int, payload: dict) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _begin_stream(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

        def _chunk(self, obj: dict) -> None:
            """送出一筆 NDJSON 事件（HTTP chunked）。"""
            data = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
            self.wfile.write(b"%X\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()

        def _end_stream(self) -> None:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

        # ── 路由 ──

        def do_GET(self):                                       # noqa: N802
            if self.path == "/health":
                self._send_json(200, {"status": "ok", "version": __version__,
                                      "agents": list(SUPPORTED_TYPES)})
                return
            if not self._authorized():
                self._send_json(401, {"error": "unauthorized"})
                return
            if self.path == "/v1/agents":
                self._send_json(200, {"agents": list(SUPPORTED_TYPES)})
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self):                                      # noqa: N802
            if not self._authorized():
                self._send_json(401, {"error": "unauthorized"})
                return
            body = self._read_json()
            if body is None:
                self._send_json(400, {"error": "invalid json body"})
                return
            if self.path == "/v1/run":
                self._handle_run(body)
            elif self.path == "/v1/approve":
                self._handle_approve(body)
            elif self.path == "/v1/cancel":
                self._handle_cancel(body)
            else:
                self._send_json(404, {"error": "not found"})

        # ── /v1/run ──

        def _handle_run(self, body: dict) -> None:
            agent = body.get("agent") or "claude"
            prompt = (body.get("prompt") or "").strip()
            if agent not in SUPPORTED_TYPES:
                self._send_json(400, {"error": "unknown agent: %s" % agent}); return
            if not prompt:
                self._send_json(400, {"error": "prompt is required"}); return

            o = body.get("options") or {}
            handle = registry.create()
            wants_approval = bool(o.get("interactive_approval"))

            mcp = o.get("mcp_config")
            mcp_bytes = (json.dumps(mcp).encode("utf-8")
                         if isinstance(mcp, (dict, list)) else
                         (mcp.encode("utf-8") if isinstance(mcp, str) else None))

            opts = ExecOptions(
                cwd=o.get("cwd", "") or "",
                model=o.get("model", "") or "",
                thinking_level=o.get("thinking_level", "") or "",
                system_prompt=o.get("system_prompt", "") or "",
                max_turns=int(o.get("max_turns", 0) or 0),
                timeout=float(o.get("timeout", 0) or 0),
                resume_session_id=o.get("resume_session_id", "") or "",
                custom_args=list(o.get("custom_args") or []),
                mcp_config=mcp_bytes,
                capture_transcript=bool(o.get("capture_transcript")),
                on_approval_request=(self._make_remote_approver(handle)
                                     if wants_approval else None),
            )

            try:
                backend = new(agent, Config(executable_path=o.get("bin", default_bin) or "",
                                            logger=logger))
                session = backend.execute(prompt, opts, cancel=handle.cancel)
            except Exception as exc:                            # noqa: BLE001
                registry.drop(handle.run_id)
                self._send_json(500, {"error": str(exc)}); return

            self._begin_stream()
            try:
                self._chunk({"status": "accepted", "response": "",
                             "run_id": handle.run_id})
                for msg in session.messages():
                    self._chunk(_message_to_event(msg))
                result = session.result()
                self._chunk(_result_to_event(result))
                self._end_stream()
            except (BrokenPipeError, ConnectionResetError):
                # 客戶端斷線：取消 agent，避免留下孤兒行程
                logger.warn("client disconnected; cancelling run", run_id=handle.run_id)
                handle.cancel.set()
                handle.abandon_all()
            finally:
                handle.abandon_all()
                registry.drop(handle.run_id)

        def _make_remote_approver(self, handle: RunHandle):
            """把審批請求送到事件流，阻塞等待客戶端 POST /v1/approve。"""
            def approver(req):
                request_id, pending = handle.new_approval()
                try:
                    self._chunk({
                        "status": "approval_request", "response": "",
                        "request_id": request_id, "run_id": handle.run_id,
                        "tool": req.tool_name, "input": req.tool_input,
                        "preview": req.content_preview,
                    })
                except Exception:                               # noqa: BLE001
                    return ApprovalDecision(decision="rejected",
                                            comment="無法送出審批請求")
                if not pending.event.wait(timeout=approval_timeout):
                    return ApprovalDecision(decision="rejected",
                                            comment="審批逾時（伺服器端保守拒絕）")
                if pending.decision is None:        # abandon_all 解除
                    return ApprovalDecision(decision="rejected",
                                            comment="連線中斷，審批取消")
                return pending.decision
            return approver

        # ── /v1/approve、/v1/cancel ──

        def _handle_approve(self, body: dict) -> None:
            handle = registry.get(body.get("run_id") or "")
            if handle is None:
                self._send_json(404, {"error": "unknown run_id"}); return
            decision = ApprovalDecision(
                decision=("approved" if body.get("decision") == "approved" else "rejected"),
                comment=body.get("comment", "") or "")
            ok = handle.resolve(body.get("request_id") or "", decision)
            self._send_json(200 if ok else 404,
                            {"resolved": ok} if ok else {"error": "unknown request_id"})

        def _handle_cancel(self, body: dict) -> None:
            handle = registry.get(body.get("run_id") or "")
            if handle is None:
                self._send_json(404, {"error": "unknown run_id"}); return
            handle.cancel.set()
            self._send_json(200, {"cancelled": True})

    return Handler


def _message_to_event(m) -> dict:
    """Message → NDJSON 事件（與 CLI 的契約一致）。"""
    t = m.type
    if t == MessageType.TEXT:
        return {"status": "generating_delta", "response": m.content}
    if t == MessageType.THINKING:
        return {"status": "thinking", "response": m.content}
    if t == MessageType.TOOL_USE:
        return {"status": "querying", "response": "", "tool": m.tool,
                "input": m.input, "call_id": m.call_id}
    if t == MessageType.TOOL_RESULT:
        return {"status": "tool_result", "response": "", "output": m.output,
                "call_id": m.call_id}
    if t == MessageType.ERROR:
        return {"status": "error", "response": m.content}
    return {"status": "status", "response": m.status or "", "session_id": m.session_id}


def _result_to_event(r) -> dict:
    return {"status": "complete", "response": r.output,
            "agent_status": r.status, "session_id": r.session_id,
            "duration_ms": r.duration_ms, "error": r.error,
            "usage": {k: vars(v) for k, v in r.usage.items()},
            "diagnostics": [vars(d) for d in r.diagnostics]}


def build_server(host: str = "127.0.0.1", port: int = 8700, token: str = "",
                 logger: Optional[Logger] = None,
                 approval_timeout: float = DEFAULT_APPROVAL_TIMEOUT,
                 default_bin: str = "") -> Tuple[ThreadingHTTPServer, str]:
    """建立（但不啟動）服務；回傳 (server, token)。"""
    if logger is None:
        logger = Logger()
    if not token:
        token = secrets.token_urlsafe(24)
    handler = make_handler(token, logger, RunRegistry(), approval_timeout, default_bin)
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.daemon_threads = True
    return httpd, token
