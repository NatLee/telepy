#!/bin/bash

# 關鍵：ss -p 必須以「sshd 子行程所屬的使用者」身分執行，才拿得到 socket -> pid 對應。
# 反向隧道的 LISTEN 與裝置 control 連線都由跑成 USER_NAME（預設 telepy）的 sshd 子行程持有；
# 容器在預設 Docker capability 下沒有 CAP_SYS_PTRACE，連 root 都讀不到「其他使用者」的
# /proc/<pid>/fd，因此 root 跑 `ss -p` 完全不吐 pid —— 延遲關聯（reverse_port -> pid -> rtt）
# 會整組失敗，前端一律顯示「—」。用 s6-setuidgid 切到同一使用者即可正常對應。
# status（ss_output）不需要 pid，但一起以同身分跑不影響其解析。
#
# ss -p MUST run as the user that owns the sshd child processes (USER_NAME, default telepy) to get
# socket->pid mapping. With the default Docker cap set (no CAP_SYS_PTRACE) even root cannot read other
# users' /proc/<pid>/fd, so root's `ss -p` emits no pid and the latency correlation collapses to {}.
SS_USER="${USER_NAME:-telepy}"
if command -v s6-setuidgid >/dev/null 2>&1; then
  SS="s6-setuidgid ${SS_USER} ss"
else
  SS="ss"   # 退回直接執行：status 仍可用，但延遲關聯會失效 / fallback: status ok, latency lost
fi

while true; do
  echo $(${SS} -tlnp 2>/dev/null || /bin/netstat -tlnp 2>/dev/null) | /usr/bin/redis-cli -h redis -x SET ss_output > /dev/null 2>&1
  # 額外收集「已建立」連線的 kernel TCP 資訊（含 rtt:），供延遲監控用。
  # 這裡刻意「不」用 echo $(...)：-i 的 rtt: 是在續行輸出，必須保留換行才能把 rtt 對應回它的連線
  # （其 pid 與 local port）。redis-cli -x 從 stdin 原樣讀入（含換行）。ss_output 那行照舊，
  # 既有 online/offline 判定零影響。
  # Collect established-connection kernel TCP info (incl. rtt:) for latency monitoring. Deliberately
  # NOT using echo $(...) here: ss -i prints rtt: on a continuation line, so newlines must be preserved
  # to associate each rtt with its connection (pid / local port). redis-cli -x reads stdin verbatim.
  ${SS} -tinp state established 2>/dev/null | /usr/bin/redis-cli -h redis -x SET ss_estab > /dev/null 2>&1
  sleep 3
done
