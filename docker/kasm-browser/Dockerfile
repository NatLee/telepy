# vnc-browser(歷史目錄名 kasm-browser)—— 共用的 VNC 瀏覽器容器(取代 CDP 的 chromium 容器)。
#
# 一顆長命容器,內含 TigerVNC(提供 Xvnc:傳統 raw-RFB TCP 埠)+ Chromium + openbox +
# CJK 字型 + 一支 session-manager HTTP API(session_manager.py)。backend 呼叫該 API,
# 每個 remote-browser session 就起一組「Xvnc 顯示 + 綁定該 session SOCKS 的 chromium」,
# 回傳 RFB 埠;Django consumer 再把該 RFB 埠橋接到既有 /ws,前端用 noVNC 呈現。
#
# 為何用 TigerVNC 而非 KasmVNC:KasmVNC 是「web-native」,其 Xkasmvnc **只開 WebSocket**
# (不開傳統 raw-RFB TCP 埠),與本專案「Django consumer 直接 TCP 橋接 RFB 到既有 /ws」的
# 乾淨設計不相容(要接 KasmVNC 得再寫 WS-to-WS proxy 並關掉它自己的 web 驗證)。TigerVNC 的
# Xvnc 會在 -rfbport 開真正的 raw-RFB TCP 埠,直接吻合本設計;Tight 編碼對瀏覽已遠優於 CDP 整幀
# JPEG,且真桌面讓 CJK 顯示/剪貼簿近乎免費。session-manager 對 VNC server 無耦合(VNC_CMD /
# VNC_SERVER_BIN 皆可 env 覆寫),日後要換回 KasmVNC(需自行加 WS-proxy)也不必改這裡的骨架。
#
# 不需 docker.sock:所有 per-session 生命週期都是「在這一顆容器內起/停行程」,不做容器編排。
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 桌面 + 瀏覽器 + 字型 + TigerVNC(standalone Xvnc)+ python(跑 session-manager)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      openbox \
      fonts-noto-cjk fonts-noto-color-emoji xfonts-base \
      python3 \
      procps \
      dbus-x11 xauth x11-xkb-utils xkb-data \
      libgl1-mesa-dri libgles2 \
      tigervnc-standalone-server \
 && rm -rf /var/lib/apt/lists/*

# 確保 /usr/bin/Xvnc 可用(TigerVNC 有時只裝 Xtigervnc,靠 alternatives 提供 Xvnc);
# 在 build 階段就驗證,沒裝好直接讓 build 失敗,而不是等 runtime 才噴 FileNotFoundError。
RUN if ! command -v Xvnc >/dev/null 2>&1; then \
        T="$(command -v Xtigervnc || true)"; \
        [ -n "$T" ] && ln -sf "$T" /usr/bin/Xvnc; \
    fi \
 && if ! command -v Xvnc >/dev/null && ! command -v Xtigervnc >/dev/null; then \
        echo "FATAL: TigerVNC X server (Xvnc/Xtigervnc) not installed."; exit 1; \
    fi \
 && echo "VNC server resolved to: $(command -v Xvnc || command -v Xtigervnc)"

COPY session_manager.py /app/session_manager.py

# 若你的 KasmVNC build 的 Xvnc 路徑/旗標不同,可用這些環境變數覆寫,不必改碼:
#   VNC_CMD / WM_CMD / BROWSER_CMD  (見 session_manager.py 的 DEFAULT_* 樣板)
ENV SESSION_MANAGER_PORT=7000
EXPOSE 7000
# session-manager 為 PID 1;SIGTERM 時會收掉所有 session 行程。
CMD ["python3", "/app/session_manager.py"]
