import os
import ssl
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
        self._auth_in_progress = False
        # 是否已對底層送過 websocket.close（或對方已斷）。所有關閉一律走 _safe_close()，
        # 避免「close 之後再 close/send」造成 uvicorn RuntimeError（Unexpected ASGI message）。
        # Whether websocket.close was already sent (or the peer is gone). All closes go through
        # _safe_close() so a second close/send can't raise uvicorn's "Unexpected ASGI message".
        self._ws_closed = False
        self._auth_timeout_task = None
        await self.accept()
        self._auth_timeout_task = asyncio.create_task(self._await_auth_timeout())

    async def _safe_close(self, code=None):
        """冪等關閉：重複呼叫或對已死 socket 關閉都不再丟例外。/ Idempotent, race-safe close."""
        if self._ws_closed:
            return
        self._ws_closed = True
        try:
            if code is not None:
                await self.close(code=code)
            else:
                await self.close()
        except RuntimeError:
            # 對方已斷 / 已送過 close（例如逾時計時器和使用者關閉互相競速）。
            # Peer already gone / close already sent (e.g. timer racing a client-initiated close).
            pass

    def _cancel_auth_timer(self):
        if self._auth_timeout_task is not None:
            self._auth_timeout_task.cancel()
            self._auth_timeout_task = None

    async def _await_auth_timeout(self):
        try:
            await asyncio.sleep(WS_AUTH_TIMEOUT)
            if self._authed or self._ws_closed:
                return
            # auth 訊息已到、正在做 DB 權限檢查（可能因負載暫時變慢）：再寬限一輪，不要
            # 誤殺「正常但較慢」的認證中連線。/ If an auth frame IS being processed (e.g. DB
            # briefly slow under load), grant one grace period instead of killing a valid login.
            if self._auth_in_progress:
                await asyncio.sleep(WS_AUTH_TIMEOUT)
                if self._authed or self._ws_closed:
                    return
        except asyncio.CancelledError:
            return
        logger.warning(f"{type(self).__name__}: no auth within timeout, closing")
        await self._safe_close(code=4001)

    async def receive(self, text_data=None, bytes_data=None):
        # 尚未認證：只接受第一則 auth 訊息，其餘一律拒絕。
        # Not yet authenticated: only the first auth frame is accepted; everything else is rejected.
        if not getattr(self, '_authed', False):
            await self._authenticate(text_data)
            return
        # 例外防火牆：handler 內任何未捕捉例外若往外冒，channels 會直接终結 consumer 而
        # 「不呼叫 disconnect()」——PTY reader / 子行程 / group 成員資格全部變孤兒（實錄：一個
        # 孤兒 reader 以每分鐘 120 筆錯誤連噴 2.5 小時）。這裡吞下並記錄，資源清理交給正常斷線流程。
        # Exception firewall: an exception escaping a handler makes Channels kill the consumer
        # WITHOUT calling disconnect(), orphaning the PTY reader / child / group membership
        # (observed: one orphaned reader spamming 120 errors/min for 2.5h). Log and contain.
        try:
            await self.on_message(text_data=text_data, bytes_data=bytes_data)
        except Exception:
            logger.exception(f"{type(self).__name__}: unhandled error in on_message; frame dropped")

    async def _authenticate(self, text_data):
        self._auth_in_progress = True
        auth_started = asyncio.get_event_loop().time()
        try:
            data = _parse_json(text_data)
            if not isinstance(data, dict) or data.get('type') != 'auth':
                self._cancel_auth_timer()
                await self._safe_close(code=4000)
                return
            user, err = await _authenticate_token(data.get('token'))
            if err is not None:
                self._cancel_auth_timer()
                await self._safe_close(code=err)
                return
            # after_auth 的例外絕不可往外冒（channels 會跳過 disconnect → 資源孤兒化）。
            # 失敗時主動走 disconnect() 清理（各 consumer 的 disconnect 均為冪等）再關閉。
            # Never let after_auth exceptions escape (Channels would skip disconnect). On failure,
            # run the idempotent disconnect() cleanup ourselves, then close.
            try:
                err = await self.after_auth(user, data)
            except Exception:
                logger.exception(f"{type(self).__name__}: after_auth crashed")
                self._cancel_auth_timer()
                # 先送 close frame，再做清理——disconnect() 會把 _ws_closed 設為 True，
                # 順序顛倒會讓 _safe_close 變 no-op、socket 留在半開狀態。
                # Close FIRST: disconnect() marks _ws_closed, which would turn a later
                # _safe_close into a no-op and leave the socket half-open.
                await self._safe_close(code=4005)
                try:
                    await self.disconnect(4005)
                except Exception:
                    logger.exception(f"{type(self).__name__}: cleanup after failed auth crashed")
                return
            if err is not None:
                self._cancel_auth_timer()
                await self._safe_close(code=err)
                return
            self._authed = True
            self._cancel_auth_timer()
            # 認證耗時儀表：>3s 即警告（含 DB 檢查與資源建立）。這是先前「auth 超過 10s 被計時器
            # 誤殺」事故的預警指標。/ Slow-auth telemetry: warn above 3s — the early-warning metric
            # for the "auth exceeded the 10s timer" incident class.
            elapsed = asyncio.get_event_loop().time() - auth_started
            if elapsed > 3:
                logger.warning(f"{type(self).__name__}: slow auth took {elapsed:.1f}s (DB/thread-pool congestion?)")
        finally:
            # 任一路徑（含拒絕）都要取消計時器與清旗標——舊版失敗時不取消，計時器 10 秒後
            # 對「已關閉」的 socket 再補一刀 close(4001)，噴出 Task exception was never retrieved。
            # Every path must cancel the timer: the old code left it running after a failed auth,
            # so it fired close(4001) on an already-closed socket 10s later (the logged RuntimeError).
            self._auth_in_progress = False

    async def disconnect(self, close_code):
        self._ws_closed = True  # 底層已斷，之後任何 close/send 都不得再送 / transport is gone
        self._cancel_auth_timer()

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
                    # PTY master 設為 non-blocking：os.write 在緩衝區滿時（遠端停止讀取，如網路
                    # 卡住）會丟 BlockingIOError 而非「阻塞整個 event loop」。若 loop 被 blocking
                    # write 卡住 >20s，uvicorn 的 WS keepalive 全數逾時，該 worker 上所有連線會
                    # 一起被斷 —— 這是「不明斷線」的典型來源之一。
                    # Make the PTY master non-blocking: a full buffer (remote stopped reading)
                    # raises BlockingIOError instead of blocking the event loop. A loop blocked
                    # >20s makes uvicorn's WS keepalives time out and drops EVERY socket on the
                    # worker — a classic source of "random" disconnects.
                    os.set_blocking(self.fd, False)
                    asyncio.get_event_loop().add_reader(self.fd, self.forward_output)
                    self._session_started = asyncio.get_event_loop().time()
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
        # 斷線觀測：關閉碼 + session 存活時間。固定週期的 lifetime（如恆為 ~60s）即代理層逾時、
        # 大量同秒斷線代表 worker 死亡，一眼可判。/ Close telemetry: a constant lifetime (~60s)
        # fingerprints a proxy timeout; many same-second closes fingerprint a worker death.
        started = getattr(self, '_session_started', None)
        if started is not None:
            lived = asyncio.get_event_loop().time() - started
            logger.info(f"Terminal session closed: code={close_code}, lived={lived:.1f}s")
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
            try:
                await self.send(bytes_data=b'pong')
            except RuntimeError:
                pass  # socket 剛好關閉 / socket just closed
            return

        payload = data.get('payload')
        if not isinstance(payload, dict):
            return

        try:
            # Handle pty_input action
            if action == 'pty_input' and self.fd and 'input' in payload:
                # non-blocking 寫入：緩衝區滿就丟棄剩餘輸入並記錄，絕不阻塞 event loop。
                # Non-blocking write: drop the remainder (and log) if the buffer is full.
                buf = payload['input'].encode()
                while buf:
                    try:
                        written = os.write(self.fd, buf)
                        buf = buf[written:]
                    except BlockingIOError:
                        logger.warning("PTY buffer full; dropping remaining terminal input")
                        break

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

    async def _send_pty_output(self, output: str):
        """
        送 PTY 輸出到 WS；socket 已關閉就靜默丟棄。/ Send PTY output; drop silently if the socket died.
        PTY 輸出與關閉本質上是並行事件：使用者關頁的瞬間，剛排程好的輸出 task 仍會執行，
        舊版直接 self.send 會噴 RuntimeError: Unexpected ASGI message 'websocket.send'。
        Output and close race by nature: a scheduled send may run right after the client left.
        """
        if self._ws_closed:
            return
        try:
            await self.send(text_data=output)
        except RuntimeError:
            self._stop_forwarding()

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
                asyncio.ensure_future(self._safe_close())
                return
            output = self._output_decoder.decode(data)
            if output:
                asyncio.ensure_future(self._send_pty_output(output))
        except BlockingIOError:
            # non-blocking fd：偶發的「可讀通知但無資料」，下次再讀。/ Spurious readability; retry later.
            return
        except OSError:
            # OSError can occur if the fd has been closed due to the process exiting.
            # 立即移除 reader 再排程 close，阻止忙迴圈（見 _stop_forwarding）。
            self._stop_forwarding()
            asyncio.ensure_future(self._safe_close())

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
        # group_send 與斷線天生會競速：斷線後 group_discard 前的廣播仍可能派到本 consumer。
        # A group broadcast can race the disconnect (before group_discard lands); drop it quietly.
        if getattr(self, '_ws_closed', False):
            return
        try:
            await self.send(text_data=json.dumps({
                'message': message
            }))
        except RuntimeError:
            return
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


# --- Remote browser: VNC bridge (KasmVNC over the existing /ws) --------------
class RemoteBrowserConsumer(FirstMessageAuthConsumer):
    """
    把 kasm-browser 內某個 KasmVNC session 的 **WebSocket**(KasmVNC 的 web-native 傳輸)透明
    中繼到既有 /ws。KasmVNC 已脫離 RFB 規範、只開 websocket、且用它自家 fork 的 web client
    (一般 noVNC 連不上),因此上游改成 WS client、前端改用 KasmVNC 的 client(見 docs/plans 修正版計畫)。

    - 沿用 FirstMessageAuthConsumer(首則訊息帶 JWT)。after_auth 內用 session 的 server_id
      **再次**重驗 tunnel 權限(不只驗身分),再連到 kasm-browser:<ws_port> 的 websocket。
    - 認證後本 consumer 只做「訊息雙向轉發」:client 的二進位 frame → 上游 ws;上游 ws 的訊息 →
      client frame。KasmVNC 協定本身由前端 KasmVNC client 與 server 端到端處理,後端不需理解 ——
      WS↔WS 比 raw-TCP 更乾淨:WebSocket 本就有訊息邊界,逐訊息轉發即可,無需自訂 chunk。
    - 斷線即結束整個 session(收 ssh + kasm),idle GC 當後備;上游 ws 關閉也即刻收 session。

    握手順序(重要,沿用不變):VNC 是「server 先說話」。若一連上上游就把 greeting 送給 client,而
    前端 client 還沒接上,greeting 會漏掉、handshake 壞掉。故:after_auth 連上上游 ws 後只送一則
    text {"type":"ready"};前端收到後把「已認證的同一條 WS」交給 KasmVNC client,再回一則 text
    {"type":"begin"};consumer 收到 begin 才開始 pump 上游→client。client→上游 方向不需等 begin。
    """
    KASM_HOST = os.getenv("KASM_BROWSER_HOST", "kasm-browser")
    # KasmVNC 的 websocket scheme / path / subprotocol。實測(見 docs/plans §4b):Xkasmvnc 的
    # -sslOnly 預設關 → 內網是**純 ws**;websocket 端點是 **/websockify**;且 KasmVNC 的 web 層
    # **預設要 HTTP Basic Auth**(我們的 -disableBasicAuth 在此 build 沒生效)→ consumer 帶帳密連。
    # scheme/path 仍會「自動退回」嘗試其他組合(見 _connect_upstream),env 只是「優先嘗試」提示。
    KASM_WS_PATH = os.getenv("KASM_WS_PATH", "/websockify")
    KASM_WS_SCHEME = os.getenv("KASM_WS_SCHEME", "ws")    # ws(預設,實測純 ws)| wss(自簽不驗證)
    KASM_WS_SUBPROTOCOL = os.getenv("KASM_WS_SUBPROTOCOL", "binary")
    # KasmVNC web 層 Basic Auth 帳密(對應 kasm-browser image 內 kasmvncpasswd 建的使用者)。
    # 設 KASM_WS_USER="" 可停用(若某 build 的 -disableBasicAuth 真的生效)。
    KASM_WS_USER = os.getenv("KASM_WS_USER", "telepy")
    KASM_WS_PASSWORD = os.getenv("KASM_WS_PASSWORD", "telepyvnc")
    # 自動退回時嘗試的候選(env 指定的排最前)。
    _WS_PATH_CANDIDATES = ["/websockify", "/", "/api/vnc", "/websocket"]
    _WS_SCHEME_CANDIDATES = ["ws", "wss"]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.rb_session_id = None
        self._upstream = None        # websockets client connection (KasmVNC 的 ws)
        self._pump_task = None
        self._begun = False
        self._send_lock = asyncio.Lock()   # 序列化對 client 的送出(pump 與控制訊息競速保護)

    async def after_auth(self, user, message):
        from authorized_keys.remote_browser_service import get_session
        sid = self.scope.get("url_route", {}).get("kwargs", {}).get("session_id")
        self.rb_session_id = sid
        session = await sync_to_async(get_session)(sid)
        if not session or not session.get("ws_port"):
            logger.warning(f"remote-browser(vnc): unknown/incomplete session {sid}")
            return 4404
        if not await self._verify_access(user, session.get("server_id")):
            logger.warning(f"remote-browser(vnc): access denied user={user} "
                           f"server={session.get('server_id')}")
            return 4403
        ws_port = int(session["ws_port"])
        try:
            self._upstream, url = await self._connect_upstream(ws_port)
        except Exception as e:
            logger.error(f"remote-browser(vnc): cannot connect upstream ws for session {sid} "
                         f"(port {ws_port}); last error: {e!r}")
            return 4011
        # 通知前端:已認證 + 上游 ws 已接上,可以把 socket 交給 KasmVNC client 了。
        await self.send(text_data=json.dumps({"type": "ready"}))
        self._session_started = asyncio.get_event_loop().time()
        logger.info(f"remote-browser(vnc): bridged session {sid} -> {url}")
        return None

    def _upstream_candidates(self, ws_port):
        """(scheme, path) 候選;env 指定的排最前,其餘去重補上,讓上游連線自動退回試錯。"""
        schemes = [self.KASM_WS_SCHEME] + [s for s in self._WS_SCHEME_CANDIDATES
                                           if s != self.KASM_WS_SCHEME]
        paths = [self.KASM_WS_PATH] + [p for p in self._WS_PATH_CANDIDATES
                                       if p != self.KASM_WS_PATH]
        for scheme in schemes:
            for path in paths:
                yield f"{scheme}://{self.KASM_HOST}:{ws_port}{path}"

    async def _connect_upstream(self, ws_port):
        """
        連上 KasmVNC 的 websocket,回 (connection, url)。KasmVNC 的 TLS(wss vs ws)與 ws path 依
        build/設定而異,故**逐一嘗試候選組合**(env 指定的優先);任一成功即回,全失敗才丟最後的例外。
        失敗多半很快(TLS 埠收到明文即關、錯 path 回 404),open_timeout 只防病態情況。
        """
        last_exc = None
        for url in self._upstream_candidates(ws_port):
            try:
                conn = await self._ws_connect(url)
                logger.info(f"remote-browser(vnc): upstream connected {url}")
                return conn, url
            except Exception as e:
                last_exc = e
                logger.debug(f"remote-browser(vnc): upstream candidate failed {url}: {e!r}")
        raise last_exc or RuntimeError("no upstream websocket candidate connected")

    def _auth_headers(self):
        """KasmVNC web 層的 HTTP Basic Auth header(伺服器端 WS client 可帶,iframe 不行)。
        KASM_WS_USER 為空 → 不帶(供 -disableBasicAuth 真的生效的 build)。"""
        user = self.KASM_WS_USER
        if not user:
            return None
        import base64
        token = base64.b64encode(f"{user}:{self.KASM_WS_PASSWORD}".encode()).decode()
        return {"Authorization": f"Basic {token}"}

    async def _ws_connect(self, url):
        """
        對單一 url 開 websocket。max_size=None(VNC 幀大)、ping_interval=None(不與 KasmVNC 心跳互踩)、
        subprotocol=binary、Basic Auth header、wss 時給不驗證的 ssl context(內網自簽)。
        websockets 延遲匯入:未安裝只影響 remote-browser,不拖垮整個 consumers(含 terminal)。
        """
        import websockets
        kwargs = dict(max_size=None, ping_interval=None, open_timeout=8, close_timeout=5)
        if self.KASM_WS_SUBPROTOCOL:
            kwargs["subprotocols"] = [self.KASM_WS_SUBPROTOCOL]
        if url.startswith("wss://"):
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            kwargs["ssl"] = ctx
        headers = self._auth_headers()
        if not headers:
            return await websockets.connect(url, **kwargs)
        # websockets 13+(新 asyncio client)用 additional_headers;<=12(legacy)用 extra_headers。
        try:
            return await websockets.connect(url, additional_headers=headers, **kwargs)
        except TypeError:
            return await websockets.connect(url, extra_headers=headers, **kwargs)

    @sync_to_async
    def _verify_access(self, user, server_id):
        if server_id is None:
            return False
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return False
        return bool(TunnelPermissionManager.check_access(user, tunnel, TunnelPermission.VIEW))

    async def _client_send(self, **kwargs):
        """對 client 送出一律走這裡並上鎖,避免 pump 與控制訊息並發送出交錯。"""
        async with self._send_lock:
            await self.send(**kwargs)

    async def _pump_upstream_to_client(self):
        """上游 KasmVNC ws → client。逐訊息轉發(保留邊界);上游關閉/錯誤即關掉前端 WS。"""
        try:
            async for msg in self._upstream:
                if isinstance(msg, (bytes, bytearray)):
                    await self._client_send(bytes_data=bytes(msg))
                else:
                    await self._client_send(text_data=msg)
        except Exception:
            pass
        finally:
            await self._safe_close(code=4013)

    async def on_message(self, text_data=None, bytes_data=None):
        # 控制訊息(text):前端接上 KasmVNC client 後送 {"type":"begin"} 才開始 上游→client 串流。
        if text_data:
            data = _parse_json(text_data)
            if isinstance(data, dict) and data.get("type") == "begin" and not self._begun:
                self._begun = True
                self._pump_task = asyncio.create_task(self._pump_upstream_to_client())
            return
        # 資料訊息(binary):client 的位元組 → 上游 KasmVNC ws(逐訊息,保留 WS 邊界)。
        if bytes_data and self._upstream is not None:
            try:
                await self._upstream.send(bytes_data)
            except Exception:
                await self._safe_close(code=4013)

    async def disconnect(self, close_code):
        await super().disconnect(close_code)   # 取消 auth 逾時計時器 / cancel auth timer
        if self._pump_task is not None:
            self._pump_task.cancel()
            self._pump_task = None
        if self._upstream is not None:
            try:
                await self._upstream.close()
            except Exception:
                pass
            self._upstream = None
        # WS 一斷即結束整個 session(收 ssh + kasm session);idle GC 當後備。
        sid = self.rb_session_id
        self.rb_session_id = None
        if sid:
            try:
                from authorized_keys.remote_browser_service import stop_remote_browser
                await sync_to_async(stop_remote_browser)(sid)
            except Exception:
                logger.exception(f"remote-browser(vnc): stop_remote_browser failed for {sid}")
