# vnc-browser(目錄名 kasm-browser)—— 共用的 VNC 瀏覽器容器。
#
# 一顆長命容器,內含 KasmVNC(提供 Xkasmvnc:web-native 的 VNC-over-WebSocket)+ Chromium +
# openbox + CJK 字型 + 一支 session-manager HTTP API(session_manager.py)。backend 呼叫該 API,
# 每個 remote-browser session 就起一組「Xkasmvnc 顯示 + 綁定該 session SOCKS 的 chromium」,
# 回傳 websocket 埠;Django consumer 再把該 ws 埠 **WS↔WS** 中繼到既有 /ws,前端用 KasmVNC 自家的
# web client 呈現(見 docs/remote-browser.md)。
#
# 為何用 KasmVNC:它的動態編碼(JPEG/WebP、多執行緒、影片模式)對影片/多圖頁面優於 TigerVNC 的
# Tight;真桌面讓 CJK 顯示與 seamless/binary 剪貼簿、IME 近乎免費。代價:KasmVNC **脫離 RFB 規範、
# 只開 websocket**,且必須用它自己 fork 的 web client(一般 noVNC 連不上)—— 因此橋接層是 WS↔WS、
# 前端改用 KasmVNC client。要回退 TigerVNC:`git checkout feat/vnc-remote-browser`(該分支仍是 raw-RFB)。
#
# 不需 docker.sock:所有 per-session 生命週期都是「在這一顆容器內起/停行程」,不做容器編排。
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# 桌面 + 瀏覽器 + 字型 + KasmVNC runtime 依賴 + python(跑 session-manager)+ 下載工具。
# xdotool:open-browser.sh 用「可見視窗數」判斷是要聚焦既有視窗還是開新的(避免疊視窗);
# tint2 桌面面板 + hsetroot 桌布:關掉瀏覽器後桌面不黑、面板上有捷徑可再開。
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget \
      chromium \
      openbox \
      xdotool \
      tint2 hsetroot \
      fonts-noto-cjk fonts-noto-color-emoji xfonts-base \
      python3 \
      procps \
      dbus-x11 xauth x11-xkb-utils xkb-data \
      libgl1-mesa-dri libgles2 \
      ssl-cert \
 && rm -rf /var/lib/apt/lists/*

# ── KasmVNC(Xkasmvnc)──────────────────────────────────────────────────────
# 依架構抓對應 .deb(amd64 / arm64),用 apt 安裝以自動補足相依。版本用 ARG,方便日後 bump。
# releases:https://github.com/kasmtech/KasmVNC/releases
ARG KASMVNC_VERSION=1.4.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    url="https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_bookworm_${KASMVNC_VERSION}_${arch}.deb"; \
    echo "Downloading KasmVNC: ${url}"; \
    wget -q -O /tmp/kasmvnc.deb "${url}"; \
    apt-get update; \
    apt-get install -y --no-install-recommends /tmp/kasmvnc.deb; \
    rm -f /tmp/kasmvnc.deb; \
    rm -rf /var/lib/apt/lists/*; \
    # build 階段就驗證二進位存在,沒裝好直接讓 build 失敗(而非等 runtime 才噴 FileNotFoundError)。
    command -v Xkasmvnc >/dev/null 2>&1 || { echo "FATAL: Xkasmvnc not installed by the KasmVNC deb"; exit 1; }; \
    echo "KasmVNC resolved to: $(command -v Xkasmvnc)"

# 全域 KasmVNC 設定:內網關掉 TLS(走純 ws)。basic auth 由啟動旗標 -disableBasicAuth 關(見
# session_manager 的 DEFAULT_VNC_CMD)。Xkasmvnc 會讀 /etc/kasmvnc/kasmvnc.yaml。
COPY kasmvnc.yaml /etc/kasmvnc/kasmvnc.yaml

# KasmVNC web 層預設要 HTTP Basic Auth(實測此 build 的 -disableBasicAuth 不生效)。建一個「讀寫」
# 使用者;backend 的 RemoteBrowserConsumer 會帶這組帳密連上游 ws(見 KASM_WS_USER/KASM_WS_PASSWORD)。
# 密碼需 >=6 字元。帳密僅內網用(kasm-browser 不對外 publish);要改就同時改 backend 的 env。
# **關鍵**:寫到「固定路徑」/etc/kasmvnc/kasmpasswd,並由 session_manager 用 -KasmPasswordFile 指定同一
# 路徑。不能靠預設的 ${HOME}/.kasmpasswd —— build 時 HOME=/root,但 runtime PID1 的 HOME 未必是 /root,
# 會讓 Xkasmvnc 找不到使用者、對任何帳密都回 401(這正是先前的症狀)。
ARG KASMVNC_USER=telepy
ARG KASMVNC_PASSWORD=telepyvnc
RUN set -eux; \
    command -v kasmvncpasswd >/dev/null 2>&1 || { echo "FATAL: kasmvncpasswd not found in KasmVNC deb"; exit 1; }; \
    mkdir -p /etc/kasmvnc; \
    printf '%s\n%s\n' "${KASMVNC_PASSWORD}" "${KASMVNC_PASSWORD}" | timeout 20 kasmvncpasswd -u "${KASMVNC_USER}" -w /etc/kasmvnc/kasmpasswd; \
    test -s /etc/kasmvnc/kasmpasswd || { echo "FATAL: /etc/kasmvnc/kasmpasswd not created — check kasmvncpasswd syntax"; exit 1; }; \
    echo "KasmVNC basic-auth user '${KASMVNC_USER}' → /etc/kasmvnc/kasmpasswd"

# Chromium 管理策略:封鎖下載(容器裡下載的檔案使用者拿不到,只會吃磁碟)+ 關背景模式。
COPY chromium-policy.json /etc/chromium/policies/managed/telepy.json

# openbox 設定:以預設 rc.xml 為底,加一條 applications 規則 —— 對所有視窗移除標題列裝飾
# (<decor>no</decor>)並最大化填滿 display(<maximized>true</maximized>)。session_manager 以
# `openbox --config-file /app/openbox-rc.xml` 啟動。用預設檔為底可保留所有預設鍵位/行為。
RUN mkdir -p /app && python3 - <<'PY'
import re
src = open("/etc/xdg/openbox/rc.xml").read()
rule = (
    "  <applications>\n"
    '    <application class="*">\n'
    "      <decor>no</decor>\n"
    "      <maximized>true</maximized>\n"
    "    </application>\n"
    "  </applications>\n"
)
src = re.sub(r"<applications>.*?</applications>", "", src, flags=re.S)
src = src.replace("</openbox_config>", rule + "</openbox_config>")
open("/app/openbox-rc.xml", "w").write(src)
import xml.dom.minidom as m; m.parseString(src)   # build 時驗 XML 合法,壞了直接 fail
print("openbox-rc.xml generated and validated")
PY

COPY session_manager.py /app/session_manager.py
# 桌面捷徑:關掉瀏覽器後桌面顯示桌布 + tint2 面板上的「開啟瀏覽器」捷徑(不自動重啟、不黑畫面)。
COPY open-browser.sh /app/open-browser.sh
COPY tint2rc /app/tint2rc
COPY telepy-browser.desktop /usr/share/applications/telepy-browser.desktop
RUN chmod +x /app/open-browser.sh

# 若你的 KasmVNC build 的旗標/路徑不同,可用這些環境變數覆寫,不必改碼:
#   VNC_CMD / WM_CMD / BROWSER_CMD          (見 session_manager.py 的 DEFAULT_* 樣板)
#   REMOTE_BROWSER_HOMEPAGE / REMOTE_BROWSER_LANG / REMOTE_BROWSER_PROFILE_TMP / WS_BASE
ENV SESSION_MANAGER_PORT=7000
EXPOSE 7000
# session-manager 為 PID 1;SIGTERM 時會收掉所有 session 行程。
CMD ["python3", "/app/session_manager.py"]
