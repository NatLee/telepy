#!/usr/bin/env python3
# Telepy: carry an SSH connection over a WebSocket, for networks that only let the web port (443) out.
#
#   ssh -o ProxyCommand='python3 telepy-ws.py wss://telepy.example.com/ws/gateway/' ...
#
# Everything ssh writes to stdin goes out as binary WebSocket frames; every frame that comes back goes to
# stdout. Only the Python standard library is used, so it runs wherever python3 does. The SSH session inside
# is the same one port 24242 carries: the same keys, the same host-key check, nothing to trust extra.
import base64
import hashlib
import os
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
        die("the URL must look like wss://host/ws/gateway/")
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
            die("the server closed the connection during the handshake")
        buf += chunk
        if len(buf) > 65536:
            die("handshake response too large")
    head, rest = buf.split(b"\r\n\r\n", 1)
    lines = head.split(b"\r\n")
    if not lines[0].startswith(b"HTTP/1.1 101"):
        die("the server did not accept the WebSocket: %s" % lines[0].decode(errors="replace"))
    expected = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest())
    accept = [l.split(b":", 1)[1].strip() for l in lines[1:] if l.lower().startswith(b"sec-websocket-accept:")]
    if accept != [expected]:
        die("bad Sec-WebSocket-Accept from the server")
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


def main():
    if len(sys.argv) != 2:
        die("usage: telepy-ws.py wss://host/ws/gateway/")
    try:
        sock, pending = connect(sys.argv[1])
    except (OSError, ssl.SSLError) as e:
        die("cannot connect: %s" % e)
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


if __name__ == "__main__":
    main()
