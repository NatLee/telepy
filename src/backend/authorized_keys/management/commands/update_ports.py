import time
from ast import literal_eval

from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis, get_ss_latency_from_redis

from tunnels.consumers import (
    send_tunnel_connection_update,
    send_notification_to_users,
    send_group_messages_batch,
    user_notification_event,
    tunnel_connection_event,
)

class Command(BaseCommand):
    help = "Get and update the SSH server usage ports from the ss command output."

    # 抖動去彈跳：port 狀態需連續 FLAP_THRESHOLD 次與「已承認狀態」不同，才承認變更。
    # Flap debounce: a port's raw state must disagree with the committed state for FLAP_THRESHOLD
    # consecutive cycles before the change is accepted. This stops a genuinely flapping reverse
    # tunnel (e.g. hd-dev) from defeating the now_ports==previous_ports early-return and firing the
    # full notification cascade every 5s cycle.
    FLAP_THRESHOLD = 2

    # 延遲廣播節流：RTT 每輪天然會抖動幾毫秒，若每次都廣播會產生無謂的 Redis 來回與前端 re-render。
    # 僅在有 port 的 RTT 變化 >= 門檻、或有 port 新增/消失時才廣播；並且最多每 KEEPALIVE 輪強制廣播
    # 一次以自我修復（例如前端剛連上）。/ Latency broadcast throttle: only fan out when some port's RTT
    # changes by >= threshold (or a port appears/disappears), with a periodic keep-alive to self-heal.
    LATENCY_BROADCAST_THRESHOLD_MS = 5.0
    LATENCY_BROADCAST_KEEPALIVE_CYCLES = 6

    def add_arguments(self, parser):
        # --loop：常駐執行，Django 只 import 一次，避免每輪冷啟動整個框架造成 CPU 週期性尖峰。
        # 舊做法是由 shell 每 5s 呼叫一次本指令（每次都重新 import Django/DRF/channels…），會週期性
        # 拖慢同容器內的 gunicorn worker。改用 --loop 讓程序常駐、只在迴圈內重跑取樣邏輯。
        # --loop keeps the process resident (Django imported once) instead of the shell cold-starting
        # a fresh Django on every cycle, which periodically pegged a CPU core and janked the workers.
        parser.add_argument(
            "--loop",
            action="store_true",
            help="Run continuously in-process instead of exiting after one cycle.",
        )
        parser.add_argument(
            "--interval",
            type=float,
            default=5.0,
            help="Seconds to sleep between cycles when --loop is set (default: 5).",
        )

    def handle(self, *args, **options):
        if options.get("loop"):
            interval = options.get("interval", 5.0)
            self.stdout.write(self.style.SUCCESS(
                f"Starting update_ports in resident loop (interval={interval}s)"
            ))
            while True:
                try:
                    self.run_once()
                except Exception as e:
                    # 單輪失敗不可讓常駐程序退出（supervisor 會重啟但又要付冷啟動成本）。
                    # One cycle failing must not kill the resident loop.
                    self.stdout.write(self.style.ERROR(f"update_ports cycle error: {e}"))
                time.sleep(interval)
        else:
            self.run_once()

    def run_once(self):
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
        # 節流：與上次已廣播的 latency 比對，變化不顯著且未到 keep-alive 週期就整輪跳過。
        if not self._latency_should_broadcast(latency_map):
            return
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys

            # prefetch_related('shared_with') 一次載入所有 TunnelSharing，避免 N+1。
            tunnels = ReverseServerAuthorizedKeys.objects.prefetch_related('shared_with')

            # 收集所有要送的訊息，最後以「單一 event loop」一次批次送出（見 send_group_messages_batch），
            # 而非每則各做一次 async_to_sync（每次都建/拆一個 event loop）。
            batch = []  # list of (group_name, event_dict)

            user_latency = {}  # user_id -> {port: rtt_ms}
            for tunnel in tunnels:
                port = tunnel.reverse_port
                rtt = latency_map.get(port)
                if rtt is None:
                    continue

                # Terminal 頁：per-tunnel 即時延遲（不觸碰 is_connected，避免與去彈跳狀態衝突）。
                batch.append((
                    f'tunnel_connection_{tunnel.id}',
                    tunnel_connection_event({
                        'type': 'latency_update',
                        'tunnel_id': tunnel.id,
                        'reverse_port': port,
                        'rtt_ms': rtt,
                    }),
                ))

                # 主頁面：彙整每位可存取使用者的 port→rtt（owner + 被分享者）。
                #
                # ⚠ key 必須是字串：channel layer（channels_redis）以 msgpack 序列化，新版預設
                # strict_map_key=True，「int 作為 map key」在收端解包時會炸出
                # ValueError: int is not allowed for map key —— 且 channels_redis 的共用接收迴圈
                # 會讓這個例外在同 worker 的任意 consumer 身上引爆（包含 terminal），造成全面斷線。
                # 前端無感：訊息本來就會經 json.dumps，int key 到瀏覽器端一律變字串。
                # ⚠ Keys MUST be strings: the channel layer serializes with msgpack, whose modern
                # default strict_map_key=True raises on int map keys AT UNPACK TIME — and
                # channels_redis' shared receive loop detonates that error inside an arbitrary
                # consumer on the worker (terminal included), mass-disconnecting sockets.
                # The frontend is unaffected: json.dumps stringifies keys anyway.
                user_latency.setdefault(tunnel.user_id, {})[str(port)] = rtt
                for sharing in tunnel.shared_with.all():
                    user_latency.setdefault(sharing.shared_with_id, {})[str(port)] = rtt

            for user_id, latency in user_latency.items():
                batch.append((
                    f'user_{user_id}_notifications',
                    user_notification_event({
                        "action": "UPDATE-TUNNEL-LATENCY",
                        "latency": latency,
                        "details": "Tunnel latency updated",
                    }),
                ))

            send_group_messages_batch(batch)

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error broadcasting latency: {e}"))

    def _latency_should_broadcast(self, latency_map):
        """
        決定本輪是否需要廣播延遲。/ Decide whether to broadcast latency this cycle.

        規則：任一 port 的 RTT 相較上次廣播變化 >= LATENCY_BROADCAST_THRESHOLD_MS，或有 port 新增/消失，
        則廣播；否則累計 keep-alive 計數，達到 LATENCY_BROADCAST_KEEPALIVE_CYCLES 時強制廣播一次（自我修復）。
        會廣播時把本次 latency 與計數狀態寫回 cache。
        """
        last = cache.get("ports_latency_last", {})
        counter = cache.get("ports_latency_bcast_counter", 0)

        changed = set(latency_map.keys()) != set(last.keys())
        if not changed:
            for port, rtt in latency_map.items():
                prev = last.get(port)
                if prev is None or abs(rtt - prev) >= self.LATENCY_BROADCAST_THRESHOLD_MS:
                    changed = True
                    break

        force = counter + 1 >= self.LATENCY_BROADCAST_KEEPALIVE_CYCLES
        if changed or force:
            cache.set("ports_latency_last", latency_map, None)
            cache.set("ports_latency_bcast_counter", 0, None)
            return True

        cache.set("ports_latency_bcast_counter", counter + 1, None)
        return False

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
