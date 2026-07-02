#!/bin/bash

# 主動延遲探測：量測 telepy-ssh ↔ 目標裝置的「真實」往返延遲。
#
# 對每條反向隧道（sshd 綁在 127.0.0.1 的 -R 轉發埠），連上該埠並用 $EPOCHREALTIME 計時，直到收到
# 目標裝置 sshd 回傳的第一個 banner byte 為止。這段時間 = 一個往返（channel-open 過去 + banner 回來）
# ≈ 真實網路 RTT。關鍵：資料是走「已建立的隧道」來回，即使裝置的 control TCP 在前面被
# docker-proxy / L4 LB 終結（被動的 kernel ss RTT 會失真成 ~0ms），這個主動量測仍反映真實延遲。
#
# 結果以 `ss_probe_latency`（每行 "port rtt_ms"）寫入 Redis，由 backend 讀取後廣播（見
# authorized_keys/utils.py: get_ss_latency_from_redis）。此服務刻意與 3s 的 update_ports 分開，
# 才不會讓某台慢/死掉裝置的探測逾時卡住 online/offline 取樣。
#
# Active latency probe: time the SSH banner returning through each reverse tunnel. Reflects the real
# telepy-ssh<->device RTT even when a proxy terminates the device's control TCP, because data is
# relayed through the live tunnel. Writes "port rtt_ms" lines to Redis key ss_probe_latency.

REDIS_CLI="/usr/bin/redis-cli -h redis"
INTERVAL="${PROBE_INTERVAL:-15}"      # 探測週期（秒）/ probe period
PROBE_TIMEOUT="${PROBE_TIMEOUT:-4}"   # 單一探測逾時（秒）/ per-probe timeout
TMPDIR="/tmp/telepy_probe"

# 印出該 reverse port 的往返 RTT(ms)；連不上 / 逾時 / 收不到 banner 則印空字串。
probe_one() {
  timeout "$PROBE_TIMEOUT" bash -c '
    port="$1"
    s=$EPOCHREALTIME
    exec 3<>/dev/tcp/127.0.0.1/$port || exit 1
    # 讀 1 個 byte（目標裝置 sshd banner 的第一個位元組）；此讀取即在等待一個隧道往返。
    IFS= read -r -N1 _b <&3 || exit 1
    e=$EPOCHREALTIME
    exec 3<&- 3>&- 2>/dev/null
    awk -v s="$s" -v e="$e" "BEGIN{ d=(e-s)*1000; if (d<0) d=0; printf \"%.1f\", d }"
  ' _ "$1" 2>/dev/null
}

while true; do
  rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
  # 反向轉發埠 = sshd 綁在 127.0.0.1 的 LISTEN（GatewayPorts no）。127.0.0.11(Docker DNS) 不符 regex。
  # 平行探測：一台慢/死掉的裝置只吃自己的逾時，不拖累其他台（總時間 ≈ 最慢的一台，不是相加）。
  for port in $(ss -tln 2>/dev/null | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2 | sort -u); do
    { rtt=$(probe_one "$port"); [ -n "$rtt" ] && printf '%s %s\n' "$port" "$rtt" > "$TMPDIR/$port"; } &
  done
  wait
  # 全部 port 的結果彙整成 "port rtt" 多行，一次覆寫 ss_probe_latency（無裝置時寫入空字串）。
  cat "$TMPDIR"/* 2>/dev/null | $REDIS_CLI -x SET ss_probe_latency > /dev/null 2>&1
  sleep "$INTERVAL"
done
