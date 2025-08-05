import os
import json
import asyncio
import pty
import signal
import fcntl
import termios
import struct
import base64
import subprocess
import tempfile
from pathlib import Path

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

    async def connect(self):
        logger.info("FileManager WebSocket connection attempt")
        subprotocol_auth = None
        token = None
        server_id = None
        username = None

        # Check for subprotocols (same authentication as TerminalConsumer)
        if self.scope['subprotocols']:
            try:
                for protocol in self.scope['subprotocols']:
                    if protocol.startswith('token.'):
                        base64_encoded_token = protocol.split('.', 1)[1]
                        token = base64.b64decode(base64_encoded_token).decode()
                    elif protocol.startswith('server.'):
                        server_id = protocol.split('.', 1)[1]
                    elif protocol.startswith('username.'):
                        username = protocol.split('.', 1)[1]
                    elif protocol.startswith('auth.'):
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
            logger.info(f"FileManager User authenticated: {user}")

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

        # Get reverse server port (to validate server ID)
        reverse_port = await self.get_reverse_server_port(server_id, user)
        if not reverse_port:
            logger.error(f"Invalid server ID: {server_id}")
            await self.close(code=4002)
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
        self.reverse_server = await sync_to_async(
            lambda: ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        )()

        # Accept the WebSocket connection
        await self.accept(subprotocol_auth)
        logger.info("FileManager WebSocket connection accepted")

    async def disconnect(self, close_code):
        logger.info(f"FileManager WebSocket disconnected with code: {close_code}")

    async def receive(self, text_data=None, bytes_data=None):
        """Handle incoming WebSocket messages for file operations"""
        if not text_data:
            return

        try:
            data = json.loads(text_data)
            action = data.get('action')
            payload = data.get('payload', {})

            if action == 'list_files':
                await self.handle_list_files(payload)
            elif action == 'upload_file':
                await self.handle_upload_file(payload)
            elif action == 'download_file':
                await self.handle_download_file(payload)
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
            port = self.reverse_server.reverse_port
            server = f"{self.username}@reverse"
            
            # Check if it's PowerShell or Unix
            is_ps = await sync_to_async(self.is_powershell)(server, port)
            
            if is_ps:
                path = payload.get('path', 'C:\\')
                command = f"""'Get-ChildItem -Path "{path}" | Select-Object Mode, LastWriteTime, Length, Name | ConvertTo-Json'"""
            else:
                command = f"'ls -la {path}'"

            # Execute command asynchronously
            stdout, stderr, returncode = await sync_to_async(self.execute_ssh_command)(server, port, command)
            
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
            port = self.reverse_server.reverse_port
            server = f"{self.username}@reverse"
            
            is_ps = await sync_to_async(self.is_powershell)(server, port)
            shell_type = 'powershell' if is_ps else 'unix'
            
            await self.send_response('shell_detect', {
                'status': 'success',
                'shell': shell_type
            })

        except Exception as e:
            logger.error(f"Error detecting shell: {e}")
            await self.send_error(f"Failed to detect shell: {str(e)}")

    async def handle_upload_file(self, payload):
        """Handle file upload requests - returns upload instructions"""
        try:
            destination_path = payload.get('destination_path')
            if not destination_path:
                await self.send_error("Destination path required for upload")
                return

            # For WebSocket, we'll provide upload instructions rather than handling the actual file
            # The frontend will use a traditional form upload but with WebSocket feedback
            upload_url = f"/api/sftp/upload/{self.server_id}/{self.username}?destination_path={destination_path}"
            
            await self.send_response('upload_file', {
                'status': 'success',
                'upload_url': upload_url,
                'message': 'Use the provided URL for file upload'
            })

        except Exception as e:
            logger.error(f"Error preparing upload: {e}")
            await self.send_error(f"Failed to prepare upload: {str(e)}")

    async def handle_download_file(self, payload):
        """Handle file download requests - returns download URL"""
        try:
            path = payload.get('path')
            if not path:
                await self.send_error("File path required for download")
                return

            # Provide download URL for the frontend to use
            download_url = f"/api/sftp/download/{self.server_id}/{self.username}?path={path}"
            
            await self.send_response('download_file', {
                'status': 'success',
                'download_url': download_url,
                'message': 'Use the provided URL for file download'
            })

        except Exception as e:
            logger.error(f"Error preparing download: {e}")
            await self.send_error(f"Failed to prepare download: {str(e)}")

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

    # Reuse permission checking methods from TerminalConsumer
    @sync_to_async
    def check_permissions(self, user, server_id) -> bool:
        """Check if user has permissions for the server"""
        try:
            ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            logger.error(f"User [{user}] does not have access to server [{server_id}]")
            return False
        return True

    @sync_to_async
    def check_username(self, server_id, username, user) -> bool:
        """Check if username exists for the server"""
        try:
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            logger.error(f"ReverseServerAuthorizedKeys with id [{server_id}] does not exist for user {user}")
            return False
        try:
            ReverseServerUsernames.objects.get(reverse_server=reverse_server, username=username, user=user)
        except ReverseServerUsernames.DoesNotExist:
            logger.error(f"ReverseServerUsernames with username [{username}] does not exist for user {user}")
            return False
        return True

    @sync_to_async
    def get_reverse_server_port(self, server_id, user) -> int:
        """Get reverse server port by server ID"""
        try:
            reverse_server = ReverseServerAuthorizedKeys.objects.get(id=server_id, user=user)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            logger.error(f"ReverseServerAuthorizedKeys with id {server_id} does not exist for user {user}")
            return None
        return reverse_server.reverse_port

