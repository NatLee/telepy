#!/usr/bin/env python3
"""
KasmVNC websocket 探測工具 —— 用「非 KasmVNC 自家前端」的 WebSocket client 連上 KasmVNC 的 websocket,
確認以下三件事(除錯上游連不上時很有用,見 docs/remote-browser.md 疑難排解):
  A. TLS 有沒有關成純 ws(kasmvnc.yaml 的 network.ssl.require_ssl:false 有沒有生效)。
  B. Basic Auth 有沒有關(Xkasmvnc 的 -disableBasicAuth 有沒有生效;沒關會回 401)。
  C. websocket path / subprotocol 對不對、server 會不會先送 greeting(VNC 是 server 先說話)。

**只用 Python 標準函式庫**,不需 pip 裝任何東西 —— 可直接在 kasm-browser 或 backend 容器內跑
(兩者都只有 python3 stdlib)。

──────────────────────────────────────────────────────────────────────────────
怎麼跑(在你的 Docker 環境):

  1) 先讓一顆 KasmVNC session 跑起來,拿到 ws_port。兩種方式擇一:

     (a) 經 session-manager API(最貼近正式路徑):
         docker compose exec kasm-browser python3 - <<'PY'
         import urllib.request, json, os
         req = urllib.request.Request(
             "http://127.0.0.1:7000/sessions",
             data=json.dumps({"proxy": "socks5://127.0.0.1:1", "geometry": "1280x720"}).encode(),
             headers={"Content-Type": "application/json",
                      "X-Internal-Token": os.environ["INTERNAL_API_TOKEN"]})
         print(urllib.request.urlopen(req).read().decode())   # → {"session_id":..., "ws_port": 8453}
         PY
         # 注意:proxy 指向不存在的埠沒關係,chromium 起不來不影響「KasmVNC ws 能不能連」的驗證。

     (b) 手動起一顆 Xkasmvnc(display :10 → ws_port 8453):
         docker compose exec kasm-browser bash -lc \
           'Xkasmvnc :10 -geometry 1280x720 -depth 24 -SecurityTypes None -disableBasicAuth \
            -websocketPort 8453 -interface 0.0.0.0 -desktop telepy & sleep 3'

  2) 把本檔複製進容器並跑探測(host 用 127.0.0.1 在 kasm-browser 內、或 kasm-browser 在 backend 內):
         docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
         docker compose exec kasm-browser python3 /tmp/probe.py --port 8453

     它會自動試幾個常見 path(/websockify、/、/api/vnc、…)與 binary subprotocol,
     並印出:命中的 path、是否需要 TLS、是否被要求登入、收到的 greeting 前幾個位元組。

  3) 判讀:
       ✅ PASS(某 path 回 101 + 收到 greeting,如 "RFB 003.00x")
          → 採 KasmVNC WS-proxy。把命中的 path/scheme/subprotocol 寫進 backend env:
            KASM_WS_PATH / KASM_WS_SCHEME / KASM_WS_SUBPROTOCOL(見 tunnels/consumers.py)。
       ❌ 全部 401 → basic auth 沒關乾淨(檢查 -disableBasicAuth / kasmvnc.yaml)。
       ❌ 只有 wss 能連(ws 被拒/timeout)→ require_ssl 沒關成功;設 KASM_WS_SCHEME=wss。
       ❌ 全部連不上/沒 greeting → path/subprotocol 兜不攏;回報 no-go,維持 TigerVNC。
──────────────────────────────────────────────────────────────────────────────
"""
import sys
import ssl
import os
import base64
import hashlib
import socket
import struct
import argparse

CANDIDATE_PATHS = ["/websockify", "/", "/api/vnc", "/websocket", "/vnc"]
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"   # RFC 6455 magic


def _http_upgrade(sock, host, port, path, subprotocol, auth_header=None):
    """送 WebSocket Upgrade 請求,回 (status_code, headers_dict, leftover_bytes)。"""
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
        # KasmVNC 的 websocket 檢查要求這個 legacy header,缺了回 404 "failed websocket checks"
        f"Sec-WebSocket-Origin: http://{host}:{port}",
    ]
    if subprotocol:
        lines.append(f"Sec-WebSocket-Protocol: {subprotocol}")
    if auth_header:
        lines.append(f"Authorization: {auth_header}")
    req = ("\r\n".join(lines) + "\r\n\r\n").encode()
    sock.sendall(req)

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 65536:
            break
    header_blob, _, leftover = buf.partition(b"\r\n\r\n")
    header_text = header_blob.decode("latin-1", "replace")
    status_line = header_text.split("\r\n", 1)[0]
    try:
        status = int(status_line.split()[1])
    except (IndexError, ValueError):
        status = -1
    headers = {}
    for line in header_text.split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    # 驗 Sec-WebSocket-Accept(確認對方確實做了 WS 交握)
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
    headers["_accept_ok"] = str(headers.get("sec-websocket-accept") == accept)
    return status, headers, leftover


def _read_frame(sock, leftover):
    """讀一個 server→client 的 WS frame(未遮罩),回 (opcode, payload) 或 (None, b'')。"""
    buf = bytearray(leftover)

    def _need(n):
        nonlocal buf
        while len(buf) < n:
            sock.settimeout(3.0)
            try:
                chunk = sock.recv(4096)
            except socket.timeout:
                return False
            if not chunk:
                return False
            buf.extend(chunk)
        return True

    if not _need(2):
        return None, b""
    b0, b1 = buf[0], buf[1]
    opcode = b0 & 0x0F
    masked = b1 & 0x80
    length = b1 & 0x7F
    idx = 2
    if length == 126:
        if not _need(4):
            return None, b""
        length = struct.unpack(">H", bytes(buf[2:4]))[0]; idx = 4
    elif length == 127:
        if not _need(10):
            return None, b""
        length = struct.unpack(">Q", bytes(buf[2:10]))[0]; idx = 10
    mask = b""
    if masked:
        if not _need(idx + 4):
            return None, b""
        mask = bytes(buf[idx:idx + 4]); idx += 4
    if not _need(idx + length):
        return None, b""
    payload = bytes(buf[idx:idx + length])
    if masked and mask:
        payload = bytes(p ^ mask[i % 4] for i, p in enumerate(payload))
    return opcode, payload


def probe(host, port, path, use_tls, subprotocol, auth_header=None, timeout=8):
    scheme = "wss" if use_tls else "ws"
    label = f"{scheme}://{host}:{port}{path}  subproto={subprotocol or '-'}  auth={'yes' if auth_header else 'no'}"
    try:
        raw = socket.create_connection((host, port), timeout=timeout)
    except OSError as e:
        return {"path": path, "tls": use_tls, "ok": False, "why": f"TCP connect failed: {e}", "label": label}
    sock = raw
    if use_tls:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        try:
            sock = ctx.wrap_socket(raw, server_hostname=host)
        except ssl.SSLError as e:
            raw.close()
            return {"path": path, "tls": use_tls, "ok": False, "why": f"TLS handshake failed: {e}", "label": label}
    try:
        status, headers, leftover = _http_upgrade(sock, host, port, path, subprotocol, auth_header)
    except OSError as e:
        sock.close()
        return {"path": path, "tls": use_tls, "ok": False, "why": f"upgrade I/O error: {e}", "label": label}

    result = {"path": path, "tls": use_tls, "status": status, "label": label,
              "chosen_subprotocol": headers.get("sec-websocket-protocol", ""),
              "accept_ok": headers.get("_accept_ok")}
    if status == 401:
        why = ("401 Unauthorized — 帶了帳密仍被拒:帳密不對(對齊 kasmvncpasswd 建的使用者)"
               if auth_header else
               "401 Unauthorized — 需要 Basic Auth;用 --user/--password 帶帳密再試")
        result.update(ok=False, why=why)
        sock.close(); return result
    if status != 101:
        result.update(ok=False, why=f"HTTP {status}(非 101;path 可能不對或 TLS 需求不符)")
        sock.close(); return result

    opcode, payload = _read_frame(sock, leftover)
    sock.close()
    if opcode is None:
        result.update(ok=False, why="交握成功(101)但沒收到 server greeting(可能 path 對但不是 VNC 端點)")
        return result
    head = payload[:24]
    looks_vnc = payload[:4] == b"RFB " or b"RFB" in head
    result.update(ok=True, greeting=head, greeting_ascii=head.decode("latin-1", "replace"),
                  looks_vnc=looks_vnc,
                  why="收到 greeting" + ("(像 RFB/VNC ✔)" if looks_vnc else "(非典型 RFB,仍可能是 KasmVNC)"))
    return result


def main():
    ap = argparse.ArgumentParser(description="KasmVNC Phase 0 websocket 探測(stdlib only)")
    ap.add_argument("--host", default=os.getenv("KASM_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, required=True, help="KasmVNC 的 ws_port(= 8443 + display)")
    ap.add_argument("--path", default=None, help="只試這個 path(預設:自動試常見清單)")
    ap.add_argument("--subprotocol", default="binary", help="Sec-WebSocket-Protocol(預設 binary;空字串=不帶)")
    ap.add_argument("--tls", action="store_true", help="用 wss(不驗證憑證)")
    ap.add_argument("--both", action="store_true", help="ws 與 wss 都試")
    ap.add_argument("--user", default="telepy", help="KasmVNC Basic Auth 使用者(預設 telepy;空字串=不帶)")
    ap.add_argument("--password", default="telepyvnc", help="KasmVNC Basic Auth 密碼(預設 telepyvnc)")
    args = ap.parse_args()

    paths = [args.path] if args.path else CANDIDATE_PATHS
    subproto = args.subprotocol or None
    tls_modes = [False, True] if args.both else [args.tls]
    auth_header = None
    if args.user:
        auth_header = "Basic " + base64.b64encode(f"{args.user}:{args.password}".encode()).decode()

    print(f"== KasmVNC Phase 0 probe → {args.host}:{args.port}  (auth: {'on' if auth_header else 'off'}) ==\n")
    hit = None
    for use_tls in tls_modes:
        for p in paths:
            r = probe(args.host, args.port, p, use_tls, subproto, auth_header)
            mark = "✅" if r.get("ok") else "  "
            extra = ""
            if r.get("ok"):
                extra = f"  greeting={r['greeting_ascii']!r} subproto={r['chosen_subprotocol']!r}"
            print(f"{mark} {r['label']}\n     → {r['why']}{extra}")
            if r.get("ok") and hit is None:
                hit = r
        if hit:
            break

    print("\n" + "=" * 70)
    if hit:
        print("PASS ✅  KasmVNC websocket 可連、交握成功。backend 的 consumer 已內建這些預設,若要固定可設 env:")
        print(f"    KASM_WS_SCHEME={'wss' if hit['tls'] else 'ws'}")
        print(f"    KASM_WS_PATH={hit['path']}")
        print(f"    KASM_WS_SUBPROTOCOL={hit.get('chosen_subprotocol') or subproto or ''}")
        if auth_header:
            print(f"    KASM_WS_USER={args.user}")
            print(f"    KASM_WS_PASSWORD={args.password}")
        print("上游 ws 可連。前端用 KasmVNC 自家 client(見 docs/remote-browser.md)。")
        sys.exit(0)
    else:
        print("NO-GO ❌  沒有任何 path/scheme 連得上並收到 greeting。")
        print("逐條看上面的原因:401=auth 沒關;只 wss 能連=TLS 沒關;全連不上=path/subproto 不對。")
        sys.exit(1)


if __name__ == "__main__":
    main()
