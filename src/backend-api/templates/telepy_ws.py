#!/usr/bin/env python3
# Telepy: carry an SSH connection over a WebSocket, for networks that only let the web port (443) out.
#
#   ssh -o ProxyCommand='python3 telepy-ws.py wss://telepy.example.com/ws/gateway/' ...
#   ssh -o ProxyCommand='python3 telepy-ws.py --tcp ssh.example.com:24242 wss://telepy.example.com/ws/gateway/' ...
#   ssh -o ProxyCommand='python3 telepy-ws.py --proxy http://proxy.corp:3128 wss://telepy.example.com/ws/gateway/' ...
#
# Networks that only let traffic out through an HTTP proxy: --proxy (or the HTTPS_PROXY / ALL_PROXY variables, with
# NO_PROXY honoured) sends CONNECT to the proxy first, for the SSH port and the web port alike; --no-proxy ignores the
# variables. This is the python3 twin of the prebuilt telepy-carrier binary: devices without one for their CPU use this.
#
# With --tcp it picks the way by itself: the SSH port first (the server must answer with its "SSH-" banner), the
# WebSocket when that port cannot be reached (a firewall, or a web name behind a proxy such as Cloudflare's that
# only carries web ports). The way that worked is remembered for a while, so a blocked port does not slow every
# reconnect, and the SSH port is tried again later. On the WebSocket the SSH port is also tried again during the
# connection's first minutes (a restarting server may open its web port before its SSH port); once it answers this
# connection ends, so ssh reconnects there. It says on stderr which way it took.
#
# Everything ssh writes to stdin goes out as binary WebSocket frames; every frame that comes back goes to
# stdout. Only the Python standard library is used, so it runs wherever python3 does. The SSH session inside
# is the same one port 24242 carries: the same keys, the same host-key check, nothing to trust extra.
import base64
import hashlib
import os
import tempfile
import time
import socket
import ssl
import struct
import sys
import threading
import urllib.parse

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


PROXY = None  # (host, port, auth) or None


def parse_proxy(value):
    """http://[user:pass@]host:port (no port = 80); socks is not supported."""
    value = (value or "").strip()
    if not value:
        return None
    if "://" not in value:
        value = "http://" + value
    u = urllib.parse.urlsplit(value)
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    auth = None
    if u.username:
        auth = (urllib.parse.unquote(u.username), urllib.parse.unquote(u.password or ""))
    return (u.hostname, u.port or 80, auth)


def no_proxy_matches(entries, host):
    """curl's NO_PROXY rule: * = everything; a name matches itself and its subdomains; an IP must match exactly."""
    host = host.strip("[]").lower()
    for e in entries.replace(" ", ",").split(","):
        e = e.strip().lstrip(".").lower()
        if not e:
            continue
        h, sep, port = e.rpartition(":")
        if sep and port.isdigit():
            e = h
        if e == "*" or host == e or host.endswith("." + e):
            return True
    return False


def proxy_from_env(host):
    no = os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or ""
    if no_proxy_matches(no, host):
        return None
    for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        p = parse_proxy(os.environ.get(name))
        if p:
            return p
    return None


def open_tcp(host, port, timeout):
    """A TCP connection to host:port, straight or through the proxy (CONNECT). Returns (socket, bytes already read)."""
    if PROXY is None:
        sock = socket.create_connection((host, port), timeout=timeout)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        return sock, b""
    phost, pport, auth = PROXY
    sock = socket.create_connection((phost, pport), timeout=timeout)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    target = "[%s]:%d" % (host, port) if ":" in host else "%s:%d" % (host, port)
    req = "CONNECT %s HTTP/1.1\r\nHost: %s\r\nUser-Agent: telepy-ws/1\r\nProxy-Connection: Keep-Alive\r\n" % (target, target)
    if auth:
        req += "Proxy-Authorization: Basic %s\r\n" % base64.b64encode(("%s:%s" % auth).encode()).decode()
    req += "\r\n"
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise OSError("the proxy %s:%d closed the connection before answering CONNECT" % (phost, pport))
        buf += chunk
        if len(buf) > 65536:
            raise OSError("the proxy's answer to CONNECT is too large")
    head, rest = buf.split(b"\r\n\r\n", 1)
    first = head.split(b"\r\n")[0].decode(errors="replace")
    parts = first.split()
    if len(parts) < 2 or not parts[0].startswith("HTTP/") or not parts[1].isdigit():
        raise OSError("the proxy answered CONNECT with something that is not HTTP: %s" % first)
    if not 200 <= int(parts[1]) < 300:
        raise OSError("the proxy refused CONNECT %s: %s" % (target, first))
    return sock, rest


def die(message):
    sys.stderr.write("telepy-ws: %s\n" % message)
    sys.stderr.flush()
    os._exit(1)


def read_exact(sock, n):
    chunks = []
    while n > 0:
        chunk = sock.recv(n)
        if not chunk:
            return None
        chunks.append(chunk)
        n -= len(chunk)
    return b"".join(chunks)


def xor_mask(payload, mask):
    """XOR with the 4-byte mask, all at once: the buffer as one big integer (about 20x a per-byte loop, so uploads
    are no longer held back by Python)."""
    n = len(payload)
    if n == 0:
        return b""
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")


def frame(opcode, payload):
    """A masked client frame (the protocol requires clients to mask)."""
    mask = os.urandom(4)
    head = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        head += bytes([0x80 | n])
    elif n < 65536:
        head += bytes([0x80 | 126]) + struct.pack("!H", n)
    else:
        head += bytes([0x80 | 127]) + struct.pack("!Q", n)
    return head + mask + xor_mask(payload, mask)


def connect(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("ws", "wss") or not u.hostname:
        raise OSError("the URL must look like wss://host/ws/gateway/")
    tls = u.scheme == "wss"
    port = u.port or (443 if tls else 80)
    sock, pending = open_tcp(u.hostname, port, 30)
    if pending:
        raise OSError("the proxy sent data before the TLS handshake")
    if tls:
        sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
    key = base64.b64encode(os.urandom(16)).decode()
    path = u.path or "/"
    if u.query:
        path += "?" + u.query
    host = u.hostname if port in (80, 443) else "%s:%d" % (u.hostname, port)
    request = (
        "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: telepy-ws/1\r\n\r\n" % (path, host, key)
    )
    sock.sendall(request.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise OSError("the server closed the connection during the handshake")
        buf += chunk
        if len(buf) > 65536:
            raise OSError("handshake response too large")
    head, rest = buf.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    if not lines[0].startswith(b"HTTP/1.1 101"):
        raise OSError("the server did not accept the WebSocket: %s" % lines[0].decode(errors="replace"))
    expected = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest())
    accept = [l.split(b":", 1)[1].strip() for l in lines[1:] if l.lower().startswith(b"sec-websocket-accept:")]
    if accept != [expected]:
        raise OSError("bad Sec-WebSocket-Accept from the server")
    sock.settimeout(None)
    return sock, rest


def pump_in(sock):
    """stdin (ssh) -> WebSocket frames."""
    try:
        while True:
            data = os.read(0, 65536)
            if not data:
                break
            sock.sendall(frame(0x2, data))
        sock.sendall(frame(0x8, struct.pack("!H", 1000)))
    except OSError:
        pass
    finally:
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def pump_out(sock, pending):
    """WebSocket frames -> stdout (ssh). Returns when the server closes."""
    buf = pending
    lock = threading.Lock()

    def take(n):
        nonlocal buf
        while len(buf) < n:
            chunk = sock.recv(65536)
            if not chunk:
                return None
            buf += chunk
        out, buf = buf[:n], buf[n:]
        return out

    message = b""
    while True:
        head = take(2)
        if head is None:
            return
        fin = head[0] & 0x80
        opcode = head[0] & 0x0F
        masked = head[1] & 0x80
        n = head[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", take(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", take(8))[0]
        mask = take(4) if masked else None
        payload = take(n) if n else b""
        if payload is None:
            return
        if mask:
            payload = xor_mask(payload, mask)
        if opcode in (0x1, 0x2, 0x0):
            message += payload
            if fin:
                os.write(1, message)
                message = b""
        elif opcode == 0x8:
            return
        elif opcode == 0x9:
            with lock:
                sock.sendall(frame(0xA, payload))
        # 0xA (pong): nothing to do


# --- the SSH port, directly (--tcp) ------------------------------------------------------------------------------

CONNECT_TIMEOUT = 6
# A gateway that accepts PROXY protocol headers from this address waits 5 s before it speaks first.
BANNER_TIMEOUT = 8
# How long a working WebSocket is preferred before the SSH port is tried first again.
REMEMBER_SECONDS = 1800
# On the WebSocket: the waits before each new try of the SSH port (six tries within about 10 minutes, then none, so a
# connection in use is not cut later). TELEPY_SSH_PORT_RETRY overrides it: comma-separated seconds, "off" = never.
RETRY_SSH_PORT = (10, 20, 40, 80, 160, 320)


def split_host_port(value):
    host, sep, port = value.rpartition(":")
    if not sep or not host or not port.isdigit():
        die("--tcp wants host:port, got %r" % value)
    return host.strip("[]"), int(port)


def direct(host, port):
    """Connect to the SSH port; succeed only once the server's SSH banner arrived (a proxy or a closed port fails)."""
    sock, seen = open_tcp(host, port, CONNECT_TIMEOUT)
    sock.settimeout(BANNER_TIMEOUT)
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            sock.close()
            raise OSError("the port closed before an SSH banner")
        seen += chunk
        # RFC 4253 allows lines before the banner; anything long without one is not an SSH server.
        lines = seen.split(b"\n")
        if any(l.startswith(b"SSH-") for l in lines):
            break
        if len(seen) > 8192:
            sock.close()
            raise OSError("no SSH banner on that port")
    sock.settimeout(None)
    return sock, seen


def relay_raw(sock, pending):
    """stdin <-> the TCP socket, unchanged."""
    def up():
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    break
                sock.sendall(data)
        except OSError:
            pass
        finally:
            try:
                sock.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    threading.Thread(target=up, daemon=True).start()
    try:
        if pending:
            os.write(1, pending)
        while True:
            data = sock.recv(65536)
            if not data:
                break
            os.write(1, data)
    except OSError:
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
        os._exit(0)


def memory_file(tcp, url):
    tag = hashlib.sha1(("%s %s" % (tcp, url)).encode()).hexdigest()[:12]
    return os.path.join(tempfile.gettempdir(), "telepy-ws-%s-%s" % (tag, os.getuid() if hasattr(os, "getuid") else "u"))


def remembers_ws(path):
    try:
        with open(path) as f:
            return time.time() - float(f.read().split()[0]) < REMEMBER_SECONDS
    except (OSError, ValueError, IndexError):
        return False


def remember(path, ws):
    try:
        if ws:
            with open(path, "w") as f:
                f.write("%d websocket\n" % time.time())
        elif os.path.exists(path):
            os.remove(path)
    except OSError:
        pass


def note(message):
    sys.stderr.write("telepy-ws: %s\n" % message)
    sys.stderr.flush()


def retry_schedule(value):
    if value is None or not value.strip():
        return list(RETRY_SSH_PORT)
    if value.strip() == "off":
        return []
    try:
        waits = [int(v.strip()) for v in value.split(",")]
    except ValueError:
        return list(RETRY_SSH_PORT)
    return waits if all(w >= 0 for w in waits) else list(RETRY_SSH_PORT)


def watch_ssh_port(host, port, memory, ws):
    """On the WebSocket: try the SSH port again on the schedule; once it answers, end so ssh reconnects there."""
    for wait in retry_schedule(os.environ.get("TELEPY_SSH_PORT_RETRY")):
        time.sleep(wait)
        try:
            probe, _ = direct(host, port)
        except (OSError, ssl.SSLError):
            continue
        probe.close()
        remember(memory, False)
        note("the SSH port %s:%d answers again: leaving the web port to reconnect there" % (host, port))
        try:
            ws.close()
        except OSError:
            pass
        os._exit(0)


def relay_ws(sock, pending):
    t = threading.Thread(target=pump_in, args=(sock,), daemon=True)
    t.start()
    try:
        pump_out(sock, pending)
    except OSError:
        pass
    finally:
        try:
            sock.close()
        except OSError:
            pass
        os._exit(0)


def auto(tcp, url):
    host, port = split_host_port(tcp)
    memory = memory_file(tcp, url)
    order = ["ws", "tcp"] if remembers_ws(memory) else ["tcp", "ws"]
    errors = []
    for way in order:
        try:
            if way == "tcp":
                sock, pending = direct(host, port)
                remember(memory, False)
                note("connected on the SSH port %s:%d" % (host, port))
                relay_raw(sock, pending)
            else:
                sock, pending = connect(url)
                remember(memory, True)
                note("connected through the web port (%s)%s" % (url, "; the SSH port %s:%d: %s" % (host, port, errors[0]) if errors else ""))
                threading.Thread(target=watch_ssh_port, args=(host, port, memory, sock), daemon=True).start()
                relay_ws(sock, pending)
        except (OSError, ssl.SSLError) as e:
            errors.append(str(e) or e.__class__.__name__)
    die("cannot connect: the SSH port %s:%d and the web port both failed (%s)" % (host, port, "; ".join(errors)))


USAGE = "usage: telepy-ws.py [--tcp host:port] [--proxy http://host:port | --no-proxy] wss://host/ws/gateway/"


def main():
    global PROXY
    args = sys.argv[1:]
    tcp = None
    proxy = None
    no_proxy = False
    url = None
    while args:
        a = args.pop(0)
        if a == "--tcp" and args:
            tcp = args.pop(0)
        elif a == "--proxy" and args:
            proxy = args.pop(0)
        elif a == "--no-proxy":
            no_proxy = True
        elif a in ("--version", "-V"):
            sys.stdout.write("telepy-ws.py 1\n")
            return
        elif a.startswith("-") or url is not None:
            die(USAGE)
        else:
            url = a
    if url is None:
        die(USAGE)
    if proxy:
        PROXY = parse_proxy(proxy)
        if PROXY is None:
            die("--proxy: not an http proxy URL: %s" % proxy)
    elif not no_proxy:
        PROXY = proxy_from_env(urllib.parse.urlsplit(url).hostname or "")
    if PROXY:
        note("through the proxy %s:%d" % (PROXY[0], PROXY[1]))
    if tcp:
        auto(tcp, url)
    try:
        sock, pending = connect(url)
    except (OSError, ssl.SSLError) as e:
        die("cannot connect: %s" % e)
    relay_ws(sock, pending)


if __name__ == "__main__":
    main()
