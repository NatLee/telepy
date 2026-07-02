import os
import json
import asyncio
import pty
import signal
import fcntl
import termios
import struct
import codecs
import subprocess

from asgiref.sync import sync_to_async
from asgiref.sync import async_to_sync

from django.contrib.auth.models import User
from django.shortcuts import get_object_or_404

from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

from channels.layers import get_channel_layer
from channels.generic.websocket import AsyncWebsocketConsumer

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames
from tunnels.models import TunnelSharing, TunnelPermissionManager, TunnelPermission

import logging
logger = logging.getLogger(__name__)


# 連線後多少秒內必須送出有效的 auth 訊息，否則關閉（避免未認證連線佔用資源）。
# Seconds allowed to send a valid auth frame after connect (reaps unauthenticated sockets).
WS_AUTH_TIMEOUT = 10


def _parse_json(text_data):
    """安全解析 JSON 文字訊息；失敗回傳 None。/ Safely parse a JSON text frame; None on failure."""
    if not text_data:
        return None
    try:
        return json.loads(text_data)
    except (json.JSONDecodeError, TypeError):
        return None


async def _authenticate_token(token):
    """
    驗證「第一則 auth 訊息」帶來的 JWT，回傳 (user, error_code)。
    error_code：None 代表通過；4000 缺 token；4001 token 無效/過期或使用者不存在。
    Validate the JWT from the first auth frame. Returns (user, error_code).
    """
    if not token:
        return None, 4000
    try:
        access_token = AccessToken(token)
    except (InvalidToken, TokenError) as e:
        logger.warning(f"WS token invalid: {e}")
        return None, 4001
    try:
        user = await sync_to_async(User.objects.get)(id=access_token['user_id'])
    except User.DoesNotExist:
        return None, 4001
    return user, None


class FirstMessageAuthConsumer(AsyncWebsocketConsumer):
    """
    「連線後第一則訊息帶 token」認證的共用基底（取代 ws-ticket / subprotocol JWT）。

    流程：
      1. connect(): 立即 accept()，並啟動 auth 逾時計時器（WS_AUTH_TIMEOUT 秒）。
      2. 第一則訊息必須是 {"type": "auth", "token": "<jwt>", ...}；先驗證 JWT，通過後呼叫
         after_auth() 讓各 consumer 做自己的權限檢查與資源建立；成功後才把後續訊息交給 on_message()。
      3. 逾時未認證、JWT 無效、或 after_auth 回傳關閉碼 -> 以對應碼關閉連線。

    為什麼這樣做：JWT 只出現在 WebSocket 訊息 payload，不進 URL / subprotocol / 任何請求 header，
    因此不會被反向代理或 access log 記錄下來（這是相較於「token 放 subprotocol」的安全優勢），
    同時又省掉 ws-ticket 那一趟預先 HTTP round-trip（連線更快）。

    First-message auth base: accept() immediately, then the first frame must be
    {"type":"auth","token":...}. On a valid JWT, after_auth() runs the per-consumer permission/resource
    setup; later frames go to on_message(). The JWT never leaves the WS payload (not in URL/subprotocol/
    headers, so proxies/logs can't capture it) and there's no ws-ticket pre-flight round-trip.

    子類別覆寫：
      after_auth(user, message) -> Optional[int]：權限檢查與資源建立，成功回 None，失敗回 WS 關閉碼。
      on_message(text_data, bytes_data)：認證後的一般訊息處理。
    子類別若覆寫 disconnect()，請務必呼叫 super().disconnect() 以取消逾時計時器。
    """

    async def connect(self):
        self._authed = False
        self._auth_timeout_task = None
        await self.accept()
        self._auth_timeout_task = asyncio.create_task(self._await_auth_timeout())

    async def _await_auth_timeout(self):
        try:
            await asyncio.sleep(WS_AUTH_TIMEOUT)
        except asyncio.CancelledError:
            return
        if not self._authed:
            logger.warning(f"{type(self).__name__}: no auth within {WS_AUTH_TIMEOUT}s, closing")
            await self.close(code=4001)

    async def receive(self, text_data=None, bytes_data=None):
        # 尚未認證：只接受第一則 auth 訊息，其餘一律拒絕。
        # Not yet authenticated: only the first auth frame is accepted; everything else is rejected.
        if not getattr(self, '_authed', False):
            await self._authenticate(text_data)
            return
        await self.on_message(text_data=text_data, bytes_data=bytes_data)

    async def _authenticate(self, text_data):
        data = _parse_json(text_data)
        if not isinstance(data, dict) or data.get('type') != 'auth':
            await self.close(code=4000)
            return
        user, err = await _authenticate_token(data.get('token'))
        if err is not None:
            await self.close(code=err)
            return
        err = await self.after_auth(user, data)
        if err is not None:
            await self.close(code=err)
            return
        self._authed = True
        if self._auth_timeout_task is not None:
            self._auth_timeout_task.cancel()

    async def disconnect(self, close_code):
        task = getattr(self, '_auth_timeout_task', None)
        if task is not None:
            task.cancel()

    async def after_auth(self, user, message):
        """驗證通過後的權限檢查與資源建立。成功回 None，否則回 WS 關閉碼。/ Override in subclass."""
        return None

    async def on_message(self, text_data=None, bytes_data=None):
        """認證後的一般訊息處理。/ Handle post-auth messages. Override in subclass."""
        return


class TerminalConsumer(FirstMessageAuthConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.child_pid = None
        self.fd = None
        # 增量 UTF-8 解碼器：os.read 以 1024 bytes 為界，可能把多位元組字元（如中日韓）切半；
        # 增量解碼會把未完成的位元組保留到下一次，避免 UnicodeDecodeError 或亂碼。
        # Incremental UTF-8 decoder: a 1024-byte read can split a multibyte char (e.g. CJK) at the
        # boundary; the incremental decoder buffers the incomplete tail so we neither crash nor mojibake.
        self._output_decoder = codecs.getincrementaldecoder('utf-8')('replace')

    async def after_auth(self, user, message):
        # 認證後：從 auth 訊息取得資源識別（非敏感，隨 token 一起在 payload 內）。
        # After auth: read the (non-sensitive) resource ids from the auth message payload.
        server_id = str(message.get('server_id') or '')
        username = message.get('username')
        if not server_id or not username:
            logger.error("Terminal auth message missing server_id/username")
            return 4000
        logger.info(f"Terminal user authenticated: {user}")

        # 一次完成所有連線前的 DB 檢查（權限 / port / 是否有目標使用者 / username 是否允許），
        # 取代原本 4 次分開的 sync_to_async round-trip，減少 thread-pool 切換與 SQLite 讀取次數。
        # Single DB round-trip for all pre-connect checks (was 4 separate sync_to_async hops).
        reverse_port, access_error = await self._resolve_terminal_access(user, server_id, username)
        if access_error is not None:
            logger.error(f"Terminal access denied for user [{user}] server [{server_id}] (code={access_error})")
            return access_error

        # Start the SSH connection
        if self.child_pid is None:
            try:
                # Fork a child process
                self.child_pid, self.fd = pty.fork()
                if self.child_pid == 0:  # Child process
                    # Set TERM environment variable to xterm
                    os.environ['TERM'] = 'xterm'
                    # Execute the SSH command.
                    # 快連參數：關掉 GSSAPI（避免無謂的 GSSAPI 協商等待數秒）、只用公鑰認證、開壓縮，
                    # 並以 ControlMaster 連線多工重用（同一 user@port 的後續連線走既有 socket，省掉重複
                    # 的雙跳 handshake），大幅縮短「WebSocket 連上後才出現 shell」的等待。
                    # Fast-connect opts: disable GSSAPI, pubkey-only, compression, and ControlMaster
                    # multiplexing so repeat connects reuse the existing double-hop socket.
                    ssh_opts = (
                        "-o GSSAPIAuthentication=no "
                        "-o PreferredAuthentications=publickey "
                        "-o ServerAliveInterval=15 -o ServerAliveCountMax=3 "
                        "-o Compression=yes "
                        "-o ControlMaster=auto "
                        "-o ControlPersist=600 "
                        "-o ControlPath=/tmp/ssh_term_%r@%h:%p"
                    )
                    os.execlp('bash', 'bash', '-c', f'ssh {ssh_opts} {username}@reverse -p {reverse_port}')
                else:  # Parent process
                    asyncio.get_event_loop().add_reader(self.fd, self.forward_output)
                logger.info("SSH connection started")
            except Exception as e:
                logger.error(f"Error starting SSH connection: {e}")
                return 4005
        return None

    @sync_to_async
    def _resolve_terminal_access(self, user, server_id, username):
        """
        單一 DB round-trip 完成終端機連線的所有前置檢查。/ All pre-connect checks in one DB round-trip.

        回傳 (reverse_port, error_code)；error_code 為 None 代表通過，否則為對應的 WS 關閉碼：
          4004 隧道不存在或無存取權 / 4002 無有效 reverse_port
          4006 未設定任何目標使用者 / 4003 username 不在允許清單
        關閉碼刻意沿用原本 4 個分開方法的語意，前端錯誤訊息不受影響。
        """
        from services.tunnel_permissions import TunnelPermissionService

        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return None, 4004  # 沿用原 check_permissions 找不到即 False -> 4004

        if not TunnelPermissionManager.check_access(user, tunnel, TunnelPermission.VIEW):
            return None, 4004

        reverse_port = tunnel.reverse_port
        if not reverse_port:
            return None, 4002

        if not ReverseServerUsernames.objects.filter(reverse_server=tunnel).exists():
            return None, 4006

        allowed_usernames = TunnelPermissionService.get_allowed_usernames(user, tunnel)
        if not allowed_usernames.filter(username=username).exists():
            return None, 4003

        return reverse_port, None


    async def disconnect(self, close_code):
        await super().disconnect(close_code)  # 取消 auth 逾時計時器 / cancel the auth-timeout task
        # 「每次連線都是全新 shell」的另一半保證：WebSocket 一斷，就確實終結這條連線的 ssh 客戶端，
        # 讓遠端 sshd 收到 channel 關閉並對該 shell 送 SIGHUP —— 舊 shell 不會殘留到下次連線。
        # （ControlMaster 重用的只是加密連線；shell/session 一律隨本 consumer 的 ssh process 生滅。）
        # The other half of the "fresh shell every time" guarantee: when the WS drops, terminate this
        # connection's ssh client so the remote sshd closes the channel and SIGHUPs that shell.
        pid, fd = self.child_pid, self.fd
        self.child_pid = None
        self.fd = None

        # 先移除 reader，避免清理期間 fd EOF 反覆觸發 forward_output。/ Remove the reader first.
        if fd is not None:
            try:
                asyncio.get_event_loop().remove_reader(fd)
            except Exception:
                pass

        if pid:
            try:
                # pty.fork 的子行程是 session leader（pgid == pid）：用 killpg 連同 ssh 可能衍生的
                # 子行程（如 ProxyCommand）一起收掉。/ The child is a session leader; killpg reaps helpers too.
                try:
                    os.killpg(pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    os.kill(pid, signal.SIGTERM)

                # 輪詢等待（最長 ~0.5s）而非固定 sleep：ssh 幾乎都在數十 ms 內結束，斷線清理不用每次
                # 卡滿 0.5 秒。/ Poll with WNOHANG instead of a fixed 0.5s sleep; ssh usually exits in ms.
                reaped = False
                for _ in range(10):
                    wpid, _status = os.waitpid(pid, os.WNOHANG)
                    if wpid == pid:
                        reaped = True
                        break
                    await asyncio.sleep(0.05)

                if not reaped:
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        os.kill(pid, signal.SIGKILL)
                    os.waitpid(pid, 0)  # SIGKILL 後必定可回收 / reap is immediate after SIGKILL
            except (ProcessLookupError, ChildProcessError):
                pass  # 行程已結束且已被回收 / already gone and reaped
            except OSError as e:
                logger.warning(f"Terminal child cleanup failed for pid {pid}: {e}")

        # 關閉 PTY master fd。舊版從未 close，導致每開一次終端就洩漏一個 fd，
        # 長時間運行後 worker 會 fd 耗盡（開新終端變慢/失敗）。/ Close the PTY master fd.
        # The old code never closed it, leaking one fd per terminal session until the worker
        # ran out of descriptors.
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass

    async def on_message(self, text_data=None, bytes_data=None):
        # Handle receiving input from the client (e.g., keyboard input)
        if not text_data:
            return
        # 對格式錯誤的訊息做防呆：不讓一個壞掉的 frame（JSON 解析失敗 / 缺 key）直接關閉終端連線。
        # Guard malformed frames so a single bad message (bad JSON / missing keys) can't drop the terminal.
        try:
            data = json.loads(text_data)
        except (json.JSONDecodeError, TypeError):
            logger.warning("Terminal received malformed JSON; ignoring frame")
            return

        action = data.get('action')

        # 應用層心跳：前端用來量測「你↔伺服器」的 WebSocket RTT。
        # 關鍵：pong 以 bytes_data 回傳，而非 text_data——因為終端機 onmessage 會把所有 text 直接
        # 寫進 xterm 畫面（term.write），用 binary 才能讓前端辨識為控制訊息而不污染畫面。
        # App-level heartbeat for the client to measure the "you↔server" WebSocket RTT. The pong MUST
        # be sent as bytes_data (not text): the terminal writes every text frame straight into xterm,
        # so a binary frame is what lets the client treat it as a control message without corrupting output.
        if action == 'ping':
            await self.send(bytes_data=b'pong')
            return

        payload = data.get('payload')
        if not isinstance(payload, dict):
            return

        try:
            # Handle pty_input action
            if action == 'pty_input' and self.fd and 'input' in payload:
                os.write(self.fd, payload['input'].encode())

            # Handle resize action
            elif action == 'pty_resize' and self.fd and isinstance(payload.get('size'), dict):
                # Frontend sends size as dict with keys: rows, cols, height, width
                pty_size = payload['size']
                if all(k in pty_size for k in ('rows', 'cols', 'height', 'width')):
                    pty_size_bytes = struct.pack('HHHH', pty_size['rows'], pty_size['cols'], pty_size['height'], pty_size['width'])
                    fcntl.ioctl(self.fd, termios.TIOCSWINSZ, pty_size_bytes)
        except (OSError, struct.error) as e:
            logger.warning(f"Terminal input/resize failed: {e}")

    def _stop_forwarding(self):
        """
        立即移除 PTY fd 的 reader，避免「已 EOF / 已錯誤」的 fd 反覆觸發 forward_output 造成忙迴圈。
        Remove the PTY fd reader immediately so a dead/EOF fd can't busy-loop this callback (which would
        otherwise keep scheduling self.close() until disconnect()'s 0.5s sleep finally removes it).
        remove_reader 具冪等性；disconnect() 之後再呼叫一次亦安全。
        """
        fd = self.fd
        if fd is not None:
            try:
                asyncio.get_event_loop().remove_reader(fd)
            except Exception:
                pass

    def forward_output(self):
        try:
            data = os.read(self.fd, 1024)
            if len(data) == 0:
                self._stop_forwarding()
                # EOF received, meaning the shell has been exited.
                # 注意：以「原始 bytes 長度」判斷 EOF，而非解碼後字串——因為多位元組字元被切半時
                # 增量解碼器會回傳空字串，不能誤判為 EOF。
                # Detect EOF from the raw byte count, not the decoded string: a split multibyte char
                # yields an empty decode result that must NOT be mistaken for EOF.
                asyncio.ensure_future(self.close())
                return
            output = self._output_decoder.decode(data)
            if output:
                asyncio.ensure_future(self.send(text_data=output))
        except OSError:
            # OSError can occur if the fd has been closed due to the process exiting.
            # 立即移除 reader 再排程 close，阻止忙迴圈（見 _stop_forwarding）。
            self._stop_forwarding()
            asyncio.ensure_future(self.close())

class NotificationConsumer(FirstMessageAuthConsumer):
    async def after_auth(self, user, message):
        self.user = user
        logger.info(f"Notification user authenticated: {self.user}")

        # Join user-specific notification group
        self.user_group_name = f'user_{self.user.id}_notifications'
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )
        return None

    async def disconnect(self, close_code):
        await super().disconnect(close_code)  # 取消 auth 逾時計時器 / cancel the auth-timeout task
        # Leave user notification group.
        # 注意：connect() 加入的是 self.user_group_name（不是 room_group_name）。
        # 舊碼誤判 hasattr(self, 'room_group_name') 這個從未設定的屬性，導致 group_discard
        # 永遠不會執行，每次斷線就在 user_{id}_notifications 洩漏一個死 channel（最長存活 24h），
        # 讓每次 group_send 廣播越來越重。/ Discard the group we actually joined (user_group_name);
        # the old code guarded on the never-set 'room_group_name', so discard never ran and every
        # disconnect leaked a dead channel into the notification group.
        if hasattr(self, 'user_group_name'):
            await self.channel_layer.group_discard(
                self.user_group_name,
                self.channel_name
            )

    async def on_message(self, text_data=None, bytes_data=None):
        # 應用層心跳：回應前端 ping，用於偵測半開連線。/ App-level heartbeat: reply to the client's ping.
        if not text_data:
            return
        try:
            if json.loads(text_data).get('type') == 'ping':
                await self.send(text_data=json.dumps({'type': 'pong'}))
        except (json.JSONDecodeError, TypeError):
            pass

    # Receive message from room group
    async def send_notification(self, event):
        message = event['message']
        action = message.get('action')

        logger.debug(f"Sending notification to user {self.user}: {action}")

        # Send message to WebSocket (no permission check needed since notifications are targeted)
        await self.send(text_data=json.dumps({
            'message': message
        }))
        logger.debug(f"Notification sent to user {self.user}: {action}")


def send_notification_to_user(user_id: int, message: dict):
    """
    Send notification to a specific user.
    """
    logger.debug(f"Sending notification to user {user_id}: {message.get('action')}")
    try:
        channel_layer = get_channel_layer()
        group_name = f'user_{user_id}_notifications'
        async_to_sync(channel_layer.group_send)(
            group_name,
            {
                'type': 'send_notification',
                'message': message
            }
        )
        logger.debug(f"Notification sent to user {user_id}: {message.get('action')}")
    except Exception as e:
        logger.error(f"Failed to send notification to user {user_id}: {e}")


def send_notification_to_users(user_ids: list[int], message: dict):
    """
    Send notification to multiple specific users.
    """
    for user_id in user_ids:
        send_notification_to_user(user_id, message)


async def _async_group_send_many(items):
    """
    在「單一 event loop」內連續送出多則 group_send。/ Fan out many group_sends within ONE event loop.

    items：iterable of (group_name, event_dict)。相較於對每則訊息各呼叫一次 async_to_sync
    （每次都會新建/拆除一個 event loop 並可能新開 Redis 連線），本函式共用同一個 channel_layer
    與 event loop，把每 5s 的延遲/狀態廣播從 O(N) 次 loop 建立降為 1 次。
    """
    channel_layer = get_channel_layer()
    if channel_layer is None:
        return
    for group_name, event in items:
        try:
            await channel_layer.group_send(group_name, event)
        except Exception as e:
            logger.error(f"batch group_send failed for {group_name}: {e}")


def send_group_messages_batch(items):
    """
    批次 group_send 的同步進入點：整批只做「一次」async_to_sync（而非每則一次）。
    Sync entrypoint for batched group_send: a single async_to_sync for the whole batch.

    items：list of (group_name, event_dict)，event_dict 需自帶 consumer handler 的 'type'。
    """
    items = list(items)
    if not items:
        return
    async_to_sync(_async_group_send_many)(items)


def user_notification_event(message: dict):
    """建立 NotificationConsumer.send_notification 可處理的事件。/ Build a NotificationConsumer event."""
    return {'type': 'send_notification', 'message': message}


def tunnel_connection_event(message: dict):
    """建立 TunnelConnectionConsumer.tunnel_connection_update 可處理的事件。/ Build a TunnelConnection event."""
    return {'type': 'tunnel_connection_update', 'message': message}



class TunnelConnectionConsumer(FirstMessageAuthConsumer):
    """
    WebSocket consumer for monitoring tunnel connection status during creation.
    Authenticates via the first {"type":"auth","token":...,"tunnel_id":...} message.
    """
    async def after_auth(self, user, message):
        # tunnel_id 隨 auth 訊息帶入；若無則退回 URL route 參數。
        # tunnel_id comes in the auth message; fall back to the URL route param.
        tunnel_id = message.get('tunnel_id') or self.scope['url_route']['kwargs'].get('tunnel_id')
        if not tunnel_id:
            logger.error("[TunnelConnection] auth message missing tunnel_id")
            return 4000

        self.tunnel_id = str(tunnel_id)
        self.room_group_name = f'tunnel_connection_{self.tunnel_id}'
        logger.info(f"[TunnelConnection] User authenticated: {user}")

        # Ensure the tunnel belongs to the user
        has_permissions = await self._check_tunnel_permission(user, self.tunnel_id)
        if not has_permissions:
            logger.error(f"[TunnelConnection] User [{user}] has no access to tunnel [{self.tunnel_id}]")
            return 4004

        # Join room (socket already accepted by the base) and send initial status.
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.send_connection_status()
        return None

    async def disconnect(self, close_code):
        await super().disconnect(close_code)  # 取消 auth 逾時計時器 / cancel the auth-timeout task
        # Leave room group
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

    async def on_message(self, text_data=None, bytes_data=None):
        # 應用層心跳：回應前端 ping。/ App-level heartbeat: reply to the client's ping.
        if not text_data:
            return
        try:
            if json.loads(text_data).get('type') == 'ping':
                await self.send(text_data=json.dumps({'type': 'pong'}))
        except (json.JSONDecodeError, TypeError):
            pass

    async def send_connection_status(self):
        """Check and send current tunnel connection status"""
        try:
            from django.core.cache import cache
            from authorized_keys.models import ReverseServerAuthorizedKeys

            reverse_server = await sync_to_async(ReverseServerAuthorizedKeys.objects.get)(id=self.tunnel_id)
            reverse_port = reverse_server.reverse_port

            ports_status = cache.get("ports_status", {})
            is_connected = ports_status.get(reverse_port, False)
            # 首屏就帶入「裝置↔伺服器」RTT（由 update_ports 週期性寫入 ports_latency；量不到則為 None）。
            ports_latency = cache.get("ports_latency", {})
            rtt_ms = ports_latency.get(reverse_port)

            await self.send(text_data=json.dumps({
                'type': 'connection_status',
                'tunnel_id': int(self.tunnel_id),
                'reverse_port': reverse_port,
                'is_connected': is_connected,
                'host_friendly_name': reverse_server.host_friendly_name,
                'rtt_ms': rtt_ms,
            }))

        except Exception as e:
            logger.error(f"[TunnelConnection] Error checking tunnel connection status: {e}")
            await self.send(text_data=json.dumps({
                'type': 'error',
                'message': 'Failed to check connection status'
            }))

    # Receive message from room group
    async def tunnel_connection_update(self, event):
        """Handle tunnel connection status updates"""
        await self.send(text_data=json.dumps(event['message']))

    @sync_to_async
    def _check_tunnel_permission(self, user, tunnel_id) -> bool:
        # Check if the user owns the tunnel
        try:
            ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=user)
            return True
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        # Check if tunnel is shared with the user
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id)
            # Check if there's a sharing record for this user
            sharing_exists = TunnelSharing.objects.filter(
                tunnel=tunnel,
                shared_with=user
            ).exists()
            if sharing_exists:
                return True
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        return False

def send_tunnel_connection_update(tunnel_id: int, message: dict):
    """Send tunnel connection status update to specific tunnel room"""
    channel_layer = get_channel_layer()
    if channel_layer:
        room_group_name = f'tunnel_connection_{tunnel_id}'
        async_to_sync(channel_layer.group_send)(
            room_group_name,
            {
                'type': 'tunnel_connection_update',
                'message': message
            }
        )

class FileManagerConsumer(FirstMessageAuthConsumer):
    """
    WebSocket Consumer for file management operations
    Handles file listing, upload, and download operations via WebSocket.
    Authenticates via the first {"type":"auth","token":...,"server_id":...,"username":...} message.
    """
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.server_id = None
        self.username = None
        self.user = None
        self.reverse_server = None
        # Persistent SSH session
        self.ssh_process = None
        self.ssh_stdin = None
        self.ssh_stdout = None
        self.ssh_stderr = None

    async def after_auth(self, user, message):
        # 認證後：從 auth 訊息取得資源識別（非敏感，隨 token 在 payload 內）。
        # After auth: read the (non-sensitive) resource ids from the auth message payload.
        server_id = str(message.get('server_id') or '')
        username = message.get('username')
        if not server_id or not username:
            logger.error("FileManager auth message missing server_id/username")
            return 4000
        logger.info(f"FileManager user authenticated: {user}")

        # Check if user has access to the server
        has_permissions = await self.check_permissions(user, server_id)
        if not has_permissions:
            logger.error(f"User [{user}] does not have access to server [{server_id}]")
            return 4004

        # Get reverse server port (to validate server ID)
        reverse_port = await self.get_reverse_server_port(server_id, user)
        if not reverse_port:
            logger.error(f"Invalid server ID: {server_id}")
            return 4002

        # Check if any target server usernames exist (4006 = none configured)
        has_usernames = await sync_to_async(
            lambda: ReverseServerUsernames.objects.filter(reverse_server_id=server_id).exists()
        )()
        if not has_usernames:
            logger.error(f"No target server usernames configured for server [{server_id}]")
            return 4006

        # Check if username is valid
        if not await self.check_username(server_id, username, user):
            logger.error(f"Invalid username: {username}")
            return 4003

        # Store connection details
        self.server_id = server_id
        self.username = username
        self.user = user

        # Get reverse server (checking ownership or sharing)
        try:
            self.reverse_server = await sync_to_async(
                lambda: ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            )()
        except ReverseServerAuthorizedKeys.DoesNotExist:
            # Check if tunnel is shared with the user
            try:
                self.reverse_server = await sync_to_async(
                    lambda: ReverseServerAuthorizedKeys.objects.get(id=server_id)
                )()
                # Verify sharing exists
                sharing_exists = await sync_to_async(
                    lambda: TunnelSharing.objects.filter(
                        tunnel=self.reverse_server,
                        shared_with=user
                    ).exists()
                )()
                if not sharing_exists:
                    logger.error(f"User [{user}] does not have access to server [{server_id}]")
                    return 4004
            except ReverseServerAuthorizedKeys.DoesNotExist:
                logger.error(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist")
                return 4004

        # Socket already accepted by the base; initialize the persistent SSH session.
        try:
            await self.initialize_ssh_session()
            logger.info("FileManager authenticated with persistent SSH session")
        except Exception as e:
            logger.error(f"Failed to initialize SSH session: {e}")
            # 清掉可能已 spawn 的 ControlMaster 'cat' 子程序，避免失敗連線累積殭屍 SSH。
            # Clean up the ControlMaster 'cat' subprocess that may already be running so failed
            # connects don't accumulate orphaned SSH processes.
            await self.cleanup_ssh_session()
            return 4005
        return None

    async def disconnect(self, close_code):
        await super().disconnect(close_code)  # 取消 auth 逾時計時器 / cancel the auth-timeout task
        logger.info(f"FileManager WebSocket disconnected with code: {close_code}")

        # Clean up SSH session
        await self.cleanup_ssh_session()

    async def on_message(self, text_data=None, bytes_data=None):
        """Handle incoming WebSocket messages for file operations"""
        if not text_data:
            return

        try:
            data = json.loads(text_data)
            # 應用層心跳 / app-level heartbeat
            if data.get('type') == 'ping':
                await self.send(text_data=json.dumps({'type': 'pong'}))
                return
            action = data.get('action')
            payload = data.get('payload', {})

            if action == 'list_files':
                await self.handle_list_files(payload)
            elif action == 'shell_detect':
                await self.handle_shell_detect()
            else:
                await self.send_error(f"Unknown action: {action}")

        except json.JSONDecodeError:
            await self.send_error("Invalid JSON data")
        except Exception as e:
            logger.error(f"Error handling file operation: {e}")
            await self.send_error(f"Internal error: {str(e)}")

    async def handle_list_files(self, payload):
        """Handle file listing requests"""
        try:
            path = payload.get('path', '~/')
            
            # Check if it's PowerShell or Unix using persistent session
            is_ps = await self.is_powershell_persistent()
            
            if is_ps:
                path = payload.get('path', 'C:\\')
                command = f"""Get-ChildItem -Path "{path}" | Select-Object Mode, LastWriteTime, Length, Name | ConvertTo-Json"""
            else:
                command = f"ls -la {path}"

            # Execute command using persistent session
            stdout, stderr, returncode = await self.execute_ssh_command_persistent(command)
            
            if returncode == 0:
                if is_ps:
                    # Parse PowerShell JSON output
                    files = await self.parse_powershell_output(stdout)
                else:
                    # Parse Unix ls output
                    files = await self.parse_unix_output(stdout, path)
                
                await self.send_response('list_files', {
                    'status': 'success',
                    'path': path,
                    'files': files
                })
            else:
                await self.send_error(f"Failed to list files: {stderr}")

        except Exception as e:
            logger.error(f"Error listing files: {e}")
            await self.send_error(f"Failed to list files: {str(e)}")

    async def handle_shell_detect(self):
        """Handle shell detection requests"""
        try:
            # Use persistent session for shell detection
            is_ps = await self.is_powershell_persistent()
            shell_type = 'powershell' if is_ps else 'unix'
            
            await self.send_response('shell_detect', {
                'status': 'success',
                'shell': shell_type
            })

        except Exception as e:
            logger.error(f"Error detecting shell: {e}")
            await self.send_error(f"Failed to detect shell: {str(e)}")

    async def send_response(self, action, data):
        """Send successful response to client"""
        await self.send(text_data=json.dumps({
            'action': action,
            'data': data
        }))

    async def send_error(self, message):
        """Send error response to client"""
        await self.send(text_data=json.dumps({
            'action': 'error',
            'data': {
                'status': 'error',
                'message': message
            }
        }))

    # Helper methods (using sync functions from web_sftp.views)
    def execute_ssh_command(self, server, port, command):
        """Execute SSH command synchronously"""
        from web_sftp.views import execute_ssh_command
        return execute_ssh_command(server, port, command)

    def is_powershell(self, server, port):
        """Check if server is using PowerShell"""
        from web_sftp.views import is_powershell
        return is_powershell(server, port)

    async def parse_powershell_output(self, stdout):
        """Parse PowerShell JSON output"""
        try:
            import json
            data = json.loads(stdout)
            if not isinstance(data, list):
                data = [data]
            
            files = []
            for item in data:
                name = item.get('Name', '')
                mode = item.get('Mode', '')
                length = item.get('Length', 0)
                
                # Determine if it's a directory
                is_directory = 'd' in mode.lower() or 'directory' in mode.lower()
                
                files.append({
                    'name': name,
                    'type': 'directory' if is_directory else 'file',
                    'size': self.format_size(length) if length else 'N/A'
                })
            
            return files
        except:
            return []

    async def parse_unix_output(self, stdout, path):
        """Parse Unix ls -la output"""
        try:
            lines = stdout.strip().split('\n')[1:]  # Skip total line
            files = []
            
            for line in lines:
                if not line.strip():
                    continue
                    
                parts = line.split()
                if len(parts) < 9:
                    continue
                
                permissions = parts[0]
                size = parts[4]
                name = ' '.join(parts[8:])
                
                # Skip . and .. directories
                if name in ['.', '..']:
                    continue
                
                is_directory = permissions.startswith('d')
                
                files.append({
                    'name': name,
                    'type': 'directory' if is_directory else 'file',
                    'size': self.format_size(int(size)) if size.isdigit() else size
                })
            
            return files
        except:
            return []

    def format_size(self, size_bytes):
        """Format file size in human readable format"""
        if size_bytes == 0:
            return "0 B"
        
        size_names = ["B", "KB", "MB", "GB"]
        i = 0
        while size_bytes >= 1024 and i < len(size_names) - 1:
            size_bytes /= 1024.0
            i += 1
        
        return f"{size_bytes:.1f} {size_names[i]}"

    async def initialize_ssh_session(self):
        """Initialize persistent SSH session for file operations"""
        try:
            port = self.reverse_server.reverse_port
            server = f"{self.username}@reverse"
            
            # Create SSH process with persistent connection
            ssh_command = [
                'ssh', 
                '-p', str(port),
                '-o', 'ControlMaster=yes',
                '-o', 'ControlPath=/tmp/ssh_fm_%r@%h:%p',
                '-o', 'ControlPersist=600',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                '-o', 'LogLevel=ERROR',
                server,
                # Keep connection alive with a simple command
                'cat'
            ]
            
            self.ssh_process = await asyncio.create_subprocess_exec(
                *ssh_command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            logger.info(f"SSH session initialized for {server}:{port}")
            
        except Exception as e:
            logger.error(f"Failed to initialize SSH session: {e}")
            raise

    async def cleanup_ssh_session(self):
        """Clean up persistent SSH session"""
        if self.ssh_process:
            try:
                # Terminate the SSH process gracefully
                self.ssh_process.terminate()
                try:
                    await asyncio.wait_for(self.ssh_process.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    # Force kill if not terminated within 5 seconds
                    self.ssh_process.kill()
                    await self.ssh_process.wait()
                
                logger.info("SSH session cleaned up")
                
            except Exception as e:
                logger.error(f"Error cleaning up SSH session: {e}")
            finally:
                self.ssh_process = None

    async def execute_ssh_command_persistent(self, command):
        """Execute SSH command using persistent session"""
        if not self.ssh_process:
            raise Exception("SSH session not initialized")
            
        try:
            port = self.reverse_server.reverse_port
            server = f"{self.username}@reverse"
            
            # Use SSH multiplexing to reuse the connection
            ssh_exec_command = [
                'ssh',
                '-p', str(port),
                '-o', 'ControlPath=/tmp/ssh_fm_%r@%h:%p',
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                '-o', 'LogLevel=ERROR',
                server,
                command
            ]
            
            # Execute command using the persistent connection
            exec_process = await asyncio.create_subprocess_exec(
                *ssh_exec_command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE
            )
            
            # 加上逾時：遠端命令或網路卡住時，不讓這個 consumer 的 receive() 永久阻塞。
            # Timeout so a hung remote command / stalled network can't block this consumer's receive() forever.
            try:
                stdout, stderr = await asyncio.wait_for(exec_process.communicate(), timeout=30)
            except asyncio.TimeoutError:
                exec_process.kill()
                await exec_process.wait()
                logger.error("SSH command timed out after 30s")
                return ("", "Command timed out", 124)

            return (
                stdout.decode('utf-8', errors='replace'),
                stderr.decode('utf-8', errors='replace'),
                exec_process.returncode
            )
            
        except Exception as e:
            logger.error(f"Error executing SSH command: {e}")
            raise

    async def is_powershell_persistent(self):
        """Check if remote shell is PowerShell using persistent session"""
        try:
            # Try to execute a PowerShell-specific command
            stdout, stderr, returncode = await self.execute_ssh_command_persistent('Get-Host')
            return returncode == 0 and 'Name' in stdout
        except:
            return False

    # Reuse permission checking methods from TerminalConsumer
    @sync_to_async
    def check_permissions(self, user, server_id) -> bool:
        """Check if user has access to the tunnel"""
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=server_id)
            return TunnelPermissionManager.check_access(user, tunnel, TunnelPermission.VIEW)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return False

    @sync_to_async
    def check_username(self, server_id, username, user) -> bool:
        try:
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            logger.error(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist")
            return False

        from services.tunnel_permissions import TunnelPermissionService
        allowed_usernames = TunnelPermissionService.get_allowed_usernames(user, reverse_server)
        
        if not allowed_usernames.filter(username=username).exists():
            logger.error(f"Username [{username}] not in allowed list for user [{user}]")
            return False
            
        return True

    @sync_to_async
    def get_reverse_server_port(self, server_id, user) -> int:
        """Get reverse server port by server ID (checking ownership or sharing)"""
        try:
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
            return reverse_server.reverse_port
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        # Check if tunnel is shared with the user
        try:
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
            # Check if there's a sharing record for this user
            sharing_exists = TunnelSharing.objects.filter(
                tunnel=reverse_server,
                shared_with=user
            ).exists()
            if sharing_exists:
                return reverse_server.reverse_port
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        logger.error(f"ReverseServerAuthorizedKeys with id {server_id} does not exist for user {user}")
        return None

