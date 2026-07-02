# kasm-browser —— 共用的 KasmVNC 瀏覽器容器(取代 CDP 的 chromium 容器)。
#
# 一顆長命容器,內含 KasmVNC(提供 Xvnc:RFB + 現代化編碼)+ Chromium + openbox +
# CJK 字型 + 一支 session-manager HTTP API(session_manager.py)。backend 呼叫該 API,
# 每個 remote-browser session 就起一組「Xvnc 顯示 + 綁定該 session SOCKS 的 chromium」,
# 回傳 RFB 埠;Django consumer 再把該 RFB 埠橋接到既有 /ws,前端用 noVNC 呈現。
#
# 為何這樣:VNC 送的是「增量式 tile 更新」而非 CDP 的整幀 JPEG,對以文字為主的瀏覽延遲更低;
# 且真桌面讓 CJK 顯示/剪貼簿近乎免費。KasmVNC 是 web-native 的現代 VNC(TigerVNC fork)。
#
# 不需 docker.sock:所有 per-session 生命週期都是「在這一顆容器內起/停行程」,不做容器編排。
FROM debian:bookworm-slim

ARG KASMVNC_VERSION=1.3.4
# KasmVNC 對應 Debian bookworm 的 server 套件(如版本更新,改這兩個 ARG 即可)。
ARG KASMVNC_DEB=kasmvncserver_bookworm_${KASMVNC_VERSION}_amd64.deb
ENV DEBIAN_FRONTEND=noninteractive

# 桌面 + 瀏覽器 + 字型 + Xvnc runtime deps + python(跑 session-manager)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      chromium \
      openbox \
      fonts-noto-cjk fonts-noto-color-emoji \
      python3 \
      procps \
      dbus-x11 xauth x11-xkb-utils xkb-data \
      libxfont2 libgl1-mesa-dri libgles2 \
 && rm -rf /var/lib/apt/lists/*

# KasmVNC(提供 /usr/bin/Xvnc,支援 -rfbport / -SecurityTypes None / -interface)
RUN curl -fsSL -o /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/${KASMVNC_DEB}" \
 && apt-get update \
 && (apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
     || (dpkg -i /tmp/kasmvnc.deb; apt-get install -y -f --no-install-recommends)) \
 && rm -rf /tmp/kasmvnc.deb /var/lib/apt/lists/*

COPY session_manager.py /app/session_manager.py

# 若你的 KasmVNC build 的 Xvnc 路徑/旗標不同,可用這些環境變數覆寫,不必改碼:
#   VNC_CMD / WM_CMD / BROWSER_CMD  (見 session_manager.py 的 DEFAULT_* 樣板)
ENV SESSION_MANAGER_PORT=7000
EXPOSE 7000
# session-manager 為 PID 1;SIGTERM 時會收掉所有 session 行程。
CMD ["python3", "/app/session_manager.py"]
