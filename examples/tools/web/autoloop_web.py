"""autoloop_web.py — agent-autoloop 工作流狀態小網頁（標準庫，只綁 127.0.0.1）

用法:
    python autoloop_web.py                       # 讀 ~/.agent-autoloop/web.json，預設埠 3351
    python autoloop_web.py --port 3352 --config D:/x/web.json

web.json:
    {
      "port": 3351,
      "autoloopExe": "C:/.../agent-autoloop.exe",
      "hubLog": "~/.agent-autoloop/logs/up.log",
      "workflows": [
        { "id": "gitlab-issues", "name": "GitLab 個人 Issue 摘要",
          "ruleName": "GitLab 個人 Issue 摘要",      # cron 規則名（status --json 的 lines[].id / runs[].rule）
          "emitType": "run.gitlab-issues",           # 「現在跑」送的事件類型
          "workDir": "~/.agent-autoloop/work/gitlab-issues",
          "outputs": [ { "label": "最新摘要 (HTML)", "path": "briefs/latest.html" } ],   # 相對 workDir 或絕對
          "logs":    [ { "label": "arrange.log",     "path": "arrange.log" } ] }
      ]
    }

路由:
    GET  /                       首頁三張卡（每 60 秒 fetch /api/status 更新）
    GET  /api/status             status --json 整理後的 JSON（快取 10 秒）
    POST /run/<id>               agent-autoloop emit <emitType>；同一工作流 10 秒內只接受一次（429）
    GET  /out/<id>/<n>[/<sub>]   產出：.html 原樣、.md 極簡轉換、目錄列最近 30 篇 *Article*.md
    GET  /log/<id>/<n>?n=200     log 最後 N 行；/log/hub 是中台 up.log
    GET  /api/version/<id>/<n>   該產出的 mtime（與 /api/status 同樣帶 Access-Control-Allow-Origin: *，file:// 頁面可 fetch）
    GET  /favicon.ico            分頁小圖（SVG，快取一天）；server 產生的頁面 <head> 也內嵌同一張
所有檔案路徑解析後必須落在 config 列出的檔案或目錄之下，否則 403。
"""

import argparse
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

# pythonw.exe 下 stdout/stderr 是 None：改寫到 ~/.agent-autoloop/logs/web.log（只保留本次啟動）
if sys.stdout is None or sys.stderr is None:
    _logp = os.path.join(os.path.expanduser("~"), ".agent-autoloop", "logs", "web.log")
    try:
        os.makedirs(os.path.dirname(_logp), exist_ok=True)
        _f = open(_logp, "w", encoding="utf-8", errors="replace", buffering=1)
    except Exception:
        _f = open(os.devnull, "w", encoding="utf-8")
    sys.stdout = sys.stderr = _f
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
STATUS_TTL = 10
RUN_COOLDOWN = 10
DIR_LIMIT = 30
ACTIVE = ("running", "claimed", "queued", "retrying")  # 進行中的輪，不當作「上次」


# ---------------------------------------------------------------- config
def expand(p: str, base: Path | None = None) -> Path:
    q = Path(os.path.expanduser(str(p)))
    if not q.is_absolute() and base is not None:
        q = base / q
    return q.resolve()


class Config:
    def __init__(self, path: Path):
        raw = json.loads(path.read_text(encoding="utf-8"))
        self.port = int(raw.get("port", 3351))
        self.exe = expand(raw["autoloopExe"])
        self.hub_log = expand(raw["hubLog"]) if raw.get("hubLog") else None
        self.workflows: list[dict] = []
        for w in raw.get("workflows", []):
            work = expand(w.get("workDir", "~"))
            wf = {
                "id": w["id"],
                "name": w.get("name", w["id"]),
                "ruleName": w.get("ruleName", ""),
                "emitType": w["emitType"],
                "workDir": work,
                "outputs": [{"label": o.get("label", o["path"]), "path": expand(o["path"], work)} for o in w.get("outputs", [])],
                "logs": [{"label": o.get("label", o["path"]), "path": expand(o["path"], work)} for o in w.get("logs", [])],
            }
            self.workflows.append(wf)
        self.by_id = {w["id"]: w for w in self.workflows}

    def allowed_roots(self) -> list[Path]:
        roots = [self.hub_log] if self.hub_log else []
        for w in self.workflows:
            roots += [o["path"] for o in w["outputs"]] + [o["path"] for o in w["logs"]]
        return roots


def inside(target: Path, root: Path) -> bool:
    """target 解析後必須等於 root，或落在 root（目錄）之下。"""
    try:
        t = target.resolve()
        r = root.resolve()
    except Exception:
        return False
    if t == r:
        return True
    return r.is_dir() and t.is_relative_to(r)


# ---------------------------------------------------------------- autoloop
class Autoloop:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._cache: tuple[float, dict] | None = None
        self._last_run: dict[str, float] = {}

    def _exec(self, *args: str, timeout: int = 60) -> tuple[int, str]:
        try:
            p = subprocess.run(
                [str(self.cfg.exe), *args],
                capture_output=True, timeout=timeout,
                stdin=subprocess.DEVNULL, creationflags=NO_WINDOW,
            )
        except FileNotFoundError:
            return 127, f"找不到 {self.cfg.exe}"
        except subprocess.TimeoutExpired:
            return 124, f"逾時 {timeout} 秒"
        out = (p.stdout or b"").decode("utf-8", "replace") + (p.stderr or b"").decode("utf-8", "replace")
        return p.returncode, out

    def raw_status(self) -> dict | None:
        code, out = self._exec("status", "--json", timeout=30)
        if code != 0:
            return None
        try:
            return json.loads(out[out.index("{"):])
        except Exception:
            return None

    def status(self) -> dict:
        with self._lock:
            now = time.time()
            if self._cache and now - self._cache[0] < STATUS_TTL:
                return self._cache[1]
            data = self.summarize(self.raw_status())
            self._cache = (now, data)
            return data

    def summarize(self, raw: dict | None) -> dict:
        out = {"now": iso_local(datetime.now(timezone.utc)), "ok": raw is not None, "workflows": []}
        lines = {l.get("id"): l for l in (raw or {}).get("lines", []) if isinstance(l, dict)}
        runs = (raw or {}).get("runs", []) if raw else []
        if raw:
            t = raw.get("totals", {})
            out["hub"] = {"running": t.get("running"), "queued": t.get("queued"), "attention": t.get("attention"), "doneToday": t.get("doneToday")}
        for w in self.cfg.workflows:
            item = {"id": w["id"], "name": w["name"], "emitType": w["emitType"],
                    "outputs": [o["label"] for o in w["outputs"]], "logs": [o["label"] for o in w["logs"]],
                    "last": None, "next": None, "every": None, "running": 0, "queued": 0, "error": None}
            if raw is None:
                item["error"] = "無法讀取"
                out["workflows"].append(item)
                continue
            line = lines.get(w["ruleName"])
            group = line.get("group") if line else None
            names = {w["ruleName"]}
            if group:
                names |= {l["id"] for l in lines.values() if l.get("group") == group}
            if line:
                item["next"] = iso_local(line.get("next"))
                item["every"] = line.get("every")
                for l in lines.values():
                    if l["id"] in names:
                        tt = l.get("totals") or {}
                        item["running"] += int(tt.get("running") or 0)
                        item["queued"] += int(tt.get("queued") or 0)
            else:
                item["error"] = f"status 裡找不到規則「{w['ruleName']}」"
            mine = [r for r in runs if isinstance(r, dict) and r.get("rule") in names]
            mine.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
            for r in mine:
                if r.get("state") in ACTIVE:
                    continue
                item["last"] = {
                    "id": r.get("id"), "rule": r.get("rule"), "state": r.get("state"),
                    "summary": r.get("summary") or r.get("error") or "",
                    "at": iso_local(r.get("finishedAt") or r.get("claimedAt") or r.get("createdAt")),
                    "manual": any(e.get("source") == "local" for e in (r.get("events") or []) if isinstance(e, dict)),
                }
                break
            cur = [r for r in mine if r.get("state") in ACTIVE]
            if cur:
                item["current"] = {"id": cur[0].get("id"), "state": cur[0].get("state"), "notBefore": iso_local(cur[0].get("notBefore"))}
            out["workflows"].append(item)
        return out

    def emit(self, wf: dict) -> tuple[int, str]:
        with self._lock:
            now = time.time()
            last = self._last_run.get(wf["id"], 0)
            if now - last < RUN_COOLDOWN:
                return 429, f"{RUN_COOLDOWN} 秒內已觸發過，請稍候再試"
            self._last_run[wf["id"]] = now
            self._cache = None
        code, out = self._exec("emit", wf["emitType"], timeout=60)
        return (200 if code == 0 else 500), out.strip()


def iso_local(s) -> str | None:
    """ISO 8601（Z）→ 本機時區 'YYYY-MM-DD HH:MM'"""
    if not s:
        return None
    try:
        if isinstance(s, datetime):
            d = s
        else:
            d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return d.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return str(s)


# ---------------------------------------------------------------- markdown (極簡)
def md_to_html(text: str) -> str:
    out: list[str] = []
    in_code = False
    in_list: str | None = None

    def inline(s: str) -> str:
        s = html.escape(s)
        s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
        s = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
        s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
        return s

    def close_list():
        nonlocal in_list
        if in_list:
            out.append(f"</{in_list}>")
            in_list = None

    for line in text.splitlines():
        if line.strip().startswith("```"):
            close_list()
            if in_code:
                out.append("</pre>")
            else:
                out.append("<pre>")
            in_code = not in_code
            continue
        if in_code:
            out.append(html.escape(line))
            continue
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            close_list()
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            continue
        m = re.match(r"^\s*[-*+]\s+(.*)", line)
        if m:
            if in_list != "ul":
                close_list()
                out.append("<ul>")
                in_list = "ul"
            out.append(f"<li>{inline(m.group(1))}</li>")
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)", line)
        if m:
            if in_list != "ol":
                close_list()
                out.append("<ol>")
                in_list = "ol"
            out.append(f"<li>{inline(m.group(1))}</li>")
            continue
        if re.match(r"^\s*(---|\*\*\*)\s*$", line):
            close_list()
            out.append("<hr>")
            continue
        if not line.strip():
            close_list()
            continue
        close_list()
        if line.startswith(">"):
            out.append(f"<blockquote>{inline(line[1:].strip())}</blockquote>")
        else:
            out.append(f"<p>{inline(line)}</p>")
    close_list()
    if in_code:
        out.append("</pre>")
    return "\n".join(out)


# ---------------------------------------------------------------- html
FAVICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#201e1d"/><rect x="8" y="9" width="16" height="3" fill="#ec3013"/><rect x="8" y="15" width="16" height="3" fill="#fff"/><rect x="8" y="21" width="10" height="3" fill="#fff"/></svg>'
)
FAVICON_LINK = "<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='6'%20fill='%23201e1d'/%3E%3Crect%20x='8'%20y='9'%20width='16'%20height='3'%20fill='%23ec3013'/%3E%3Crect%20x='8'%20y='15'%20width='16'%20height='3'%20fill='%23fff'/%3E%3Crect%20x='8'%20y='21'%20width='10'%20height='3'%20fill='%23fff'/%3E%3C/svg%3E\">"

CSS = """
*{box-sizing:border-box}
body{margin:0;background:#f3f2f2;color:#201e1d;font:15px/1.55 Archivo,"PingFang TC","Noto Sans TC","Microsoft JhengHei",sans-serif}
a{color:#201e1d}
.wrap{max-width:1100px;margin:0 auto;padding:20px 16px 40px}
header{border-bottom:2px solid #201e1d;padding-bottom:10px;margin-bottom:20px;display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
header h1{font-size:20px;margin:0;display:flex;align-items:center;gap:10px}
header h1::before{content:"";display:inline-block;width:12px;height:12px;background:#ec3013}
header .meta{color:#605d5d;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.card{background:#fff;border:1px solid #d7d3d3;padding:16px;display:flex;flex-direction:column;gap:10px}
.card h2{font-size:17px;margin:0;padding-bottom:8px;border-bottom:1px solid #d7d3d3}
.kv{display:grid;grid-template-columns:72px 1fr;gap:4px 8px;font-size:14px}
.kv dt{color:#605d5d}.kv dd{margin:0;word-break:break-word}
.state{display:inline-block;padding:0 6px;font-size:12px;font-weight:600;color:#fff;background:#605d5d}
.state.done{background:#201e1d}.state.nothing{background:#605d5d}.state.failed,.state.error,.state.retrying{background:#ec3013}
.state.running,.state.claimed,.state.queued{background:#ae1800}
.links{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}
.links a{color:#ae1800}
.err{color:#ec3013}
button{font:inherit;background:#ec3013;color:#fff;border:0;padding:8px 14px;cursor:pointer}
button:disabled{background:#d7d3d3;color:#605d5d;cursor:default}
.resp{font-size:13px;white-space:pre-wrap;background:#eae7e7;padding:8px;margin:0;display:none;max-height:160px;overflow:auto}
.resp.show{display:block}
footer{margin-top:24px;color:#605d5d;font-size:13px;border-top:1px solid #d7d3d3;padding-top:8px}
pre.log{background:#fff;border:1px solid #d7d3d3;padding:12px;font:13px/1.45 Consolas,"Cascadia Mono",monospace;white-space:pre-wrap;word-break:break-all;margin:0}
.toolbar{display:flex;gap:12px;align-items:center;margin-bottom:12px;font-size:14px;color:#605d5d;flex-wrap:wrap}
.toolbar a{color:#ae1800}
.doc{background:#fff;border:1px solid #d7d3d3;padding:20px 24px;max-width:860px}
.doc pre{background:#eae7e7;padding:10px;overflow:auto;font:13px/1.45 Consolas,monospace}
.doc code{background:#eae7e7;padding:0 3px}
.doc h1,.doc h2,.doc h3{border-bottom:1px solid #d7d3d3;padding-bottom:4px}
.doc blockquote{border-left:3px solid #d7d3d3;margin:8px 0;padding:0 12px;color:#605d5d}
table.list{width:100%;border-collapse:collapse;background:#fff;font-size:14px}
table.list th,table.list td{text-align:left;border-bottom:1px solid #d7d3d3;padding:6px 8px;vertical-align:top}
table.list th{color:#605d5d;font-weight:500}
td.t{color:#605d5d;white-space:nowrap}
"""


def page(title: str, body: str, extra_head: str = "") -> str:
    return (
        "<!doctype html><html lang=\"zh-TW\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        f"<title>{html.escape(title)}</title>{FAVICON_LINK}<style>{CSS}</style>{extra_head}</head>"
        f"<body><div class=\"wrap\">{body}</div></body></html>"
    )


INDEX_JS = """
const COOL=10;
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function render(d){
  document.getElementById('now').textContent='更新於 '+(d.now||'');
  const hub=d.hub?`中台：在跑 ${d.hub.running}、排隊 ${d.hub.queued}、要你留意 ${d.hub.attention}、今天做完 ${d.hub.doneToday}`:'中台：無法讀取';
  document.getElementById('hub').textContent=hub;
  for(const w of d.workflows){
    const el=document.querySelector(`[data-id="${w.id}"] .status`); if(!el) continue;
    let h='';
    if(w.error){h+=`<dt>狀態</dt><dd class="err">${esc(w.error)}</dd>`;}
    if(w.current){h+=`<dt>目前</dt><dd><span class="state ${esc(w.current.state)}">${esc(w.current.state)}</span> 第 ${esc(w.current.id)} 輪${w.current.state==='queued'&&w.current.notBefore?'，不早於 '+esc(w.current.notBefore):''}</dd>`;}
    if(w.last){
      h+=`<dt>上次</dt><dd>${esc(w.last.at)}　<span class="state ${esc(w.last.state)}">${esc(w.last.state)}</span> 第 ${esc(w.last.id)} 輪${w.last.manual?'（手動）':''}</dd>`;
      h+=`<dt>結論</dt><dd>${esc(w.last.summary)||'<span class="err">（沒留下結論）</span>'}</dd>`;
    }else if(!w.error){h+=`<dt>上次</dt><dd>無法讀取</dd>`;}
    h+=`<dt>下次</dt><dd>${esc(w.next||'無法讀取')}${w.every?' <span style="color:#605d5d">('+esc(w.every)+')</span>':''}</dd>`;
    el.innerHTML=h;
  }
}
async function refresh(){
  try{const r=await fetch('/api/status',{cache:'no-store'});render(await r.json());}
  catch(e){document.getElementById('now').textContent='狀態讀取失敗：'+e;}
}
async function run(id,btn){
  const resp=btn.parentElement.querySelector('.resp');
  btn.disabled=true;resp.classList.add('show');resp.textContent='觸發中…';
  try{
    const r=await fetch('/run/'+encodeURIComponent(id),{method:'POST'});
    const t=await r.text();
    resp.textContent=(r.status===429?'[429] ':r.ok?'':'[失敗 '+r.status+'] ')+t;
  }catch(e){resp.textContent='失敗：'+e;}
  let left=COOL;btn.textContent=`現在跑（${left}）`;
  const tm=setInterval(()=>{left--;if(left<=0){clearInterval(tm);btn.disabled=false;btn.textContent='現在跑';refresh();}else btn.textContent=`現在跑（${left}）`;},1000);
}
refresh();setInterval(refresh,60000);
"""


def index_html(cfg: Config) -> str:
    cards = []
    for w in cfg.workflows:
        links = "".join(
            f'<a href="/out/{quote(w["id"])}/{i}">{html.escape(o["label"])}</a>' for i, o in enumerate(w["outputs"])
        )
        logs = "".join(
            f'<a href="/log/{quote(w["id"])}/{i}">{html.escape(o["label"])}</a>' for i, o in enumerate(w["logs"])
        )
        cards.append(
            f'<section class="card" data-id="{html.escape(w["id"])}">'
            f'<h2>{html.escape(w["name"])}</h2>'
            f'<dl class="kv status"><dt>狀態</dt><dd>讀取中…</dd></dl>'
            f'<div class="links">{links or "<span style=color:#605d5d>（無產出）</span>"}</div>'
            f'<div class="links">{logs or "<span style=color:#605d5d>（無專屬 log）</span>"}</div>'
            f'<div><button onclick="run(\'{html.escape(w["id"])}\',this)">現在跑</button>'
            f'<pre class="resp"></pre></div>'
            f'<div style="color:#605d5d;font-size:12px">emit {html.escape(w["emitType"])}</div>'
            "</section>"
        )
    body = (
        '<header><h1>agent-autoloop 工作流</h1><span class="meta" id="hub"></span><span class="meta" id="now"></span></header>'
        f'<div class="cards">{"".join(cards)}</div>'
        '<footer><a href="/log/hub">中台 up.log</a> · <a href="/api/status">/api/status</a> · 每 60 秒自動更新</footer>'
        f"<script>{INDEX_JS}</script>"
    )
    return page("agent-autoloop 工作流", body)


def tail_lines(path: Path, n: int) -> str:
    try:
        data = path.read_bytes()
    except Exception as e:
        return f"（讀不到：{e}）"
    text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    return "\n".join(lines[-n:])


def log_html(title: str, body_text: str, n: int, self_url: str, count: int) -> str:
    js = f"""
    const pre=document.getElementById('log');
    function bottom(){{window.scrollTo(0,document.body.scrollHeight);}}
    bottom();
    setInterval(async()=>{{try{{const r=await fetch('{self_url}?n={n}&raw=1',{{cache:'no-store'}});
      const t=await r.text();if(t!==pre.textContent){{pre.textContent=t;bottom();}}
      document.getElementById('t').textContent='更新於 '+new Date().toLocaleTimeString();}}catch(e){{}}}},10000);
    """
    body = (
        f'<div class="toolbar"><a href="/">← 首頁</a><strong>{html.escape(title)}</strong>'
        f'<span>最後 {count} 行（<a href="{self_url}?n={n*2}">更多</a>）</span><span id="t"></span><span>每 10 秒自動刷新</span></div>'
        f'<pre class="log" id="log">{html.escape(body_text)}</pre><script>{js}</script>'
    )
    return page(title, body)


def list_dir_html(wf: dict, idx: int, root: Path, label: str) -> str:
    files: list[Path] = []
    for p in root.rglob("*.md"):
        if p.is_file() and re.search(r"-Article(-V\d+)?\.md$", p.name):
            files.append(p)
    if not files:
        files = [p for p in root.rglob("*.md") if p.is_file()]
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    rows = []
    for p in files[:DIR_LIMIT]:
        rel = p.relative_to(root).as_posix()
        t = datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M")
        href = f"/out/{quote(wf['id'])}/{idx}/{quote(rel)}"
        rows.append(f'<tr><td class="t">{t}</td><td><a href="{href}">{html.escape(rel)}</a></td></tr>')
    body = (
        f'<div class="toolbar"><a href="/">← 首頁</a><strong>{html.escape(wf["name"])} · {html.escape(label)}</strong>'
        f'<span>最近 {len(rows)} 篇（共 {len(files)}）</span></div>'
        f'<table class="list"><tr><th>更新時間</th><th>檔案</th></tr>{"".join(rows)}</table>'
    )
    return page(label, body)


# ---------------------------------------------------------------- handler
class Handler(BaseHTTPRequestHandler):
    cfg: Config
    loop: Autoloop
    server_version = "autoloop-web/1.0"

    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("%s %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))
        except Exception:
            pass

    # -- helpers
    def send(self, code: int, body: str | bytes, ctype: str = "text/html; charset=utf-8", cache: str = "no-store"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_json(self, code: int, obj, cors: bool = False):
        """cors=True 只給 /api/status 與 /api/version：加 Access-Control-Allow-Origin: *，讓 file:// 開的頁面也能 fetch。"""
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if cors:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def send_text(self, code: int, text: str):
        self.send(code, text, "text/plain; charset=utf-8")

    def resolve_output(self, kind: str, wid: str, n: str, sub: str = "") -> tuple[dict, dict, Path, int] | None:
        """回 (workflow, entry, resolved path, idx)；不合法回 None（已送出回應）。"""
        wf = self.cfg.by_id.get(wid)
        if not wf or not n.isdigit():
            self.send_text(404, "沒有這個工作流或編號")
            return None
        entries = wf["outputs"] if kind == "out" else wf["logs"]
        idx = int(n)
        if idx >= len(entries):
            self.send_text(404, "沒有這個編號")
            return None
        entry = entries[idx]
        base = entry["path"]
        target = (base / unquote(sub)) if sub else base
        if not inside(target, base):
            self.send_text(403, "403 Forbidden：路徑不在允許範圍")
            return None
        return wf, entry, target.resolve(), idx

    # -- routes
    def do_GET(self):
        u = urlsplit(self.path)
        parts = [p for p in u.path.split("/") if p]
        qs = parse_qs(u.query)
        # 先擋掉任何 .. 片段（即使解析後合法也不接受）
        if any(unquote(p) in ("..", ".") for p in parts):
            return self.send_text(403, "403 Forbidden")
        if not parts:
            return self.send(200, index_html(self.cfg))
        if parts == ["favicon.ico"]:
            return self.send(200, FAVICON_SVG, "image/svg+xml", cache="max-age=86400")
        if parts == ["api", "status"]:
            return self.send_json(200, self.loop.status(), cors=True)
        if parts[0] == "api" and len(parts) == 4 and parts[1] == "version":
            r = self.resolve_output("out", parts[2], parts[3])
            if not r:
                return
            wf, entry, target, idx = r
            if not target.exists():
                return self.send_json(404, {"error": "not found"}, cors=True)
            st = target.stat()
            return self.send_json(200, {"id": wf["id"], "n": idx, "label": entry["label"], "mtime": st.st_mtime,
                                        "mtimeLocal": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"), "size": st.st_size}, cors=True)
        if parts[0] == "log" and len(parts) == 2 and parts[1] == "hub":
            if not self.cfg.hub_log:
                return self.send_text(404, "web.json 沒設 hubLog")
            return self.serve_log("中台 up.log", self.cfg.hub_log, "/log/hub", qs)
        if parts[0] == "log" and len(parts) == 3:
            r = self.resolve_output("log", parts[1], parts[2])
            if not r:
                return
            wf, entry, target, idx = r
            return self.serve_log(f"{wf['name']} · {entry['label']}", target, f"/log/{quote(wf['id'])}/{idx}", qs)
        if parts[0] == "out" and len(parts) >= 3:
            sub = "/".join(parts[3:])
            r = self.resolve_output("out", parts[1], parts[2], sub)
            if not r:
                return
            wf, entry, target, idx = r
            return self.serve_output(wf, entry, target, idx, bool(qs.get("raw")))
        self.send_text(404, "404")

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        u = urlsplit(self.path)
        parts = [p for p in u.path.split("/") if p]
        if len(parts) == 2 and parts[0] == "run":
            wf = self.cfg.by_id.get(unquote(parts[1]))
            if not wf:
                return self.send_text(404, "沒有這個工作流")
            code, out = self.loop.emit(wf)
            return self.send_text(code, out or "（emit 沒有輸出）")
        self.send_text(404, "404")

    def serve_log(self, title: str, path: Path, self_url: str, qs: dict):
        try:
            n = max(1, min(int(qs.get("n", ["200"])[0]), 20000))
        except ValueError:
            n = 200
        text = tail_lines(path, n)
        if qs.get("raw"):
            return self.send_text(200, text)
        return self.send(200, log_html(title, text, n, self_url, len(text.splitlines())))

    def serve_output(self, wf: dict, entry: dict, target: Path, idx: int, raw: bool):
        if not target.exists():
            return self.send_text(404, f"檔案不存在：{target}")
        if target.is_dir():
            return self.send(200, list_dir_html(wf, idx, target, entry["label"]))
        suffix = target.suffix.lower()
        try:
            data = target.read_bytes()
        except Exception as e:
            return self.send_text(500, f"讀不到：{e}")
        if suffix in (".html", ".htm"):
            return self.send(200, data)
        if suffix == ".md" and not raw:
            text = data.decode("utf-8", "replace")
            body = (
                f'<div class="toolbar"><a href="/">← 首頁</a><strong>{html.escape(wf["name"])} · {html.escape(entry["label"])}</strong>'
                f'<span>{html.escape(target.name)}</span><a href="?raw=1">原始檔</a></div>'
                f'<article class="doc">{md_to_html(text)}</article>'
            )
            return self.send(200, page(target.name, body))
        if suffix == ".json":
            return self.send(200, data, "application/json; charset=utf-8")
        return self.send(200, data, "text/plain; charset=utf-8")


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="agent-autoloop 工作流狀態小網頁")
    ap.add_argument("--config", default=os.path.join(os.path.expanduser("~"), ".agent-autoloop", "web.json"))
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()
    cfg_path = Path(args.config)
    if not cfg_path.exists():
        print(f"找不到設定檔 {cfg_path}", file=sys.stderr)
        return 2
    cfg = Config(cfg_path)
    port = args.port or cfg.port
    Handler.cfg = cfg
    Handler.loop = Autoloop(cfg)
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print(f"autoloop-web 聽在 http://127.0.0.1:{port}/ （config {cfg_path}；{len(cfg.workflows)} 個工作流）", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
