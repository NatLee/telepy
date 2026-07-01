import os
import json
import asyncio
import pty
import signal
import fcntl
import termios
import struct
import base64
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

from common.ws_ticket import consume_ticket

import logging
logger = logging.getLogger(__name__)


def _parse_ws_subprotocols(scope):
    """
    解析 WebSocket subprotocols。/ Parse WebSocket subprotocols.
    - ticket：新版一次性身分票（首選）/ new one-time identity ticket (preferred)
    - token ：舊版 JWT（過渡相容，之後移除）/ legacy JWT (temporary fallback, remove later)
    - server_id / username / tunnel_id：非敏感的資源識別 / non-sensitive resource ids
    - echo：交握時要回選的 subprotocol（非敏感值）/ subprotocol to echo on accept (non-sensitive)
    """
    result = {'ticket': None, 'token': None, 'server_id': None, 'username': None, 'tunnel_id': None, 'echo': None}
    for protocol in scope.get('subprotocols') or []:
        if protocol.startswith('ticket.'):
            result['ticket'] = protocol.split('.', 1)[1]
            result['echo'] = protocol  # 已用掉的 ticket，可安全 echo / already consumed, safe to echo
        elif protocol.startswith('token.'):
            try:
                result['token'] = base64.b64decode(protocol.split('.', 1)[1]).decode()
            except Exception:
                pass
        elif protocol.startswith('server.'):
            result['server_id'] = protocol.split('.', 1)[1]
        elif protocol.startswith('username.'):
            result['username'] = protocol.split('.', 1)[1]
        elif protocol.startswith('tunnel.'):
            result['tunnel_id'] = protocol.split('.', 1)[1]
        elif protocol.startswith('auth.'):
            if result['echo'] is None:
                result['echo'] = protocol  # legacy echo subprotocol
    return result


@sync_to_async
def _consume_ticket_async(ticket):
    return consume_ticket(ticket)


async def _resolve_ws_user(ticket, token):
    """
    解析 WebSocket 身分：優先用一次性 ticket；為平滑升級，暫時仍相容舊的 JWT token。
    Resolve the WS user: prefer the one-time ticket; still accept the legacy JWT for zero-downtime
    migration. Returns (user, error_code); error_code is None on success, otherwise a WS close code.
    TODO: 前端全面改用 ticket 後移除 token 後援。/ Remove the token fallback once the frontend uses tickets everywhere.
    """
    if ticket:
        user_id = await _consume_ticket_async(ticket)
        if user_id is None:
            logger.error("WS ticket invalid or expired")
            return None, 4001
        try:
            return await sync_to_async(User.objects.get)(id=user_id), None
        except User.DoesNotExist:
            return None, 4001
    if token:
        try:
            access_token = AccessToken(token)
            return await sync_to_async(User.objects.get)(id=access_token['user_id']), None
        except (InvalidToken, TokenError) as e:
            logger.error(f"Token invalid: {e}")
            return None, 4001
        except User.DoesNotExist:
            return None, 4001
    return None, 4000


class TerminalConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.child_pid = None
        self.fd = None
        # 增量 UTF-8 解碼器：os.read 以 1024 bytes 為界，可能把多位元組字元（如中日韓）切半；
        # 增量解碼會把未完成的位元組保留到下一次，避免 UnicodeDecodeError 或亂碼。
        # Incremental UTF-8 decoder: a 1024-byte read can split a multibyte char (e.g. CJK) at the
        # boundary; the incremental decoder buffers the incomplete tail so we neither crash nor mojibake.
        self._output_decoder = codecs.getincrementaldecoder('utf-8')('replace')

    async def connect(self):
        logger.info("WebSocket connection attempt")
        info = _parse_ws_subprotocols(self.scope)
        subprotocol_auth = info['echo']  # 交握時回選的 subprotocol（非敏感）/ non-sensitive echo
        server_id = info['server_id']
        username = info['username']

        # 必要 subprotocol：身分（ticket 或舊版 token）+ server + username
        if not (info['ticket'] or info['token']) or not server_id or not username:
            logger.error("Missing required subprotocols")
            await self.close(code=4000)
            return

        # 解析身分：優先一次性 ticket，過渡期相容舊 JWT / prefer one-time ticket, legacy JWT fallback
        user, auth_error = await _resolve_ws_user(info['ticket'], info['token'])
        if auth_error is not None:
            await self.close(code=auth_error)
            return
        logger.info(f"User authenticated: {user}")

        # Check if user has access to the server
        has_permissions = await self.check_permissions(user, server_id)
        if not has_permissions:
            logger.error(f"User [{user}] does not have access to server [{server_id}]")
            await self.close(code=4004)
            return

        # Get reverse server port
        reverse_port = await self.get_reverse_server_port(server_id)

        # Check if reverse_port is valid
        if not reverse_port:
            logger.error(f"Invalid server ID: {server_id}")
            await self.close(code=4002)
            return

        # Check if any target server usernames exist (4006 = none configured)
        has_usernames = await self.has_target_server_usernames(server_id)
        if not has_usernames:
            logger.error(f"No target server usernames configured for server [{server_id}]")
            await self.close(code=4006)
            return

        # Check if username is valid
        if not await self.check_username(server_id, username, user):
            logger.error(f"Invalid username: {username}")
            await self.close(code=4003)
            return

        # Accept the WebSocket connection with the subprotocol token
        await self.accept(subprotocol_auth)
        logger.info("WebSocket connection accepted")

        # Start the SSH connection
        if self.child_pid is None:
            try:
                # Fork a child process
                self.child_pid, self.fd = pty.fork()
                if self.child_pid == 0:  # Child process
                    # Set TERM environment variable to xterm
                    os.environ['TERM'] = 'xterm'
                    # Execute the SSH command
                    os.execlp('bash', 'bash', '-c', f'ssh {username}@reverse -p {reverse_port}')
                else:  # Parent process
                    asyncio.get_event_loop().add_reader(self.fd, self.forward_output)
                logger.info("SSH connection started")
            except Exception as e:
                logger.error(f"Error starting SSH connection: {e}")
                await self.close(code=4005)
                return

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
            print(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist")
            return False

        from services.tunnel_permissions import TunnelPermissionService
        allowed_usernames = TunnelPermissionService.get_allowed_usernames(user, reverse_server)
        
        if not allowed_usernames.filter(username=username).exists():
            print(f"Username [{username}] not in allowed list for user [{user}]")
            return False
            
        return True

    @sync_to_async
    def has_target_server_usernames(self, server_id) -> bool:
        """Check if the server has any configured target server usernames"""
        try:
            reverser_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return False
        return ReverseServerUsernames.objects.filter(reverse_server=reverser_server).exists()

    @sync_to_async
    def get_reverse_server_port(self, server_id) -> int:
        # Check if the server_id is valid
        try:
            reverser_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            print(f"ReverseServerAuthorizedKeys with id {server_id} does not exist")
            return None
        return reverser_server.reverse_port


    async def disconnect(self, close_code):
        # Gracefully terminate the child process
        if self.child_pid:
            try:
                # First, try to terminate the process gently
                os.kill(self.child_pid, signal.SIGTERM)
                # Wait a brief period to allow for graceful shutdown
                await asyncio.sleep(0.5)
                # Forcefully kill if still alive
                os.kill(self.child_pid, signal.SIGKILL)
                os.waitpid(self.child_pid, 0)
            except ProcessLookupError:
                pass
            finally:
                # Ensure removal of reader happens before clearing fd
                if self.fd is not None:
                    asyncio.get_event_loop().remove_reader(self.fd)
                self.child_pid = None
                self.fd = None

    async def receive(self, text_data=None, bytes_data=None):
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

    def forward_output(self):
        try:
            data = os.read(self.fd, 1024)
            if len(data) == 0:
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
            # OSError can occur if the fd has been closed due to the process exiting
            asyncio.ensure_future(self.close())

class NotificationConsumer(AsyncWebsocketConsumer):
    async def connect(self):

        # Authenticate user via one-time ticket (preferred) or legacy JWT in subprotocols
        self.user = None

        info = _parse_ws_subprotocols(self.scope)
        subprotocol_auth = info['echo']  # 交握時回選的 subprotocol（非敏感）/ non-sensitive echo

        # 必要：身分（ticket 或舊版 token）
        if not (info['ticket'] or info['token']):
            logger.error("Missing required subprotocols")
            await self.close(code=4000)
            return

        user, auth_error = await _resolve_ws_user(info['ticket'], info['token'])
        if auth_error is not None:
            await self.close(code=auth_error)
            return
        self.user = user
        logger.info(f"User authenticated: {self.user}")


        # Join user-specific notification group
        self.user_group_name = f'user_{self.user.id}_notifications'
        await self.channel_layer.group_add(
            self.user_group_name,
            self.channel_name
        )

        await self.accept(subprotocol_auth)

    async def disconnect(self, close_code):
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

    async def receive(self, text_data=None, bytes_data=None):
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

        logger.info(f"Sending notification to user {self.user}: {action}")

        # Send message to WebSocket (no permission check needed since notifications are targeted)
        await self.send(text_data=json.dumps({
            'message': message
        }))
        logger.info(f"Notification sent to user {self.user}: {action}")


def send_notification_to_user(user_id: int, message: dict):
    """
    Send notification to a specific user.
    """
    logger.info(f"Sending notification to user {user_id}: {message.get('action')}")
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
        logger.info(f"Notification sent to user {user_id}: {message.get('action')}")
    except Exception as e:
        logger.error(f"Failed to send notification to user {user_id}: {e}")


def send_notification_to_users(user_ids: list[int], message: dict):
    """
    Send notification to multiple specific users.
    """
    for user_id in user_ids:
        send_notification_to_user(user_id, message)



class TunnelConnectionConsumer(AsyncWebsocketConsumer):
    """
    WebSocket consumer for monitoring tunnel connection status during creation.
    Requires JWT via subprotocols similar to TerminalConsumer.
    """
    async def connect(self):
        logger.info("TunnelConnection WebSocket connection attempt")
        # Parse subprotocols: ticket.<ticket> (preferred) or token.<base64(jwt)> (legacy), tunnel.<id>
        info = _parse_ws_subprotocols(self.scope)
        subprotocol_auth = info['echo']  # 交握時回選的 subprotocol（非敏感）/ non-sensitive echo
        tunnel_id = info['tunnel_id']

        # Fallback to URL param if not provided via subprotocol (shouldn't happen)
        if not tunnel_id:
            tunnel_id = self.scope['url_route']['kwargs'].get('tunnel_id')

        if not (info['ticket'] or info['token']) or not tunnel_id:
            logger.error("[TunnelConnection] Missing required subprotocols (ticket/token + tunnel)")
            await self.close(code=4000)
            return

        self.tunnel_id = str(tunnel_id)
        self.room_group_name = f'tunnel_connection_{self.tunnel_id}'

        # 解析身分：優先一次性 ticket，過渡期相容舊 JWT / prefer one-time ticket, legacy JWT fallback
        user, auth_error = await _resolve_ws_user(info['ticket'], info['token'])
        if auth_error is not None:
            await self.close(code=auth_error)
            return
        logger.info(f"[TunnelConnection] User authenticated: {user}")

        # Ensure the tunnel belongs to the user
        has_permissions = await self._check_tunnel_permission(user, self.tunnel_id)
        if not has_permissions:
            logger.error(f"[TunnelConnection] User [{user}] has no access to tunnel [{self.tunnel_id}]")
            await self.close(code=4004)
            return

        # Join room and accept
        await self.channel_layer.group_add(self.room_group_name, self.channel_name)
        await self.accept(subprotocol_auth)

        # Send initial connection status
        await self.send_connection_status()

    async def disconnect(self, close_code):
        # Leave room group
        if hasattr(self, 'room_group_name'):
            await self.channel_layer.group_discard(
                self.room_group_name,
                self.channel_name
            )

    async def receive(self, text_data=None, bytes_data=None):
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

            await self.send(text_data=json.dumps({
                'type': 'connection_status',
                'tunnel_id': int(self.tunnel_id),
                'reverse_port': reverse_port,
                'is_connected': is_connected,
                'host_friendly_name': reverse_server.host_friendly_name
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

class FileManagerConsumer(AsyncWebsocketConsumer):
    """
    WebSocket Consumer for file management operations
    Handles file listing, upload, and download operations via WebSocket
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

    async def connect(self):
        logger.info("FileManager WebSocket connection attempt")
        # Parse subprotocols: ticket.<ticket> (preferred) or token.<base64(jwt)> (legacy), server.<id>, username.<name>
        info = _parse_ws_subprotocols(self.scope)
        subprotocol_auth = info['echo']  # 交握時回選的 subprotocol（非敏感）/ non-sensitive echo
        server_id = info['server_id']
        username = info['username']

        if not (info['ticket'] or info['token']) or not server_id or not username:
            logger.error("Missing required subprotocols")
            await self.close(code=4000)
            return

        # 解析身分：優先一次性 ticket，過渡期相容舊 JWT / prefer one-time ticket, legacy JWT fallback
        user, auth_error = await _resolve_ws_user(info['ticket'], info['token'])
        if auth_error is not None:
            await self.close(code=auth_error)
            return
        logger.info(f"FileManager User authenticated: {user}")

        # Check if user has access to the server
        has_permissions = await self.check_permissions(user, server_id)
        if not has_permissions:
            logger.error(f"User [{user}] does not have access to server [{server_id}]")
            await self.close(code=4004)
            return

        # Get reverse server port (to validate server ID)
        reverse_port = await self.get_reverse_server_port(server_id, user)
        if not reverse_port:
            logger.error(f"Invalid server ID: {server_id}")
            await self.close(code=4002)
            return

        # Check if any target server usernames exist (4006 = none configured)
        has_usernames = await sync_to_async(
            lambda: ReverseServerUsernames.objects.filter(reverse_server_id=server_id).exists()
        )()
        if not has_usernames:
            logger.error(f"No target server usernames configured for server [{server_id}]")
            await self.close(code=4006)
            return

        # Check if username is valid
        if not await self.check_username(server_id, username, user):
            logger.error(f"Invalid username: {username}")
            await self.close(code=4003)
            return

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
                    await self.close(code=4004)
                    return
            except ReverseServerAuthorizedKeys.DoesNotExist:
                logger.error(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist")
                await self.close(code=4004)
                return

        # Accept the WebSocket connection
        await self.accept(subprotocol_auth)
        
        # Initialize persistent SSH session
        try:
            await self.initialize_ssh_session()
            logger.info("FileManager WebSocket connection accepted with persistent SSH session")
        except Exception as e:
            logger.error(f"Failed to initialize SSH session: {e}")
            # 清掉可能已 spawn 的 ControlMaster 'cat' 子程序，避免失敗連線累積殭屍 SSH。
            # Clean up the ControlMaster 'cat' subprocess that may already be running so failed
            # connects don't accumulate orphaned SSH processes.
            await self.cleanup_ssh_session()
            await self.close(code=4005)
            return

    async def disconnect(self, close_code):
        logger.info(f"FileManager WebSocket disconnected with code: {close_code}")
        
        # Clean up SSH session
        await self.cleanup_ssh_session()

    async def receive(self, text_data=None, bytes_data=None):
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

