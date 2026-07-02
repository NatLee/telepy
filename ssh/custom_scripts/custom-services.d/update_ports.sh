#!/bin/bash

# 每 3 秒把 ss 的 LISTEN 輸出寫入 Redis(ss_output)，供 backend 判斷每條反向隧道的 online/offline。
# status 只需要 LISTEN 埠號，不需要 pid，所以用 root 直接跑即可。
# （延遲量測已改由獨立的 probe_latency.sh 主動探測，不再走這裡的被動 ss RTT。）
# Publish ss LISTEN output to Redis(ss_output) every 3s for online/offline detection. Latency is now
# measured actively by probe_latency.sh, so no ss_estab / passive RTT collection here.
while true; do
  echo $(ss -tlnp 2>/dev/null || /bin/netstat -tlnp 2>/dev/null) | /usr/bin/redis-cli -h redis -x SET ss_output > /dev/null 2>&1
  sleep 3
done
