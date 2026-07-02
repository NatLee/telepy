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

# KasmVNC 版本(如需更新改這個;.deb 檔名依架構於下方 RUN 內組出)。
ARG KASMVNC_VERSION=1.3.4
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

# KasmVNC。注意:KasmVNC 的 X server 二進位名為 **Xkasmvnc**(不是 Xvnc)。
# 依容器實際架構(dpkg --print-architecture → amd64/arm64)抓對應的 bookworm .deb,
# 安裝後把 Xkasmvnc 連結成 Xvnc(相容),並在 build 階段就驗證二進位存在——若 KasmVNC 沒裝好,
# build 直接失敗(附 dpkg 內容),而不是等到 runtime 才噴 FileNotFoundError。
RUN ARCH="$(dpkg --print-architecture)" \
 && echo "KasmVNC deb arch: ${ARCH}" \
 && curl -fsSL -o /tmp/kasmvnc.deb \
      "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${ARCH}.deb" \
 && apt-get update \
 && (apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
     || (dpkg -i /tmp/kasmvnc.deb; apt-get install -y -f --no-install-recommends)) \
 && rm -rf /tmp/kasmvnc.deb /var/lib/apt/lists/* \
 && KVNC="$(command -v Xkasmvnc || true)" \
 && if [ -n "$KVNC" ]; then ln -sf "$KVNC" /usr/bin/Xvnc; fi \
 && if ! command -v Xkasmvnc >/dev/null && ! command -v Xvnc >/dev/null; then \
        echo "FATAL: KasmVNC X server (Xkasmvnc/Xvnc) not found after install."; \
        echo "kasmvncserver package binaries:"; dpkg -L kasmvncserver 2>/dev/null | grep -iE '/(X|bin/)' || true; \
        exit 1; \
    fi \
 && echo "VNC server resolved to: $(command -v Xkasmvnc || command -v Xvnc)"

COPY session_manager.py /app/session_manager.py

# 若你的 KasmVNC build 的 Xvnc 路徑/旗標不同,可用這些環境變數覆寫,不必改碼:
#   VNC_CMD / WM_CMD / BROWSER_CMD  (見 session_manager.py 的 DEFAULT_* 樣板)
ENV SESSION_MANAGER_PORT=7000
EXPOSE 7000
# session-manager 為 PID 1;SIGTERM 時會收掉所有 session 行程。
CMD ["python3", "/app/session_manager.py"]
