"""agentrunner_chat.py — lmstudio_client 的替代品，改用 agentrunner 驅動 Claude CLI。

介面與 lmstudio_client 相容，所以呼叫端不需修改：

    from agentrunner_chat import chat as lm_chat, select_model as lm_select_model

    LLM_MODEL = lm_select_model()          # -> "claude-sonnet-5"
    text = lm_chat(prompt, timeout=120)    # -> str 或 None（失敗時）

預設使用 Claude Haiku 4.5 + medium 推理強度（快速、低成本，適合摘要類批次任務）。

環境變數（皆可選）：
    AGENTRUNNER_MODEL     覆寫模型，預設 claude-haiku-4-5-20251001
    AGENTRUNNER_EFFORT    覆寫推理強度，預設 medium
    AGENTRUNNER_CLAUDE_BIN    claude 執行檔路徑，預設走 PATH 上的 "claude"
    AGENTRUNNER_CWD       工作目錄，預設為 <temp>/agentrunner_chat_cwd 這個固定的中性目錄
    AGENTRUNNER_DEBUG     設為 1 時輸出 agentrunner 的除錯 log
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
from typing import Optional

from agentrunner import Config, ExecOptions, Logger, new

# ── 預設設定 ──────────────────────────────────────────────

DEFAULT_MODEL = os.environ.get("AGENTRUNNER_MODEL", "claude-haiku-4-5-20251001")
# Haiku 4.5 支援 low / medium / high（不支援 xhigh / max）
DEFAULT_EFFORT = os.environ.get("AGENTRUNNER_EFFORT", "medium")
# Windows 的 CreateProcess 只依 PATHEXT 尋找，PATH 上那個無副檔名的 claude
# （bash script）會直接 WinError 2；which 會解析到可執行的 claude.cmd。
CLAUDE_BIN = (os.environ.get("AGENTRUNNER_CLAUDE_BIN")
              or shutil.which("claude") or "claude")
_DEBUG = os.environ.get("AGENTRUNNER_DEBUG") == "1"

# 純文字生成用的中性工作目錄：避免 Claude Code 載入專案的 CLAUDE.md /
# 掃描 repo，徒增延遲與 token 消耗。
# 這是固定路徑（非隨機），可用 AGENTRUNNER_CWD 覆寫，或在 chat() 逐次指定。
_NEUTRAL_CWD = os.environ.get(
    "AGENTRUNNER_CWD", os.path.join(tempfile.gettempdir(), "agentrunner_chat_cwd"))

_backends = {}
_backend_lock = threading.Lock()


def _get_backend(backend: str = "claude"):
    """依後端延遲初始化並快取（執行緒安全）。"""
    if backend not in ("claude", "codex", "antigravity"):
        raise ValueError(f"不支援的後端: {backend}")
    with _backend_lock:
        if backend not in _backends:
            command = {"claude": "claude", "codex": "codex", "antigravity": "agy"}[backend]
            executable = (CLAUDE_BIN if backend == "claude" else
                          os.environ.get(f"AGENTRUNNER_{backend.upper()}_BIN")
                          or shutil.which(command) or command)
            os.makedirs(_NEUTRAL_CWD, exist_ok=True)
            _backends[backend] = new(backend, Config(
                executable_path=executable,
                logger=Logger(enabled=_DEBUG),
            ))
    return _backends[backend]


def select_model() -> str:
    """回傳目前使用的模型名稱（供顯示用），對應 lmstudio_client.select_model()。"""
    return DEFAULT_MODEL


def chat(prompt: str,
         timeout: float = 120,
         model: Optional[str] = None,
         thinking_level: Optional[str] = None,
         system_prompt: str = "",
         cwd: Optional[str] = None,
         backend: str = "claude") -> Optional[str]:
    """送出單輪 prompt，回傳純文字結果；失敗時回傳 None。

    與 lmstudio_client.chat() 行為一致：呼叫端用 `if not content_str:` 判斷失敗即可。
    """
    backend_name = backend
    backend = _get_backend(backend_name)
    work_dir = cwd or _NEUTRAL_CWD
    if work_dir == _NEUTRAL_CWD:
        os.makedirs(work_dir, exist_ok=True)
    opts = ExecOptions(
        cwd=work_dir,
        model=model or (DEFAULT_MODEL if backend_name == "claude" else ""),
        thinking_level=thinking_level or DEFAULT_EFFORT,
        system_prompt=system_prompt,
        # 純文字生成不需要多輪工具迴圈，限制成單輪可避免 agent 亂用工具、
        # 也讓延遲可預期。
        max_turns=1,
        timeout=float(timeout),
    )

    # agy 沒有 system-prompt 參數，將翻譯規則併入提示詞。
    if backend_name == "antigravity" and system_prompt:
        prompt = system_prompt + "\n\n" + prompt

    try:
        session = backend.execute(prompt, opts)
        # result() 內部有硬性 timeout；這裡再加緩衝避免極端情況卡死。
        result = session.result(timeout=float(timeout) + 30)
    except Exception as exc:  # noqa: BLE001
        print(f"  ⚠ [LLM] 呼叫失敗: {exc}")
        return None

    if result.status != "completed":
        codes = ", ".join(d.code for d in result.diagnostics) or result.status
        print(f"  ⚠ [LLM] {result.status}: {result.error or codes}")
        return None

    return (result.output or "").strip() or None
