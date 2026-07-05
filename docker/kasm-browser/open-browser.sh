#!/bin/sh
# 「開啟瀏覽器」啟動器 —— 桌面面板(tint2)捷徑、session 首次啟動、與 session_manager 的
# chromium watchdog(行程完全消失時自動重開,見 _watchdog_tick)三方共用。冪等:重複執行
# 只會聚焦既有視窗,不會疊視窗。
# 行為:
#   - 已有「可見的」chromium 視窗 → 聚焦它,不再開新視窗(避免疊一堆)。
#   - 沒有可見視窗 → 全新啟動。**注意**:chromium 的 background mode 讓「關掉最後一個視窗」後
#     主行程賴著不走,而再跑一次 `chromium <url>` 只會印「Opening in existing browser session」卻
#     不開新視窗(舊 watchdog 就是為此要 kill+respawn)。所以這裡先把「本 session」的殘留 chromium
#     精準收掉(用 --user-data-dir 匹配,**不影響其他 display 的並發 session**),再全新啟動一個乾淨視窗。
#
# BROWSER_CMD 由 session_manager 經環境傳入(含該 session 的 --proxy-server 與 --user-data-dir)。
# 環境可能遺失(實測:使用者點 tint2 面板捷徑曾出現「BROWSER_CMD not set」;openbox 根選單
# 啟動的行程也沒有這組環境)→ 退回 source session_manager 寫的 per-display env 檔
# (/tmp/telepy-browser-<display>.env,session 停止即刪),讓任何桌面啟動路徑都開得起來。
set -u

if [ -z "${BROWSER_CMD:-}" ] && [ -n "${DISPLAY:-}" ]; then
    _disp="${DISPLAY#:}"; _disp="${_disp%%.*}"   # ":10" / ":10.0" → "10"
    _env_file="/tmp/telepy-browser-${_disp}.env"
    if [ -r "$_env_file" ]; then
        # shellcheck disable=SC1090
        . "$_env_file"
    fi
fi

if command -v xdotool >/dev/null 2>&1; then
    # 已有可見視窗 → 聚焦。
    WIN=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)
    if [ -n "${WIN:-}" ]; then
        xdotool windowactivate "$WIN" >/dev/null 2>&1 || true
        exit 0
    fi
    # 沒有可見視窗:可能是「被最小化/縮小」的真視窗(仍存在,只是沒顯示)。windowactivate 會把它
    # 還原並聚焦 → 解決「縮小後不見」。要挑「真的瀏覽器視窗」:chromium 會另有一個 10x10、名稱剛好
    # 是 "chromium" 的隱藏工具視窗,用寬度 ≥ 100 過濾掉它;沒有真視窗(=瀏覽器已關)才往下全新啟動。
    restored=0
    for w in $(xdotool search --class chromium 2>/dev/null); do
        width=$(xdotool getwindowgeometry "$w" 2>/dev/null | sed -n 's/.*Geometry: \([0-9]\{1,\}\)x.*/\1/p')
        if [ -n "$width" ] && [ "$width" -ge 100 ] 2>/dev/null; then
            xdotool windowactivate "$w" >/dev/null 2>&1 && restored=1
        fi
    done
    [ "$restored" = 1 ] && exit 0
fi

[ -n "${BROWSER_CMD:-}" ] || { echo "open-browser: BROWSER_CMD not set" >&2; exit 1; }

# 收掉本 session 殘留的 chromium(以 user-data-dir 精準匹配),並清掉 profile 的 SingletonLock,
# 讓接下來的啟動是乾淨的新實例(會真的開一個視窗)。
UDD=$(printf '%s\n' "$BROWSER_CMD" | tr ' ' '\n' | sed -n 's/^--user-data-dir=//p' | head -1)
if [ -n "${UDD:-}" ]; then
    pkill -f -- "--user-data-dir=${UDD}" 2>/dev/null || true
    i=0
    while [ "$i" -lt 10 ] && pgrep -f -- "--user-data-dir=${UDD}" >/dev/null 2>&1; do
        sleep 0.3; i=$((i + 1))
    done
    rm -f "${UDD}/SingletonLock" "${UDD}/SingletonSocket" "${UDD}/SingletonCookie" 2>/dev/null || true
fi

exec sh -c "$BROWSER_CMD"
