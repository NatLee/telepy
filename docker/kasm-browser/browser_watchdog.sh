#!/bin/sh
# chromium 視窗 watchdog —— 以「可見視窗」而非「行程存活」判斷瀏覽器是否還在服務。
#
# 為什麼:chromium 的 background mode 讓「使用者按 X 關掉最後一個視窗」之後主行程
# **依然活著**(實測連 --disable-background-mode / --disable-background-networking /
# --disable-component-extensions-with-background-pages 全加了都壓不住)。行程級的
# respawn 迴圈因此永遠等不到它死 → 桌面永遠黑畫面。
#
# 策略:起 chromium → 等第一個視窗出現(啟動 grace)→ 之後只要「連續兩次偵測都
# 沒有可見視窗」或行程死亡,就收掉整棵 chromium 重開。
#
# 由 session_manager 以 env 驅動:
#   BROWSER_CMD   完整的 chromium 指令(必填)
#   DISPLAY       該 session 的 X display(_spawn 已設)
#   WATCHDOG_STARTUP_GRACE / WATCHDOG_POLL   秒數(預設 30 / 3)
#
# session 停止時 session_manager 對整個 process group killpg —— 本腳本與 chromium
# 同 group,一起被收,不會詐屍。
set -u

GRACE="${WATCHDOG_STARTUP_GRACE:-30}"
POLL="${WATCHDOG_POLL:-3}"

vis_count() {
    xdotool search --onlyvisible --class chromium 2>/dev/null | wc -l
}

HAS_XDOTOOL=1
command -v xdotool >/dev/null 2>&1 || HAS_XDOTOOL=0

while :; do
    # exec 讓 CPID 就是 chromium 主行程(而不是多一層 sh)
    sh -c "exec ${BROWSER_CMD}" &
    CPID=$!

    if [ "$HAS_XDOTOOL" -eq 1 ]; then
        # 啟動 grace:等第一個視窗(或行程提早死亡)
        T=0
        while [ "$T" -lt "$GRACE" ] && kill -0 "$CPID" 2>/dev/null \
              && [ "$(vis_count)" -eq 0 ]; do
            sleep 2; T=$((T + 2))
        done
        # 監看:行程死亡 → respawn;可見視窗連續兩次為 0 → 收掉 respawn
        while kill -0 "$CPID" 2>/dev/null; do
            sleep "$POLL"
            if [ "$(vis_count)" -eq 0 ]; then
                sleep 2
                [ "$(vis_count)" -eq 0 ] && break
            fi
        done
    else
        wait "$CPID"    # 沒有 xdotool → 退回行程級 respawn(至少不比以前差)
    fi

    # 收掉 chromium 主行程;子行程(renderer/GPU)失去 browser process 會自行退出,
    # 殘餘孤兒由容器的 tini(init: true)回收。
    kill -TERM "$CPID" 2>/dev/null
    sleep 2
    kill -KILL "$CPID" 2>/dev/null
    sleep 2
done
