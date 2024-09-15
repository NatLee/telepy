import os
import json
import asyncio
import pty
import signal
import fcntl
import termios
import struct
import base64

from asgiref.sync import sync_to_async
from asgiref.sync import async_to_sync

from django.contrib.auth.models import User

from rest_framework_simplejwt.tokens import AccessToken
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError

from channels.layers import get_channel_layer
from channels.generic.websocket import AsyncWebsocketConsumer

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames

import logging
logger = logging.getLogger(__name__)

class TerminalConsumer(AsyncWebsocketConsumer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.child_pid = None
        self.fd = None

    async def connect(self):
        logger.info("WebSocket connection attempt")
        subprotocol_auth = None
        token = None
        server_id = None
        username = None

        # Check for subprotocols
        if self.scope['subprotocols']:
            try:
                for protocol in self.scope['subprotocols']:
                    if protocol.startswith('token.'):
                        # Extract token from subprotocol
                        base64_encoded_token = protocol.split('.', 1)[1]
                        # Decode token
                        token = base64.b64decode(base64_encoded_token).decode()
                    elif protocol.startswith('server.'):
                        # Extract server_id from subprotocol
                        server_id = protocol.split('.', 1)[1]
                    elif protocol.startswith('username.'):
                        # Extract username from subprotocol
                        username = protocol.split('.', 1)[1]
                    elif protocol.startswith('auth.'):
                        # Use the `auth` ticket as the subprotocol
                        subprotocol_auth = protocol
            except Exception as e:
                logger.error(f"Error parsing subprotocols: {e}")
                await self.close(code=4000)
                return
            if not token or not server_id or not username or not subprotocol_auth:
                logger.error("Missing required subprotocols")
                await self.close(code=4000)
                return
        else:
            logger.error("No subprotocols provided")
            await self.close(code=4000)
            return

        # Verify JWT token
        try:
            access_token = AccessToken(token)
            user = await sync_to_async(User.objects.get)(id=access_token['user_id'])
            logger.info(f"User authenticated: {user}")

            # Check if user has access to the server
            has_permissions = await self.check_permissions(user, server_id)
            if not has_permissions:
                logger.error(f"User [{user}] does not have access to server [{server_id}]")
                await self.close(code=4004)
                return
        except (InvalidToken, TokenError) as e:
            logger.error(f"Token invalid: {e}")
            await self.close(code=4001)
            return
        except User.DoesNotExist:
            logger.error("User not found")
            await self.close(code=4001)
            return

        # Get reverse server port
        reverse_port = await self.get_reverse_server_port(server_id)

        # Check if reverse_port is valid
        if not reverse_port:
            logger.error(f"Invalid server ID: {server_id}")
            await self.close(code=4002)
            return

        # Check if username is valid
        if not await self.check_username(server_id, username):
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
        # Check if the user has access to the server
        try:
            ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            print(f"User [{user}] does not have access to server [{server_id}]")
            return False
        return True

    @sync_to_async
    def check_username(self, server_id, username) -> bool:
        # Check if the username is valid
        try:
            reverser_server = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            print(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist")
            return False
        try:
            reverser_server_username = ReverseServerUsernames.objects.get(reverse_server=reverser_server, username=username)
        except ReverseServerUsernames.DoesNotExist:
            print(f"ReverseServerUsernames with username [{username}] does not exist")
            return False
        return True

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
        if text_data:
            data = json.loads(text_data)
            action = data.get('action')
            payload = data.get('payload')

            # Handle pty_input action
            if action == 'pty_input' and self.fd:
                os.write(self.fd, payload['input'].encode())

            # Handle resize action
            if action == 'pty_resize' and self.fd:
                # Resize the pty
                pty_size = payload['size']
                # Frontend sends size as dict with keys: rows, cols, height, width
                # Convert to struct with keys: rows, cols, x, y
                pty_size_bytes = struct.pack('HHHH', pty_size['rows'], pty_size['cols'], pty_size['height'], pty_size['width'])
                fcntl.ioctl(self.fd, termios.TIOCSWINSZ, pty_size_bytes)

    def forward_output(self):
        try:
            output = os.read(self.fd, 1024).decode()
            if len(output) == 0:
                # EOF received, meaning the shell has been exited
                asyncio.ensure_future(self.close())
            else:
                asyncio.ensure_future(self.send(text_data=output))
        except OSError:
            # OSError can occur if the fd has been closed due to the process exiting
            asyncio.ensure_future(self.close())

class NotificationConsumer(AsyncWebsocketConsumer):
    async def connect(self):
        self.room_name = 'notifications'  # Can be dynamic based on path
        self.room_group_name = f'group_{self.room_name}'

        # Join room group
        await self.channel_layer.group_add(
            self.room_group_name,
            self.channel_name
        )

        await self.accept()

    async def disconnect(self, close_code):
        # Leave room group
        await self.channel_layer.group_discard(
            self.room_group_name,
            self.channel_name
        )

    # Receive message from room group
    async def send_notification(self, event):
        message = event['message']

        # Send message to WebSocket
        await self.send(text_data=json.dumps({
            'message': message
        }))

def send_notification_to_group(message:dict):
    channel_layer = get_channel_layer()
    async_to_sync(channel_layer.group_send)(
        'group_notifications',  # Must match the group name used in your consumer
        {
            'type': 'send_notification',
            'message': message
        }
    )

