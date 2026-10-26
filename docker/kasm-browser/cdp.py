"""
MCP agent 操作 remote-browser 的 Chromium:session-manager 經 Chrome DevTools Protocol(CDP)跑動作。

每個 session 的 chromium 帶 `--remote-debugging-port=<cdp_base + display>`,只聽在 127.0.0.1(容器內的
loopback;session-manager 跟 chromium 在同一個容器),所以 CDP 從來不對外,也不對 backend 開放 —— backend
只呼叫 session-manager 的 `POST /sessions/<id>/cdp`(X-Internal-Token)。每個動作都有時間上限(預設 30 秒)。

只用標準函式庫:CDP 走 WebSocket,這裡有一個最小的 client(握手 + 文字 frame + ping/pong,client 端遮罩)。

動作(JSON 的 "action"):
  navigate {url}                    → {url, title}
  screenshot {max_width}            → {data(base64 PNG), width, height, url, title}
  read {selector?, max_chars}       → {title, url, text, truncated, links}
  click {selector? | text?}         → {clicked, url, title}(真的滑鼠點擊:Input.dispatchMouseEvent)
  type {selector, text, press_enter} → {url, title}(Input.insertText + Enter 鍵)

Agent actions on the remote browser's Chromium over the DevTools Protocol. The debugging port listens on the
container's loopback only; the backend reaches it solely through the session-manager. Stdlib only, so this
module carries a minimal WebSocket client.
"""
import base64
import http.client
import json
import os
import socket
import struct
import time
import urllib.parse

ACTION_TIMEOUT = float(os.getenv("CDP_ACTION_TIMEOUT", "30"))
# 頁面載入最多等多久(在動作的時限內)。/ How long a page load is awaited (within the action's limit).
LOAD_WAIT = 15.0


class CdpError(Exception):
    pass


# --- minimal WebSocket client -----------------------------------------------------------------

def encode_frame(text, opcode=0x1, mask_key=None):
    """client → server 的 frame(一定要遮罩)。/ A client frame (always masked)."""
    payload = text.encode() if isinstance(text, str) else text
    mask_key = mask_key or os.urandom(4)
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 1 << 16:
        head += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", n)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(payload))
    return head + mask_key + masked


def _read_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise CdpError("the browser closed the DevTools connection")
        buf += chunk
    return buf


def read_frame(sock):
    """讀一個 frame → (fin, opcode, payload)。server 的 frame 不遮罩(遮了也照解)。/ Read one frame."""
    b1, b2 = _read_exact(sock, 2)
    fin, opcode = b1 & 0x80, b1 & 0x0F
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", _read_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack("!Q", _read_exact(sock, 8))[0]
    key = _read_exact(sock, 4) if b2 & 0x80 else None
    data = _read_exact(sock, n)
    if key:
        data = bytes(b ^ key[i % 4] for i, b in enumerate(data))
    return bool(fin), opcode, data


class WebSocket:
    def __init__(self, url, timeout):
        u = urllib.parse.urlsplit(url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (("?" + u.query) if u.query else "")
        req = (f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise CdpError("DevTools refused the WebSocket")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise CdpError("DevTools refused the WebSocket: " + head.split(b"\r\n", 1)[0].decode(errors="replace"))
        self.extra = head.split(b"\r\n\r\n", 1)[1]
        if self.extra:
            raise CdpError("unexpected data after the WebSocket handshake")

    def send(self, text):
        self.sock.sendall(encode_frame(text))

    def recv(self):
        parts = []
        while True:
            fin, opcode, data = read_frame(self.sock)
            if opcode == 0x9:  # ping
                self.sock.sendall(encode_frame(data, opcode=0xA))
                continue
            if opcode == 0x8:
                raise CdpError("the browser closed the DevTools connection")
            if opcode in (0x1, 0x2, 0x0):
                parts.append(data)
                if fin:
                    return b"".join(parts).decode(errors="replace")

    def close(self):
        try:
            self.sock.sendall(encode_frame(b"", opcode=0x8))
        except OSError:
            pass
        self.sock.close()


# --- CDP --------------------------------------------------------------------------------------

def _http_json(port, method, path, timeout):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status >= 400:
            raise CdpError(f"DevTools {path}: HTTP {resp.status}")
        return json.loads(body or b"null")
    finally:
        conn.close()


def pick_page(targets):
    """要操作的分頁:清單裡第一個一般網頁(Chromium 依最近使用排序)。/ The tab to drive: the first normal page."""
    for t in targets or []:
        if t.get("type") == "page" and not str(t.get("url", "")).startswith("devtools://") and t.get("webSocketDebuggerUrl"):
            return t
    return None


class Cdp:
    """對一個分頁的 CDP 連線;`deadline` 是整個動作的截止時間。/ A CDP connection to one tab."""

    def __init__(self, port, deadline):
        self.deadline = deadline
        targets = _http_json(port, "GET", "/json/list", self._left())
        target = pick_page(targets)
        if target is None:
            # 沒有分頁(使用者把它關了):開一個空白的。/ No tab left: open a blank one.
            target = _http_json(port, "PUT", "/json/new?about:blank", self._left())
        self.ws = WebSocket(target["webSocketDebuggerUrl"], self._left())
        self.next_id = 0

    def _left(self):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise CdpError("the browser action timed out")
        return left

    def call(self, method, params=None):
        self.next_id += 1
        mid = self.next_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        while True:
            self.ws.sock.settimeout(self._left())
            try:
                msg = json.loads(self.ws.recv())
            except socket.timeout:
                raise CdpError("the browser action timed out")
            if msg.get("id") != mid:
                continue  # 事件 / events
            if "error" in msg:
                raise CdpError(f"{method}: {msg['error'].get('message', msg['error'])}")
            return msg.get("result", {})

    def evaluate(self, expression):
        r = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        if r.get("exceptionDetails"):
            d = r["exceptionDetails"]
            raise CdpError("page script failed: " + str((d.get("exception") or {}).get("description") or d.get("text")))
        return (r.get("result") or {}).get("value")

    def close(self):
        self.ws.close()


# --- page scripts (JSON-quoted arguments only) -----------------------------------------------

def read_js(selector, max_chars):
    return f"""(() => {{
  const sel = {json.dumps(selector)}, max = {int(max_chars)};
  const root = sel ? document.querySelector(sel) : (document.body || document.documentElement);
  if (!root) return {{ error: "No element matches " + sel }};
  let text = (root.innerText || root.textContent || "").replace(/\\n{{3,}}/g, "\\n\\n").trim();
  const truncated = text.length > max;
  if (truncated) text = text.slice(0, max);
  const links = Array.from(root.querySelectorAll("a[href]")).map(a => ({{ text: (a.innerText || a.title || "").replace(/\\s+/g, " ").trim().slice(0, 200), href: a.href }}))
    .filter(l => /^https?:/.test(l.href)).slice(0, 200);
  return {{ title: document.title, url: location.href, text, truncated, links }};
}})()"""


def locate_js(selector, text):
    return f"""(() => {{
  const sel = {json.dumps(selector)}, want = {json.dumps(text)};
  const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  let el = null;
  if (sel) el = document.querySelector(sel);
  else {{
    const w = norm(want);
    const label = e => norm(e.innerText || e.value || e.getAttribute("aria-label") || e.title);
    const cands = Array.from(document.querySelectorAll("a,button,input[type=submit],input[type=button],[role=button],[role=link],[role=tab],[role=menuitem],label,summary,[onclick]"));
    el = cands.find(e => label(e) === w) || cands.find(e => label(e).includes(w));
    if (!el) {{
      const all = Array.from(document.querySelectorAll("body *")).filter(e => norm(e.innerText).includes(w));
      all.sort((a, b) => norm(a.innerText).length - norm(b.innerText).length);
      el = all[0] || null;
    }}
  }}
  if (!el) return {{ error: sel ? "No element matches " + sel : "Nothing on the page shows the text " + JSON.stringify(want) }};
  el.scrollIntoView({{ block: "center", inline: "center" }});
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return {{ error: "The element is not visible" }};
  const name = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
  const shown = norm(el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 80);
  return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, label: shown ? name + " \\u201c" + shown + "\\u201d" : name }};
}})()"""


def focus_js(selector):
    return f"""(() => {{
  const el = document.querySelector({json.dumps(selector)});
  if (!el) return {{ error: "No element matches " + {json.dumps(selector)} }};
  el.scrollIntoView({{ block: "center" }});
  el.focus();
  if (document.activeElement !== el) return {{ error: "The element can't take keyboard input" }};
  if (typeof el.value === "string" && el.setSelectionRange) {{ try {{ el.setSelectionRange(el.value.length, el.value.length); }} catch (e) {{}} }}
  return {{ ok: true }};
}})()"""


PAGE_INFO_JS = "({ url: location.href, title: document.title, ready: document.readyState })"


# --- actions ----------------------------------------------------------------------------------

def _checked(value):
    if isinstance(value, dict) and value.get("error"):
        raise CdpError(value["error"])
    return value


def _wait_loaded(cdp, settle=0.0):
    """等頁面 readyState = complete(最多 LOAD_WAIT,且不超過動作時限)。/ Wait for the page to finish loading."""
    if settle:
        time.sleep(settle)
    until = min(time.monotonic() + LOAD_WAIT, cdp.deadline - 0.5)
    info = cdp.evaluate(PAGE_INFO_JS) or {}
    while info.get("ready") != "complete" and time.monotonic() < until:
        time.sleep(0.25)
        info = cdp.evaluate(PAGE_INFO_JS) or {}
    return {"url": info.get("url"), "title": info.get("title")}


def run_action(cdp, action):
    """一個動作(`cdp` 是 [`Cdp`] 或測試用的假物件)。/ Run one action on a CDP connection."""
    kind = action.get("action")
    if kind == "navigate":
        url = action.get("url") or ""
        if not url.startswith(("http://", "https://")):
            raise CdpError("only http and https URLs can be opened")
        r = cdp.call("Page.navigate", {"url": url})
        if r.get("errorText"):
            raise CdpError(f"could not open {url}: {r['errorText']}")
        try:
            cdp.call("Page.bringToFront")
        except CdpError:
            pass
        return _wait_loaded(cdp, settle=0.2)
    if kind == "screenshot":
        max_width = int(action.get("max_width") or 1280)
        vv = cdp.call("Page.getLayoutMetrics").get("cssVisualViewport") or {}
        w, h = float(vv.get("clientWidth") or 1280), float(vv.get("clientHeight") or 720)
        scale = min(1.0, max_width / w) if w else 1.0
        clip = {"x": float(vv.get("pageX") or 0), "y": float(vv.get("pageY") or 0), "width": w, "height": h, "scale": scale}
        shot = cdp.call("Page.captureScreenshot", {"format": "png", "clip": clip})
        info = cdp.evaluate(PAGE_INFO_JS) or {}
        return {"data": shot.get("data"), "width": round(w * scale), "height": round(h * scale), "url": info.get("url"), "title": info.get("title")}
    if kind == "read":
        return _checked(cdp.evaluate(read_js(action.get("selector"), action.get("max_chars") or 100000)))
    if kind == "click":
        if not (action.get("selector") or action.get("text")):
            raise CdpError("give a selector or a text to click")
        spot = _checked(cdp.evaluate(locate_js(action.get("selector"), action.get("text"))))
        x, y = spot["x"], spot["y"]
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
        cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
        cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
        out = _wait_loaded(cdp, settle=0.4)
        out["clicked"] = spot.get("label")
        return out
    if kind == "type":
        selector = action.get("selector") or ""
        if not selector:
            raise CdpError("selector is empty")
        _checked(cdp.evaluate(focus_js(selector)))
        if action.get("text"):
            cdp.call("Input.insertText", {"text": action["text"]})
        if action.get("press_enter"):
            key = {"key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13}
            cdp.call("Input.dispatchKeyEvent", dict(key, type="keyDown", text="\r"))
            cdp.call("Input.dispatchKeyEvent", dict(key, type="keyUp"))
            return _wait_loaded(cdp, settle=0.4)
        return _wait_loaded(cdp)
    raise CdpError(f"unknown action {kind!r}")


def perform(port, action, timeout=ACTION_TIMEOUT):
    """連上那個 session 的 DevTools、跑一個動作、斷線。/ Connect to the session's DevTools, run one action, disconnect."""
    deadline = time.monotonic() + min(float(timeout), ACTION_TIMEOUT)
    try:
        cdp = Cdp(port, deadline)
    except (OSError, ValueError, KeyError) as e:
        raise CdpError(f"cannot reach the browser's DevTools (is the browser running?): {e}")
    try:
        return run_action(cdp, action)
    except (OSError, ValueError) as e:
        raise CdpError(str(e))
    finally:
        cdp.close()
