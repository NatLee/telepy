#!/bin/sh
# 「開啟瀏覽器」啟動器 —— 被桌面面板(tint2)的捷徑與 session 首次啟動共用。
#
# 不做自動重啟:使用者關掉視窗後,桌面顯示桌布 + 面板捷徑,由使用者自己點捷徑再開。
# 行為:
#   - 已有「可見的」chromium 視窗 → 聚焦它,不再開新視窗(避免疊一堆)。
#   - 沒有可見視窗 → 全新啟動。**注意**:chromium 的 background mode 讓「關掉最後一個視窗」後
#     主行程賴著不走,而再跑一次 `chromium <url>` 只會印「Opening in existing browser session」卻
#     不開新視窗(舊 watchdog 就是為此要 kill+respawn)。所以這裡先把「本 session」的殘留 chromium
#     精準收掉(用 --user-data-dir 匹配,**不影響其他 display 的並發 session**),再全新啟動一個乾淨視窗。
#
# BROWSER_CMD 由 session_manager 經環境傳入(含該 session 的 --proxy-server 與 --user-data-dir)。
set -u

if command -v xdotool >/dev/null 2>&1; then
    WIN=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -1)
    if [ -n "${WIN:-}" ]; then
        xdotool windowactivate "$WIN" >/dev/null 2>&1 || true
        exit 0
    fi
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
