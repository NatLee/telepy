from ast import literal_eval

from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis, get_ss_latency_from_redis

from tunnels.consumers import send_tunnel_connection_update, send_notification_to_users

class Command(BaseCommand):
    help = "Get and update the SSH server usage ports from the ss command output."

    # 抖動去彈跳：port 狀態需連續 FLAP_THRESHOLD 次與「已承認狀態」不同，才承認變更。
    # Flap debounce: a port's raw state must disagree with the committed state for FLAP_THRESHOLD
    # consecutive cycles before the change is accepted. This stops a genuinely flapping reverse
    # tunnel (e.g. hd-dev) from defeating the now_ports==previous_ports early-return and firing the
    # full notification cascade every 5s cycle.
    FLAP_THRESHOLD = 2

    def handle(self, *args, **options):
        raw_ports = get_ss_output_from_redis()
        # 取樣不可用（Redis 暫時無法連線 / ss_output 為空）：本輪視為 no-op，不發通知也不覆寫狀態，
        # 避免把所有隧道誤判為離線。/ Sample unavailable: skip this cycle so we don't emit false
        # 'disconnected' notifications or overwrite the committed ports_status with all-False.
        if raw_ports is None:
            self.stdout.write(self.style.WARNING("ss_output unavailable; skipping this update cycle"))
            return

        # 延遲監控：計算每條隧道的「裝置↔伺服器」RTT 並推播。刻意放在下方狀態早退
        # （now_ports == previous_ports）之前，這樣即使 online/offline 沒變，延遲仍會每個 cycle 更新。
        # 延遲為加法式、null-safe：完全不介入 ports_status / 去彈跳 / 既有通知。
        # Latency monitoring runs BEFORE the no-change early-return below, so a stably-connected
        # tunnel's latency keeps refreshing. It's additive/null-safe and never touches the status flow.
        latency_map = get_ss_latency_from_redis()
        if latency_map is not None:
            cache.set("ports_latency", latency_map, None)
            self._broadcast_latency(latency_map)

        previous_ports = cache.get("ports_status", {})
        # 先對原始取樣做去彈跳，再進入後續的狀態比對與通知。
        # Debounce the raw sample before the transition detection / notifications below.
        now_ports = self._debounce_ports(raw_ports, previous_ports)

        activated_ports = set()
        inactive_ports = set()
        for port, status in now_ports.items():
            if status:
                activated_ports.add(port)
            else:
                inactive_ports.add(port)

        # Compare the activated ports with the previous activated ports
        if now_ports == previous_ports:
            self.stdout.write(self.style.SUCCESS(f"Activated ports: {list(activated_ports)}"))
            self.stdout.write(self.style.SUCCESS(f"Inactivated ports: {list(inactive_ports)}"))
            self.stdout.write(self.style.SUCCESS("No new activated or deactivated ports"))
            return

        # Send notification for the updated reverse server status
        # Send personalized notifications to users based on their tunnel access permissions
        self._send_personalized_status_notifications(activated_ports)

        new_activated_ports = set()
        new_inactive_ports = set()

        for port, now_status in now_ports.items():
            previous_status = previous_ports.get(port, False)
            # status changed: False -> True (connected)
            if now_status and not previous_status:
                new_activated_ports.add(port)
                # Find users who have access to tunnels using this port
                authorized_users = self._get_port_authorized_users(port)
                if authorized_users:
                    send_notification_to_users(authorized_users, {
                        "action": "UPDATE-TUNNEL-STATUS",
                        "details": f"Tunnel on port [{port}] has been connected",
                        "port": port,
                        "status": "connected"
                    })
                # Send tunnel-specific connection update
                self._send_tunnel_connection_updates(port, True)

            # status changed: True -> False (disconnected)
            elif not now_status and previous_status:
                new_inactive_ports.add(port)
                # Find users who have access to tunnels using this port
                authorized_users = self._get_port_authorized_users(port)
                if authorized_users:
                    send_notification_to_users(authorized_users, {
                        "action": "UPDATE-TUNNEL-STATUS",
                        "details": f"Tunnel on port [{port}] has been disconnected",
                        "port": port,
                        "status": "disconnected"
                    })
                # Send tunnel-specific connection update
                self._send_tunnel_connection_updates(port, False)

        # Update the cache with the new activated ports
        cache.set("ports_status", now_ports, None)

        self.stdout.write(self.style.SUCCESS(f"Activated ports: {list(activated_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"Inactivated ports: {list(inactive_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"New activated ports: {list(new_activated_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"New inactivated ports: {list(new_inactive_ports)}"))
        self.stdout.write(self.style.SUCCESS("Successfully updated the ports status"))

    def _debounce_ports(self, raw_ports, previous_ports):
        """
        以 cache 中的每-port 計數器做遲滯（hysteresis）：
        - 原始取樣與已承認狀態相同 -> 維持並清除該 port 的計數。
        - 不同 -> 累加計數；累計達 FLAP_THRESHOLD 才承認新狀態，否則沿用舊狀態。
        本命令每 5 秒以「全新程序」執行，計數器必須存放在 cache（Redis）以跨程序保存。

        Hysteresis via a per-port counter kept in the cache:
        - raw sample equals the committed state -> keep it, clear the port's counter.
        - raw sample differs -> increment; only accept the new state after FLAP_THRESHOLD
          consecutive differing cycles, otherwise hold the old state.
        The counter lives in the cache because this command runs as a fresh process every 5s.
        """
        counters = cache.get("ports_flap_counter", {})
        now_ports = {}
        new_counters = {}
        for port, raw_status in raw_ports.items():
            committed = previous_ports.get(port, False)
            if raw_status == committed:
                # 穩定：維持已承認狀態，計數自然清零（不寫回 new_counters）。
                now_ports[port] = committed
            else:
                count = counters.get(port, 0) + 1
                if count >= self.FLAP_THRESHOLD:
                    # 連續多次不同 -> 承認變更，計數清零。
                    now_ports[port] = raw_status
                else:
                    # 尚未穩定 -> 沿用舊狀態並保留計數，等待下一輪。
                    now_ports[port] = committed
                    new_counters[port] = count
        cache.set("ports_flap_counter", new_counters, None)
        return now_ports

    def _broadcast_latency(self, latency_map):
        """
        把每條隧道的「裝置↔伺服器」RTT 推給前端（每個 cycle 都跑，與 online/offline 是否變動無關）。

        - 主頁面：對每位使用者的 user_{id}_notifications 群組推 UPDATE-TUNNEL-LATENCY，
          payload 只含該使用者可存取、且量得到 rtt 的 port（{port: rtt_ms}）。
        - Terminal：對每條有 rtt 的隧道，往 tunnel_connection_{id} 群組推 latency_update。

        latency_map = {reverse_port: rtt_ms}。此方法為加法式、null-safe，不動任何既有狀態邏輯。
        """
        if not latency_map:
            return
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.consumers import send_notification_to_user

            # prefetch_related('shared_with') 一次載入所有 TunnelSharing，避免 N+1。
            tunnels = ReverseServerAuthorizedKeys.objects.prefetch_related('shared_with')

            user_latency = {}  # user_id -> {port: rtt_ms}
            for tunnel in tunnels:
                port = tunnel.reverse_port
                rtt = latency_map.get(port)
                if rtt is None:
                    continue

                # Terminal 頁：per-tunnel 即時延遲（不觸碰 is_connected，避免與去彈跳狀態衝突）。
                send_tunnel_connection_update(tunnel.id, {
                    'type': 'latency_update',
                    'tunnel_id': tunnel.id,
                    'reverse_port': port,
                    'rtt_ms': rtt,
                })

                # 主頁面：彙整每位可存取使用者的 port→rtt（owner + 被分享者）。
                user_latency.setdefault(tunnel.user_id, {})[port] = rtt
                for sharing in tunnel.shared_with.all():
                    user_latency.setdefault(sharing.shared_with_id, {})[port] = rtt

            for user_id, latency in user_latency.items():
                send_notification_to_user(user_id, {
                    "action": "UPDATE-TUNNEL-LATENCY",
                    "latency": latency,
                    "details": "Tunnel latency updated",
                })

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error broadcasting latency: {e}"))

    def _send_tunnel_connection_updates(self, port, is_connected):
        """Send tunnel connection status updates for a specific port"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            
            # Find tunnels that use this port
            tunnels = ReverseServerAuthorizedKeys.objects.filter(reverse_port=port)
            
            for tunnel in tunnels:
                send_tunnel_connection_update(tunnel.id, {
                    'type': 'connection_status',
                    'tunnel_id': tunnel.id,
                    'reverse_port': port,
                    'is_connected': is_connected,
                    'host_friendly_name': tunnel.host_friendly_name
                })
                
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error sending tunnel connection updates for port {port}: {e}"))

    def _get_port_authorized_users(self, port):
        """Get list of user IDs who have access to tunnels using the specified port"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing

            authorized_users = set()

            # Find tunnels that use this port. prefetch_related('shared_with') 一次載入所有
            # TunnelSharing，避免每個 tunnel 各查一次的 N+1。
            tunnels = ReverseServerAuthorizedKeys.objects.filter(
                reverse_port=port
            ).prefetch_related('shared_with')

            for tunnel in tunnels:
                # Owner always has access (tunnel.user_id 為 FK 欄位值，不觸發查詢 / no query)
                authorized_users.add(tunnel.user_id)

                # Users granted access via sharing (sharing.shared_with_id -> no query)
                for sharing in tunnel.shared_with.all():
                    authorized_users.add(sharing.shared_with_id)

            return list(authorized_users)

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error getting authorized users for port {port}: {e}"))
            return []

    def _get_all_tunnel_authorized_users(self):
        """Get list of user IDs who have access to any tunnels"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing
            from django.contrib.auth.models import User

            authorized_users = set()

            # Get all tunnels (prefetch sharings to avoid an N+1 per tunnel)
            tunnels = ReverseServerAuthorizedKeys.objects.prefetch_related('shared_with')

            for tunnel in tunnels:
                # Owner always has access (tunnel.user_id -> no query)
                authorized_users.add(tunnel.user_id)

                # Users granted access via sharing (sharing.shared_with_id -> no query)
                for sharing in tunnel.shared_with.all():
                    authorized_users.add(sharing.shared_with_id)

            return list(authorized_users)

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error getting all authorized users: {e}"))
            return []

    def _send_personalized_status_notifications(self, activated_ports):
        """Send personalized status notifications to users based on their tunnel access"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing

            # Group users by their accessible ports
            user_ports_map = {}

            # Get all tunnels and their authorized users. prefetch_related('shared_with') 已載入
            # 每個 tunnel 的 TunnelSharing；用 *_id 取 FK 值避免額外查詢（原本每個 tunnel 各查
            # 一次 TunnelSharing 是 N+1）。
            tunnels = ReverseServerAuthorizedKeys.objects.prefetch_related('shared_with')

            for tunnel in tunnels:
                port = tunnel.reverse_port
                if port in activated_ports:
                    # Add owner (tunnel.user_id -> no query)
                    user_ports_map.setdefault(tunnel.user_id, set()).add(port)

                    # Add shared users (使用已 prefetch 的 shared_with；sharing.shared_with_id -> no query)
                    for sharing in tunnel.shared_with.all():
                        user_ports_map.setdefault(sharing.shared_with_id, set()).add(port)

            # Send personalized notifications
            from tunnels.consumers import send_notification_to_user
            for user_id, ports in user_ports_map.items():
                send_notification_to_user(user_id, {
                    "action": "UPDATE-TUNNEL-STATUS-DATA",
                    "data": list(ports),  # Only ports they can access
                    "details": "Reverse server status have been updated",
                })

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error sending personalized status notifications: {e}"))
