#!/usr/bin/env python3
# Telepy: carry an SSH connection over a WebSocket, for networks that only let the web port (443) out.
#
#   ssh -o ProxyCommand='python3 telepy-ws.py wss://telepy.example.com/ws/gateway/' ...
#   ssh -o ProxyCommand='python3 telepy-ws.py --tcp ssh.example.com:24242 wss://telepy.example.com/ws/gateway/' ...
#
# With --tcp it picks the way by itself: the SSH port first (the server must answer with its "SSH-" banner), the
# WebSocket when that port cannot be reached (a firewall, or a web name behind a proxy such as Cloudflare's that
# only carries web ports). The way that worked is remembered for a while, so a blocked port does not slow every
# reconnect, and the SSH port is tried again later. It says on stderr which way it took.
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
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return head + mask + masked


def connect(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("ws", "wss") or not u.hostname:
        raise OSError("the URL must look like wss://host/ws/gateway/")
    tls = u.scheme == "wss"
    port = u.port or (443 if tls else 80)
    sock = socket.create_connection((u.hostname, port), timeout=30)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
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
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
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


def split_host_port(value):
    host, sep, port = value.rpartition(":")
    if not sep or not host or not port.isdigit():
        die("--tcp wants host:port, got %r" % value)
    return host.strip("[]"), int(port)


def direct(host, port):
    """Connect to the SSH port; succeed only once the server's SSH banner arrived (a proxy or a closed port fails)."""
    sock = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT)
    sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    sock.settimeout(BANNER_TIMEOUT)
    seen = b""
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
                relay_ws(sock, pending)
        except (OSError, ssl.SSLError) as e:
            errors.append(str(e) or e.__class__.__name__)
    die("cannot connect: the SSH port %s:%d and the web port both failed (%s)" % (host, port, "; ".join(errors)))


def main():
    args = sys.argv[1:]
    if len(args) == 3 and args[0] == "--tcp":
        auto(args[1], args[2])
    if len(args) != 1:
        die("usage: telepy-ws.py [--tcp host:port] wss://host/ws/gateway/")
    try:
        sock, pending = connect(args[0])
    except (OSError, ssl.SSLError) as e:
        die("cannot connect: %s" % e)
    relay_ws(sock, pending)


if __name__ == "__main__":
    main()
