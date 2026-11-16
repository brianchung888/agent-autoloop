#!/usr/bin/env python3
"""把 Gmail 收件匣收成和 gitlab-issues 一樣的 dashboard。

用法：
    python scripts/gmail_inbox.py                       # 收集 → 快照 → Markdown + HTML
    python scripts/gmail_inbox.py --dry-run             # 只收集與統計，不寫 briefs
    python scripts/gmail_inbox.py --autoloop            # 結尾加印 agent-autoloop 回執區塊
    python scripts/gmail_inbox.py --fixture tests/eml   # 離線：讀 .eml 檔當信件來源，不連 IMAP

認證：環境變數 `GMAIL_AGENT`（`信箱:應用程式密碼`，或只放密碼），
或分開的 `GMAIL_USER` + `GMAIL_APP_PASSWORD`。都不寫進 sources.json、不印在任何輸出裡。

唯讀保證：mailbox 一律以 `readonly=True` 開啟，所有 FETCH 都用 `BODY.PEEK[...]`，
因此不會把信標成已讀、不會封存、不會改標籤。本腳本沒有任何 STORE/COPY/EXPUNGE 呼叫。

收集規則：
  - 只打一條 Gmail 搜尋語法（sources.json 的 `query`，例 `in:inbox newer_than:7d`），
    透過 IMAP 的 `UID SEARCH CHARSET UTF-8 X-GM-RAW` 交給 Gmail 自己解讀，不自創篩選邏輯。
    非 ASCII 查詢字串用 literal 送出。
  - 一列 = 一個對話串（`X-GM-THRID`），不是一封信。串內以最新一封的寄件者/主旨/時間代表，
    另記信數、未讀數、參與者、標籤（`X-GM-LABELS`）。
  - 標頭用 `BODY.PEEK[HEADER.FIELDS (...)]` 批次抓；只有進了最終清單的對話串，才對**最新那封**
    多抓一次 `BODY.PEEK[]<0.65536>`（前 64 KiB）取內文摘要，HTML 會轉純文字，截到 `bodyChars` 字。
  - 旗標：U=未讀、D=直接寄給我（我在 To，不只 Cc）、R=我回過（\\Answered）、S=已加星號、
    L=清單信（有 List-Id）、A=有夾檔。
  - 「待我回覆」= 未回過 + 最新一封不是我寄的 + 我在 To（direct）；LLM 版（SKILL.md）之後再接。

快照：內容的 sha256 當 id（不含 id/collectedAt），寫在 `gmail-inputs/<id>.json`；
同 id 不覆寫。對話串依 thrid 排序、串內欄位固定順序，確保同樣的信箱狀態產出同樣的 id。
信件內容只留在工作目錄，不進 repo。

輸出：`briefs/<id>.md`、`briefs/<id>.html`，再覆寫 `latest.*` 與 `<period>.*`（同 gitlab-issues）。
HTML 只替換模板 `<script id="data" type="application/json">` 那一段，其餘一個位元組都不改。
"""

import argparse
import base64
import email
import email.header
import email.utils
import hashlib
import html
import imaplib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

# Windows PowerShell UTF-8 修正
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_WORK_DIR = Path.home() / ".agent-autoloop" / "work" / "gmail-inbox"
DEFAULT_HOST = "imap.gmail.com"
DEFAULT_MAILBOX = "[Gmail]/All Mail"
DEFAULT_QUERY = "in:inbox newer_than:7d"
DEFAULT_MAX_THREADS = 300
DEFAULT_BODY_CHARS = 400
FETCH_BATCH = 200             # 一次 FETCH 的 UID 數
BODY_PREFIX_BYTES = 65536     # 取內文時只抓前 64 KiB
IMAP_TIMEOUT = 60
MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
LIMIT_MSG = ("超過摘要上限（{n} 個對話串 / 2 MiB），請把 query 縮小（例如 newer_than 改短、加 -category:promotions）"
             "或調低 maxThreads；不產生部分摘要")
HEADER_FIELDS = "FROM TO CC SUBJECT DATE MESSAGE-ID LIST-ID IN-REPLY-TO REFERENCES REPLY-TO"
DATA_RE = re.compile(r'(<script id="data" type="application/json">)(.*?)(</script>)', re.S)
# FETCH 回應前綴裡的欄位（imaplib 不幫忙解析，自己抓）
RE_UID = re.compile(rb"UID (\d+)")
RE_THRID = re.compile(rb"X-GM-THRID (\d+)")
RE_MSGID = re.compile(rb"X-GM-MSGID (\d+)")
RE_FLAGS = re.compile(rb"FLAGS \(([^)]*)\)")
RE_LABELS = re.compile(rb"X-GM-LABELS \((.*?)\)(?= [A-Z]|$)", re.S)
RE_INTERNALDATE = re.compile(rb'INTERNALDATE "([^"]+)"')
# Gmail 內建標籤 → 不顯示（使用者自訂標籤才有意義）
NO_REPLY_RE = re.compile(
    r"no[-_.]?reply|do[-_.]?not[-_.]?reply|notification|notify|mailer|bounce"
    r"|postmaster|automailer|auto[-_.]?mail", re.I)


AUTO_MAIL_RE = re.compile(
    "請勿(直接)?回信|請勿回覆|勿回覆此信|系統自動(發送|發信|寄送)|自動發送(的)?(郵件|信件)"
    "|本信件為系統|do not reply|automated message", re.I)


# 要我做事：信裡明講要我填、回、確認、簽核、交東西或有期限
REPLY_MAX = 12          # 待我回覆最多幾筆

ACTION_RE = re.compile(
    "請(填寫|回覆|回復|確認|提供|協助|核准|簽核|審核|處理|安排|補充|告知|查收|撥冗)"
    "|填寫|回條|問卷|報名|截止|逾期|期限|前完成|請於|需要你|麻煩你|麻煩您|待簽核|待審核|待確認"
    "|請假|面談|會議邀請|please (fill|confirm|review|reply|approve)|action required|deadline", re.I)

# 例行報表：有價值但不是在等我回話，排最後
REPORT_RE = re.compile("日報|週報|月報|排行|報表|統計|summary|digest|daily report", re.I)


class RunError(Exception):
    """任何讓本輪「没跑成」的錯誤。"""


def log(msg: str) -> None:
    """進度訊息一律走 stderr，stdout 只留結論。"""
    print(msg, file=sys.stderr, flush=True)


# ====== 快照 id ======

def js_stringify(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256_hex(value) -> str:
    return hashlib.sha256(js_stringify(value).encode("utf-8")).hexdigest()


def js_iso(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ====== 設定 ======

def as_list(value) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, (list, tuple)) else [value]


def load_sources(work_dir: Path, account: str) -> dict:
    path = work_dir / "sources.json"
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raise RunError("無法讀取 sources.json，請檢查路徑與 JSON")
    if not isinstance(config, dict):
        raise RunError("檢查 sources.json：最外層要是物件")

    query = config.get("query", DEFAULT_QUERY)
    if not isinstance(query, str) or not query.strip():
        raise RunError('檢查 sources.json：query 要是 Gmail 搜尋語法字串，例 "in:inbox newer_than:7d"')
    config["query"] = query.strip()

    config["imapHost"] = config.get("imapHost") or DEFAULT_HOST
    config["mailbox"] = config.get("mailbox") or DEFAULT_MAILBOX

    me = []
    for a in as_list(config.get("me")):
        a = str(a).strip().lower()
        if not a:
            continue
        if "@" not in a:
            raise RunError(f"檢查 sources.json：me 要是信箱位址，這個不是：{a}")
        me.append(a)
    if account:
        me.append(account.lower())
    config["me"] = sorted(set(me))
    if not config["me"]:
        raise RunError("檢查 sources.json：me 要列出你自己的信箱位址（或設好環境變數 GMAIL_USER）")

    mt = config.get("maxThreads", DEFAULT_MAX_THREADS)
    if not isinstance(mt, int) or isinstance(mt, bool) or not 1 <= mt <= 2000:
        raise RunError("檢查 sources.json：maxThreads 須為 1–2000（沒寫就是 300）")
    config["maxThreads"] = mt

    bc = config.get("bodyChars", DEFAULT_BODY_CHARS)
    if not isinstance(bc, int) or isinstance(bc, bool) or not 0 <= bc <= 4000:
        raise RunError("檢查 sources.json：bodyChars 須為 0–4000（沒寫就是 400，0 表示不抓內文）")
    config["bodyChars"] = bc

    tzname = config.get("timezone")
    if not isinstance(tzname, str) or not tzname.strip():
        raise RunError('檢查 sources.json：timezone 要是 IANA 時區，例 "Asia/Taipei"')
    try:
        ZoneInfo(tzname)
    except Exception:
        raise RunError(f"timezone 無效：{tzname}")

    labels = [str(x) for x in as_list(config.get("labelOrder")) if str(x).strip()]
    config["labelOrder"] = labels
    config["replyExcludeLabels"] = [str(x).strip() for x in as_list(config.get("replyExcludeLabels"))
                                    if str(x).strip()]
    rules = []
    for i, item in enumerate(as_list(config.get("exclude")), 1):
        if isinstance(item, str):
            item = {"label": item}
        if not isinstance(item, dict):
            raise RunError(f"檢查 sources.json：exclude 第 {i} 條要是物件或標籤字串")
        rule = {k: str(v).strip().lower() for k, v in item.items() if str(v).strip()}
        unknown = set(rule) - {"label", "from", "subject", "body", "replyto"}
        if unknown:
            raise RunError(f"檢查 sources.json：exclude 第 {i} 條有不認得的欄位 {sorted(unknown)}"
                           "（只收 label／from／subject／body／replyto）")
        if rule:
            rules.append(rule)
    config["exclude"] = rules
    return config


# ====== 信件解析 ======

def decode_hdr(raw: "str | None") -> str:
    """RFC 2047 標頭解碼；big5/gb2312 等中文編碼用 errors=replace，不讓單封壞信炸掉整輪。"""
    if not raw:
        return ""
    out = []
    try:
        parts = email.header.decode_header(raw)
    except Exception:
        return raw.strip()
    for text, enc in parts:
        if isinstance(text, bytes):
            try:
                out.append(text.decode(enc or "utf-8", errors="replace"))
            except (LookupError, TypeError):
                out.append(text.decode("utf-8", errors="replace"))
        else:
            out.append(text)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def parse_addrs(raw: "str | None") -> "list[dict]":
    """標頭 → [{name, addr}]，addr 一律小寫。"""
    out = []
    for name, addr in email.utils.getaddresses([raw or ""]):
        addr = (addr or "").strip().lower()
        if not addr or "@" not in addr:
            continue
        out.append({"name": decode_hdr(name) or addr.split("@")[0], "addr": addr})
    return out


def msg_date(msg, fallback: "datetime | None" = None) -> datetime:
    dt = None
    try:
        dt = email.utils.parsedate_to_datetime(msg.get("Date"))
    except Exception:
        dt = None
    if dt is None:
        return fallback or datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>", "\n", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return html.unescape(text)


def looks_html(text: str) -> bool:
    head = (text or "")[:2000].lower()
    return "<!doctype html" in head or "<html" in head or "<body" in head or "<table" in head


def body_text(msg) -> str:
    """取 text/plain；沒有就拿 text/html 轉純文字。不跟夾檔走。"""
    plain, rich = "", ""
    for part in msg.walk() if msg.is_multipart() else [msg]:
        ctype = (part.get_content_type() or "").lower()
        if ctype not in ("text/plain", "text/html"):
            continue
        if (part.get("Content-Disposition") or "").lower().startswith("attachment"):
            continue
        try:
            raw = part.get_payload(decode=True)
        except Exception:
            continue
        if not raw:
            continue
        charset = part.get_content_charset() or "utf-8"
        try:
            text = raw.decode(charset, errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        if ctype == "text/plain" and not plain:
            # 有些發信程式把 HTML 標成 text/plain（或整封沒宣告 Content-Type），聞到標籤就照 HTML 處理
            plain = strip_html(text) if looks_html(text) else text
        elif ctype == "text/html" and not rich:
            rich = strip_html(text)
    return plain or rich


def clean_snippet(text: str, limit: int) -> str:
    """去掉引言行與簽名檔分隔，壓成單行後截斷。"""
    lines = []
    for line in (text or "").splitlines():
        s = line.strip()
        if s.startswith(">") or s.startswith("在 ") and s.endswith("寫道："):
            continue
        if s in ("--", "-- "):
            break
        if s:
            lines.append(s)
    one = re.sub(r"\s+", " ", " ".join(lines)).strip()
    if limit and len(one) > limit:
        one = one[:limit].rstrip() + "…"
    return one


def has_attachment(msg) -> bool:
    for part in msg.walk() if msg.is_multipart() else [msg]:
        disp = (part.get("Content-Disposition") or "").lower()
        if disp.startswith("attachment"):
            return True
        if part.get_filename():
            return True
    return False


# ====== IMAP ======

class Gmail:
    """唯讀的 Gmail IMAP 連線：只做 SELECT(readonly)、UID SEARCH、UID FETCH BODY.PEEK。"""

    def __init__(self, host: str, user: str, password: str, mailbox: str):
        imaplib._MAXLINE = max(imaplib._MAXLINE, 10 * 1024 * 1024)  # 大 FETCH 會超過預設 10000 bytes
        try:
            self.conn = imaplib.IMAP4_SSL(host, 993, timeout=IMAP_TIMEOUT)
        except Exception as e:
            raise RunError(f"連不上 {host}:993（{type(e).__name__}）")
        try:
            self.conn.login(user, password)
        except imaplib.IMAP4.error as e:
            raise RunError("IMAP 登入失敗：請確認 GMAIL_AGENT／GMAIL_USER（應用程式密碼，"
                           f"不是登入密碼），以及該帳號有開 IMAP。伺服器訊息：{_safe(e)}")
        self.mailbox = self._resolve_mailbox(mailbox)
        typ, _ = self.conn.select(f'"{self.mailbox}"', readonly=True)
        if typ != "OK":
            raise RunError(f"開不了信箱 {self.mailbox}")

    def _resolve_mailbox(self, want: str) -> str:
        """[Gmail]/All Mail 在部分帳號是本地化名稱，用 LIST 的 \\All 屬性找真名。"""
        try:
            typ, data = self.conn.list()
        except Exception:
            return want
        if typ != "OK" or not data:
            return want
        names = []
        for raw in data:
            if not isinstance(raw, bytes):
                continue
            line = raw.decode("utf-8", errors="replace")
            m = re.match(r'\((?P<attrs>[^)]*)\) "[^"]*" (?P<name>.+)$', line)
            if not m:
                continue
            name = m.group("name").strip().strip('"')
            names.append(name)
            if want == DEFAULT_MAILBOX and "\\All" in m.group("attrs"):
                return name
        if want in names:
            return want
        if want == DEFAULT_MAILBOX:
            raise RunError("找不到 All Mail 信箱（帳號可能關掉了「在 IMAP 中顯示所有郵件」）")
        raise RunError(f"信箱不存在：{want}")

    def search(self, query: str) -> "list[bytes]":
        """UID SEARCH X-GM-RAW <gmail 搜尋語法>。非 ASCII 走 literal。"""
        try:
            if query.isascii():
                typ, data = self.conn.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW",
                                          '"' + query.replace("\\", "\\\\").replace('"', '\\"') + '"')
            else:
                self.conn.literal = query.encode("utf-8")
                typ, data = self.conn.uid("SEARCH", "CHARSET", "UTF-8", "X-GM-RAW", None)
        except imaplib.IMAP4.error as e:
            raise RunError(f"搜尋失敗，請檢查 query 是不是合法的 Gmail 搜尋語法：{_safe(e)}")
        if typ != "OK":
            raise RunError("搜尋失敗（伺服器沒回 OK）")
        return (data[0] or b"").split()

    def fetch(self, uids: "list[bytes]", what: str) -> list:
        out = []
        for i in range(0, len(uids), FETCH_BATCH):
            chunk = b",".join(uids[i:i + FETCH_BATCH]).decode()
            try:
                typ, data = self.conn.uid("FETCH", chunk, what)
            except imaplib.IMAP4.error as e:
                raise RunError(f"抓信失敗：{_safe(e)}")
            if typ != "OK":
                raise RunError("抓信失敗（伺服器沒回 OK）")
            out += [d for d in data if isinstance(d, tuple)]
        return out

    def close(self) -> None:
        try:
            self.conn.logout()
        except Exception:
            pass


def _safe(e: Exception) -> str:
    """錯誤訊息可能帶回我們送出去的字串，截短避免把密碼之類的東西印出來。"""
    s = str(e)
    return (s[:120] + "…") if len(s) > 120 else s


def _labels_of(prefix: bytes) -> "list[str]":
    m = RE_LABELS.search(prefix)
    if not m:
        return []
    out = []
    for tok in re.findall(rb'"([^"]*)"|(\S+)', m.group(1)):
        raw = (tok[0] or tok[1]).decode("utf-8", errors="replace")
        if raw:
            out.append(_imap_utf7(raw))   # Gmail 用修改版 UTF-7 送非 ASCII 標籤名
    return out


def _imap_utf7(s: str) -> str:
    """修改版 UTF-7（RFC 3501 §5.1.3）→ str；解不開就原樣回傳。"""
    if "&" not in s:
        return s
    out, i = [], 0
    while i < len(s):
        if s[i] != "&":
            out.append(s[i])
            i += 1
            continue
        j = s.find("-", i)
        if j < 0:
            out.append(s[i:])
            break
        chunk = s[i + 1:j]
        if chunk == "":
            out.append("&")
        else:
            try:
                b64 = chunk.replace(",", "/")
                b64 += "=" * (-len(b64) % 4)
                out.append(base64.b64decode(b64).decode("utf-16-be", errors="replace"))
            except Exception:
                out.append("&" + chunk + "-")
        i = j + 1
    return "".join(out)


# ====== 收集 ======

def _thread_url(thrid: str) -> str:
    try:
        return f"https://mail.google.com/mail/u/0/#all/{int(thrid):x}"
    except ValueError:
        return "https://mail.google.com/mail/u/0/"


def _blank_thread(thrid: str) -> dict:
    return {"thrid": thrid, "n": 0, "n_unread": 0, "labels": set(), "msgs": [],
            "starred": False, "answered": False}


def _msg_record(prefix: bytes, head: bytes, me: "set[str]") -> dict:
    msg = email.message_from_bytes(head)
    flags = (RE_FLAGS.search(prefix).group(1) if RE_FLAGS.search(prefix) else b"").decode("ascii", "replace")
    idt = RE_INTERNALDATE.search(prefix)
    internal = None
    if idt:
        try:
            ts = imaplib.Internaldate2tuple(b'INTERNALDATE "' + idt.group(1) + b'"')
            internal = datetime.fromtimestamp(time.mktime(ts), tz=timezone.utc)
        except Exception:
            internal = None
    frm = parse_addrs(msg.get("From"))
    to = parse_addrs(msg.get("To"))
    cc = parse_addrs(msg.get("Cc"))
    uid_m, msgid_m, thrid_m = RE_UID.search(prefix), RE_MSGID.search(prefix), RE_THRID.search(prefix)
    return {
        "uid": uid_m.group(1).decode() if uid_m else "",
        "thrid": thrid_m.group(1).decode() if thrid_m else "",
        "gmsgid": msgid_m.group(1).decode() if msgid_m else "",
        "subject": decode_hdr(msg.get("Subject")) or "(無主旨)",
        "from": frm[0] if frm else {"name": "(未知寄件者)", "addr": ""},
        "to": [a["addr"] for a in to],
        "cc": [a["addr"] for a in cc],
        "at": internal or msg_date(msg),
        "unread": "\\Seen" not in flags,
        "answered": "\\Answered" in flags,
        "starred": "\\Flagged" in flags,
        "list_id": decode_hdr(msg.get("List-Id")),
        "reply_to": [a["addr"] for a in parse_addrs(msg.get("Reply-To"))],
        "in_thread": bool(msg.get("In-Reply-To") or msg.get("References")),
        "labels": _labels_of(prefix),
        "from_me": bool(frm) and frm[0]["addr"] in me,
        "direct": bool(me & {a["addr"] for a in to}),
    }


def excluded(t: dict, rules: "list[dict]") -> bool:
    """整串從報告裡拿掉：一條規則裡的每個欄位都要中（AND），規則之間是 OR。

    `body` 要等信件內文抓回來才比得了，所以帶 body 的規則晚一步套（見 _drop_by_body）。
    """
    if not rules:
        return False
    labels = {l.lower() for l in t["labels"]}
    addr = (t["from_addr"] or "").lower()
    subject = (t["subject"] or "").lower()
    body = (t.get("_body") or "").lower()
    replyto = " ".join(t.get("reply_to") or []).lower()
    for rule in rules:
        if "label" in rule and rule["label"] not in labels:
            continue
        if "from" in rule and rule["from"] not in addr:
            continue
        if "subject" in rule and rule["subject"] not in subject:
            continue
        if "replyto" in rule and rule["replyto"] not in replyto:
            continue
        if "body" in rule and rule["body"] not in body:
            continue
        return True
    return False


def _drop_by_body(threads: "list[dict]", rules: "list[dict]") -> "list[dict]":
    """內文抓回來之後再跑一次 exclude，然後把比對用的全文丟掉（不進快照）。"""
    body_rules = [r for r in rules if "body" in r]
    kept = [t for t in threads if not (body_rules and excluded(t, body_rules))]
    if len(kept) < len(threads):
        log(f"  依 exclude 的 body 規則再拿掉 {len(threads) - len(kept)} 串")
    for t in kept:
        t.pop("_body", None)
    return kept


def _fold(records: "list[dict]", config: dict) -> "list[dict]":
    """一封一封的紀錄 → 對話串。"""
    me = set(config["me"])
    threads: "dict[str, dict]" = {}
    for r in records:
        t = threads.setdefault(r["thrid"] or r["gmsgid"] or r["uid"], _blank_thread(r["thrid"]))
        t["msgs"].append(r)
        t["n"] += 1
        t["n_unread"] += int(r["unread"])
        t["starred"] = t["starred"] or r["starred"]
        # IMAP 送來的系統標籤長這樣：\Inbox、\Important、\Category_Promotions（反斜線數量不定）
        t["labels"].update(l for l in r["labels"] if not l.lstrip().startswith("\\"))
    out = []
    for key, t in threads.items():
        msgs = sorted(t["msgs"], key=lambda m: (m["at"], m["gmsgid"], m["uid"]))
        last = msgs[-1]
        senders = []
        for m in msgs:
            nm = m["from"]["name"] or m["from"]["addr"]
            if nm and nm not in senders:
                senders.append(nm)
        out.append({
            "thrid": t["thrid"] or key,
            "subject": last["subject"],
            "from_name": last["from"]["name"],
            "from_addr": last["from"]["addr"],
            "senders": senders,
            "to": sorted(set(last["to"])),
            "cc": sorted(set(last["cc"])),
            "reply_to": sorted(set(last["reply_to"])),
            "first_at": js_iso(msgs[0]["at"]),
            "last_at": js_iso(last["at"]),
            "n": t["n"],
            "n_unread": t["n_unread"],
            "labels": sorted(t["labels"]),
            "unread": t["n_unread"] > 0,
            # 「我回過」只看最新一封：對方又回一封就會變回待回覆
            "answered": last["from_me"] or last["answered"],
            # 「只寄給我」：最新一封的 To 只有我一個（Cc 不算）
            "only_me": bool(last["to"]) and set(last["to"]) <= me,
            # 「真人對話」：最新一封是回覆別人的，或這串有來有往
            "conversation": last["in_thread"] or len(senders) > 1,
            "starred": t["starred"],
            "list_id": last["list_id"],
            "direct": any(m["direct"] for m in msgs),
            "from_me": last["from_me"],
            "has_attachment": False,          # 由 body 階段補
            "snippet": "",                    # 由 body 階段補
            "last_uid": last["uid"],
            "last_msgid": last["gmsgid"],
            "url": _thread_url(t["thrid"] or key),
        })
    head_rules = [r for r in config["exclude"] if "body" not in r]
    kept = [t for t in out if not excluded(t, head_rules)]
    if len(kept) < len(out):
        log(f"  依 exclude 規則拿掉 {len(out) - len(kept)} 串")
    kept.sort(key=lambda t: (t["last_at"], t["thrid"]), reverse=True)
    return kept[:config["maxThreads"]]


def _add_bodies(gm: "Gmail | None", threads: "list[dict]", config: dict,
                bodies: "dict[str, bytes] | None" = None) -> None:
    limit = config["bodyChars"]
    if limit <= 0:
        return
    if bodies is None:
        uids = [t["last_uid"].encode() for t in threads if t["last_uid"]]
        if not uids or gm is None:
            return
        raw = {}
        for prefix, payload in gm.fetch(uids, f"(UID BODY.PEEK[]<0.{BODY_PREFIX_BYTES}>)"):
            m = RE_UID.search(prefix)
            if m and payload:
                raw[m.group(1).decode()] = payload
        bodies = raw
    for t in threads:
        payload = bodies.get(t["last_uid"])
        if not payload:
            continue
        try:
            msg = email.message_from_bytes(payload)
        except Exception:
            continue
        text = body_text(msg)
        t["_body"] = text                 # 只給 exclude 的 body 規則比對，之後丟掉
        t["snippet"] = clean_snippet(text, limit)
        t["has_attachment"] = has_attachment(msg)


def collect(config: dict, user: str, password: str) -> "tuple[dict, datetime]":
    now = datetime.now(timezone.utc)
    me = set(config["me"])
    gm = Gmail(config["imapHost"], user, password, config["mailbox"])
    try:
        log(f"  信箱：{_imap_utf7(gm.mailbox)}（唯讀）")
        uids = gm.search(config["query"])
        log(f"  搜尋：{config['query']} → {len(uids)} 封")
        records = []
        if uids:
            what = (f"(UID FLAGS INTERNALDATE X-GM-THRID X-GM-MSGID X-GM-LABELS "
                    f"BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])")
            for prefix, head in gm.fetch(uids, what):
                try:
                    records.append(_msg_record(prefix, head or b"", me))
                except Exception as e:   # 單封壞信不讓整輪失敗
                    log(f"  ⚠ 跳過一封解析失敗的信（{type(e).__name__}）")
        threads = _fold(records, config)
        _add_bodies(gm, threads, config)
        threads = _drop_by_body(threads, config["exclude"])
        log(f"  對話串：{len(threads)} 串（{len(records)} 封）")
    finally:
        gm.close()
    return _content(config, threads, now, len(records)), now


def collect_fixture(config: dict, folder: Path) -> "tuple[dict, datetime]":
    """離線模式：把一個資料夾裡的 .eml 當搜尋結果，用 References/主旨併成對話串。"""
    now = datetime.now(timezone.utc)
    me = set(config["me"])
    files = sorted(folder.glob("*.eml"))
    if not files:
        raise RunError(f"{folder} 裡沒有 .eml 檔")
    records, bodies = [], {}
    for n, f in enumerate(files, 1):
        raw = f.read_bytes()
        msg = email.message_from_bytes(raw)
        subj = decode_hdr(msg.get("Subject")) or "(無主旨)"
        base = re.sub(r"(?i)^\s*(re|fw|fwd|回覆|轉寄)\s*[:：]\s*", "", subj).strip()
        thrid = str(int(hashlib.sha256(base.encode("utf-8")).hexdigest()[:12], 16))
        prefix = (f'{n} (UID {n} X-GM-THRID {thrid} X-GM-MSGID {n} '
                  f'FLAGS ({msg.get("X-Test-Flags", "")}) '
                  f'X-GM-LABELS ({decode_hdr(msg.get("X-Test-Labels")) or ""}) '
                  f'INTERNALDATE "{msg.get("X-Test-Internaldate", "01-Jan-2026 00:00:00 +0800")}"').encode()
        records.append(_msg_record(prefix, raw, me))
        bodies[str(n)] = raw
    threads = _fold(records, config)
    _add_bodies(None, threads, config, bodies)
    threads = _drop_by_body(threads, config["exclude"])
    log(f"  離線來源：{len(files)} 封 → {len(threads)} 串")
    return _content(config, threads, now, len(records)), now


def _content(config: dict, threads: "list[dict]", now: datetime, n_msgs: int) -> dict:
    if len(threads) > config["maxThreads"]:
        log(f"  ⚠ 已達 maxThreads={config['maxThreads']}，較舊的對話串被截掉")
    return {
        "account": config["me"][0],
        "imapHost": config["imapHost"],
        "mailbox": config["mailbox"],
        "query": config["query"],
        "me": config["me"],
        "labelOrder": config["labelOrder"],
        "bodyChars": config["bodyChars"],
        "maxThreads": config["maxThreads"],
        "timezone": config["timezone"],
        "period": now.astimezone(ZoneInfo(config["timezone"])).strftime("%Y-%m-%d"),
        "messageCount": n_msgs,
        "threads": sorted(threads, key=lambda t: t["thrid"]),
    }


def write_snapshot(work_dir: Path, content: dict, now: datetime) -> "tuple[str, dict]":
    sid = sha256_hex(content)
    snap = {"id": sid, "collectedAt": js_iso(now), **content}
    data = json.dumps(snap, ensure_ascii=False, indent=2) + "\n"
    if len(data.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        raise RunError(LIMIT_MSG.format(n=len(content["threads"])))
    folder = work_dir / "gmail-inputs"
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{sid}.json"
    if not dest.exists():
        tmp = folder / f"{sid}.{os.getpid()}.tmp"
        tmp.write_text(data, encoding="utf-8")
        os.replace(tmp, dest)
        log(f"  快照：已寫 {dest.name}")
    else:
        log(f"  快照：{dest.name} 已存在，不覆寫（沿用檔內 collectedAt）")
        try:
            snap = json.loads(dest.read_text(encoding="utf-8"))
        except Exception:
            raise RunError(f"既有快照無法讀取：{dest}")
    return sid, snap


# ====== 整理 ======

def tz_label(tz: str) -> str:
    return tz.split("/")[-1].replace("_", " ")


def fmt_local(s: str, tz: ZoneInfo) -> str:
    dt = parse_ts(s).astimezone(tz)
    return dt.strftime("%Y-%m-%d %H:%M:%S.") + f"{dt.microsecond // 1000:03d}"


def flags_of(t: dict) -> str:
    f = ""
    if t["unread"]:
        f += "U"
    if t["direct"]:
        f += "D"
    if t.get("only_me"):
        f += "O"
    if t["answered"]:
        f += "R"
    if t["starred"]:
        f += "S"
    if t["list_id"]:
        f += "L"
    if t["has_attachment"]:
        f += "A"
    return f


def group_of(t: dict, order: "list[str]") -> str:
    for want in order:
        if want in t["labels"]:
            return want
    if t["labels"]:
        return t["labels"][0]
    return "（無標籤）"


def sort_key(r: dict):
    return (r["last_at"], r["thrid"])


def build_model(snapshot: dict, sources: dict) -> dict:
    tzname = snapshot.get("timezone") or sources.get("timezone")
    if not tzname:
        raise RunError("快照與 sources.json 都沒有 timezone，無法轉換時間")
    try:
        tz = ZoneInfo(tzname)
    except Exception:
        raise RunError(f"timezone 無效：{tzname}")
    order = [str(x) for x in as_list(snapshot.get("labelOrder"))]
    rows = []
    for t in snapshot["threads"]:
        rows.append({
            **t,
            "flags": flags_of(t),
            "group": group_of(t, order),
            "last_local": fmt_local(t["last_at"], tz),
            "first_local": fmt_local(t["first_at"], tz),
            "sender": ("我" if t["from_me"] else (t["from_name"] or t["from_addr"])),
            "domain": t["from_addr"].split("@")[-1] if "@" in t["from_addr"] else "",
            "key": t["thrid"],
            "fingerprint": f"{t['thrid']}:{t['last_msgid']}",
        })
    rows.sort(key=sort_key, reverse=True)
    groups, seen = [], {}
    for r in rows:
        seen.setdefault(r["group"], []).append(r)
    for name in order + sorted(k for k in seen if k not in order):
        if name in seen:
            groups.append({"name": name, "rows": seen[name]})
    return {
        "tz": tz, "tzname": tzname, "tzlabel": tz_label(tzname),
        "collected_local": fmt_local(snapshot["collectedAt"], tz),
        "account": snapshot["account"], "mailbox": snapshot["mailbox"],
        "query": snapshot["query"], "me": snapshot["me"],
        "date": snapshot["period"],
        "rows": rows, "groups": groups,
        "by_key": {r["key"]: r for r in rows},
        "n_threads": len(rows),
        "n_unread": sum(1 for r in rows if r["unread"]),
        "n_direct": sum(1 for r in rows if r["direct"]),
        "n_msgs": snapshot.get("messageCount", 0),
        "labels": sorted({l for r in rows for l in r["labels"]}),
        "replyExclude": [x.lower() for x in as_list(sources.get("replyExcludeLabels"))],
    }


def reply_by_rule(model: dict) -> "list[dict]":
    """待我回覆：我在 To、最新一封還沒被我回覆（也不是我自己寄的）、不是清單信。

    另外排除 replyExcludeLabels 列到的標籤（那些是看板型的通知，不是對話），
    並且把「To 只有我一個」的排在前面——那種才是真的在等我回話。
    """
    skip = set(model.get("replyExclude") or [])
    picked = []
    for r in model["rows"]:
        if NO_REPLY_RE.search(r["from_addr"] or ""):
            continue  # noreply@／notification@ 這類寄件者回了也沒人看
        if AUTO_MAIL_RE.search(r["snippet"] or ""):
            continue  # 內文自己寫了「請勿回信／系統自動發送」
        if skip & {l.lower() for l in r["labels"]}:
            continue
        if r["direct"] and not r["answered"] and not r["list_id"]:
            picked.append(r)
    picked.sort(key=reply_rank)   # 穩定排序，同一層內維持時間序
    return [{"key": r["key"], "kind": reply_kind(r), "text": r["snippet"] or r["subject"]}
            for r in picked[:REPLY_MAX]]


def reply_kind(r: dict) -> str:
    if r.get("conversation"):
        return "真人對話"
    if ACTION_RE.search(r["subject"] or "") or ACTION_RE.search(r["snippet"] or ""):
        return "要我做事"
    return "只寄給我" if r.get("only_me") else "待回覆"


def reply_rank(r: dict) -> tuple:
    """排序：真人對話 → 要我做事 → 其他；每層裡「只寄給我」優先，例行報表墊底。"""
    kind = reply_kind(r)
    tier = {"真人對話": 0, "要我做事": 1}.get(kind, 2)
    if REPORT_RE.search(r["subject"] or ""):
        tier = 3
    return (tier, 0 if r.get("only_me") else 1)


def finalize_reply(items: "list[dict]", model: dict) -> "list[dict]":
    out = []
    for it in items:
        r = model["by_key"].get(it.get("key"))
        if not r:
            continue
        out.append({"key": r["key"], "url": r["url"], "subject": r["subject"],
                    "sender": r["sender"], "updated": r["last_local"],
                    "kind": it.get("kind") or "待回覆", "text": it.get("text") or r["snippet"],
                    "new": r["unread"], "noteKey": r["fingerprint"]})
    return out


# ====== 渲染 ======

def render_md(model: dict, reply: "list[dict]", work_dir: Path) -> str:
    L = ["# Gmail 收件匣摘要", "",
         f"收集時間：{model['collected_local']} ({model['tzlabel']})",
         f"信箱：{model['account']}（{model['mailbox']}，唯讀）",
         f"篩選規則：{model['query']}", "", "---", "", "## 摘要與統計",
         f"- **對話串**：{model['n_threads']} 串（{model['n_msgs']} 封）",
         f"- **未讀**：{model['n_unread']} 串",
         f"- **直接寄給我**：{model['n_direct']} 串",
         f"- **待我回覆**：{len(reply)} 串", ""]
    for g in model["groups"]:
        L.append(f"- `{g['name']}`：{len(g['rows'])} 串（未讀 {sum(1 for r in g['rows'] if r['unread'])}）")
    if reply:
        L += ["", "## 待我回覆", ""]
        for i, c in enumerate(reply, 1):
            mark = "🆕 " if c["new"] else ""
            L.append(f"{i}. {mark}**[{c['sender']}] {c['subject']}**")
            L.append(f"   - {c['kind']}：{c['text']}")
            L.append(f"   - {c['updated']} · {c['url']}")
    L += ["", "## 全部對話串", ""]
    for g in model["groups"]:
        L += [f"### {g['name']}", ""]
        for r in g["rows"]:
            tags = "".join(f"`{x}`" for x in r["flags"]) or "`-`"
            L.append(f"- [{r['sender']}] **{r['subject']}** {tags}"
                     + (f"（{r['n']} 封）" if r["n"] > 1 else ""))
            L.append(f"  - {r['last_local']} · {r['url']}")
        L.append("")
    L += ["---", "", f"（本摘要由 gmail_inbox.py 產生，工作目錄 {work_dir.as_posix()}）"]
    return "\n".join(L) + "\n"


def render_html(model: dict, reply: "list[dict]", template: str) -> str:
    data = {
        "date": model["date"],
        "collectedAt": f"{model['collected_local']} ({model['tzlabel']})",
        "timezone": model["tzname"],
        "account": model["account"],
        "mailbox": model["mailbox"],
        "query": model["query"],
        "filterRule": model["query"],
        "labels": model["labels"],
        "reply": reply,
        "groups": [{
            "name": g["name"],
            "rows": [[r["thrid"], r["subject"], r["sender"], r["last_local"], r["flags"],
                      r["fingerprint"], r["labels"], r["n"], r["snippet"], r["url"],
                      r["from_addr"]]
                     for r in g["rows"]],
        } for g in model["groups"]],
    }
    m = DATA_RE.search(template)
    if not m:
        raise RunError("模板裡找不到 <script id=\"data\"> 區塊")
    body = json.dumps(data, ensure_ascii=False, indent=2)
    return template[:m.start(2)] + "\n" + body + "\n" + template[m.end(2):]


# ====== 通知回執 ======

def build_notice(model: dict, reply: "list[dict]", sid: str, work_dir: Path) -> dict:
    t = [f"【總覽】{model['n_threads']} 串、未讀 {model['n_unread']}、直接寄給我 {model['n_direct']}"]
    t += [f"- {g['name']}: {len(g['rows'])} 串" for g in model["groups"]]
    t += ["", "【待我回覆】"]
    t += [f"- [{c['sender']}] {c['subject']}" for c in reply] or ["- 無"]
    t += ["", f"完整稿件：{work_dir.as_posix()}/briefs/latest.html (Markdown: latest.md)"]
    text = "\n".join(t)
    if len(text) > 4000:
        text = text[:3990] + "…"
    return {"key": f"gmail-brief-{sid}", "title": "Gmail 收件匣整理好了", "text": text, "fyi": True}


# ====== 寫檔 ======

def atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_outputs(work_dir: Path, sid: str, period: str, md: str, html_text: str) -> None:
    briefs = work_dir / "briefs"
    briefs.mkdir(parents=True, exist_ok=True)
    (briefs / f"{sid}.md").write_text(md, encoding="utf-8")
    (briefs / f"{sid}.html").write_text(html_text, encoding="utf-8")
    atomic_write(briefs / "latest.md", md)
    atomic_write(briefs / "latest.html", html_text)
    atomic_write(briefs / f"{period}.md", md)
    atomic_write(briefs / f"{period}.html", html_text)
    if abs((briefs / "latest.md").stat().st_mtime - (briefs / "latest.html").stat().st_mtime) > 60:
        raise RunError("latest 兩檔不同步")
    m = re.search(r"^收集時間：(.+)$", md, re.M)
    if not m or m.group(1) not in html_text:
        raise RunError("latest 兩檔不同步（收集時間字串不一致）")


def load_seen(work_dir: Path) -> "list[str]":
    p = work_dir / "briefs" / "seen.json"
    try:
        v = json.loads(p.read_text(encoding="utf-8"))
        return v if isinstance(v, list) else []
    except Exception:
        return []


def save_seen(work_dir: Path, seen: "list[str]") -> None:
    atomic_write(work_dir / "briefs" / "seen.json", json.dumps(seen, indent=2) + "\n")


# ====== 主流程 ======

def _win_user_env(name: str) -> str:
    r"""Windows：讀 HKCU\Environment 的使用者環境變數（值不落地、不印出）。"""
    if sys.platform != "win32":
        return ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return str(winreg.QueryValueEx(k, name)[0]).strip()
    except Exception:
        return ""


def read_credentials() -> tuple:
    """認證只從環境變數來，絕不寫檔、絕不印出。

    GMAIL_AGENT 支援兩種寫法：
      1. 只放應用程式密碼 → 信箱另外用 GMAIL_USER（或 sources.json 的 me 第一筆）。
      2. "信箱:應用程式密碼" 一行帶走。
    舊的 GMAIL_USER / GMAIL_APP_PASSWORD 仍可用。
    """
    user = (os.environ.get("GMAIL_USER") or "").strip()
    password = (os.environ.get("GMAIL_APP_PASSWORD") or "").replace(" ", "")
    agent = (os.environ.get("GMAIL_AGENT") or "").strip()
    if not agent and not password:
        # 排程的 hub 行程可能比 setx 早啟動，拿不到新設的使用者變數 → 直接讀登錄檔
        agent = _win_user_env("GMAIL_AGENT")
        user = user or _win_user_env("GMAIL_USER")
        password = password or _win_user_env("GMAIL_APP_PASSWORD").replace(" ", "")
    if agent:
        if "@" in agent.split(":", 1)[0]:
            head, _, tail = agent.partition(":")
            if tail.strip():
                user = user or head.strip()
                password = password or tail.replace(" ", "").strip()
            else:
                user = user or head.strip()
        else:
            password = password or agent.replace(" ", "")
    return user.lower(), password


def main() -> int:
    parser = argparse.ArgumentParser(description="把 Gmail 收件匣收成 dashboard（唯讀）")
    parser.add_argument("--work-dir", default=str(DEFAULT_WORK_DIR), dest="work_dir",
                        help=f"工作目錄（預設 {DEFAULT_WORK_DIR.as_posix()}）")
    parser.add_argument("--dry-run", action="store_true", help="只收集與統計，不寫 briefs")
    parser.add_argument("--autoloop", action="store_true", help="結尾加印 agent-autoloop 回執區塊")
    parser.add_argument("--force", action="store_true", help="忽略 seen.json 重做")
    parser.add_argument("--fixture", default=None, help="離線模式：讀這個資料夾裡的 .eml，不連 IMAP")
    args = parser.parse_args()
    work_dir = Path(args.work_dir).expanduser().resolve()

    try:
        user, password = read_credentials()
        if not args.fixture and (not user or not password):
            raise RunError("請在環境變數設定 GMAIL_AGENT（或 GMAIL_USER + GMAIL_APP_PASSWORD）")
        sources = load_sources(work_dir, user)
        template_path = work_dir / "template.html"
        if not args.dry_run and not template_path.exists():
            raise RunError(f"找不到模板 {template_path}")

        log(f"  工作目錄：{work_dir}")
        if args.fixture:
            content, now = collect_fixture(sources, Path(args.fixture).expanduser().resolve())
        else:
            content, now = collect(sources, user, password)
        sid, snapshot = write_snapshot(work_dir, content, now)
        model = build_model(snapshot, sources)
        reply = finalize_reply(reply_by_rule(model), model)

        if args.dry_run:
            print(f"做完了（dry-run）：快照 {sid}，{model['n_threads']} 串、未讀 {model['n_unread']}、"
                  f"直接寄給我 {model['n_direct']}、待我回覆 {len(reply)}；未寫 briefs")
            print(f"收集時間：{model['collected_local']} ({model['tzlabel']})")
            for g in model["groups"]:
                print(f"- {g['name']}：{len(g['rows'])} 串")
            return 0

        seen = load_seen(work_dir)
        briefs = work_dir / "briefs"
        if (sid in seen and not args.force
                and (briefs / f"{sid}.md").exists() and (briefs / f"{sid}.html").exists()):
            print(f"没事可做：快照 {sid} 已處理")
            return 0

        md = render_md(model, reply, work_dir)
        html_text = render_html(model, reply, template_path.read_text(encoding="utf-8"))
        write_outputs(work_dir, sid, snapshot["period"], md, html_text)
        if sid not in seen:
            seen.append(sid)
        save_seen(work_dir, seen)
    except RunError as e:
        print(f"没跑成：{e}")
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"没跑成：{type(e).__name__}: {e}")
        return 1

    print(f"做完了：快照 {sid}，{model['n_threads']} 串、未讀 {model['n_unread']}、"
          f"直接寄給我 {model['n_direct']}、待我回覆 {len(reply)} "
          f"→ {(briefs / 'latest.html').as_posix()}")
    if args.autoloop:
        receipt = {"notice": [build_notice(model, reply, sid, work_dir)]}
        print("\n```agent-autoloop\n" + json.dumps(receipt, ensure_ascii=False) + "\n```")
    return 0


if __name__ == "__main__":
    sys.exit(main())
