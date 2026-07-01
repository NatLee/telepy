#!/bin/bash

while true; do
  echo $(ss -tlnp 2>/dev/null || /bin/netstat -tlnp 2>/dev/null) | /usr/bin/redis-cli -h redis -x SET ss_output > /dev/null 2>&1
  # 額外收集「已建立」連線的 kernel TCP 資訊（含 rtt:），供延遲監控用。
  # 這裡刻意「不」用 echo $(...)：-i 的 rtt: 是在續行輸出，必須保留換行才能把 rtt 對應回它的連線
  # （其 pid 與 local port）。redis-cli -x 從 stdin 原樣讀入（含換行）。ss_output 那行完全不動，
  # 既有 online/offline 判定零影響。
  # Collect established-connection kernel TCP info (incl. rtt:) for latency monitoring. Deliberately
  # NOT using echo $(...) here: ss -i prints rtt: on a continuation line, so newlines must be preserved
  # to associate each rtt with its connection (pid / local port). redis-cli -x reads stdin verbatim.
  ss -tinp state established 2>/dev/null | /usr/bin/redis-cli -h redis -x SET ss_estab > /dev/null 2>&1
  sleep 3
done

