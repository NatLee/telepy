from typing import List, Tuple, Dict, Any, Union
import json
from pathlib import Path
import datetime
import tempfile
import subprocess
from subprocess import Popen, PIPE

from django.shortcuts import get_object_or_404
from django.http import HttpResponse
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
from rest_framework.parsers import FormParser, MultiPartParser

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames

def parse_permissions(permission_string:str) -> Dict[str, Any]:
    permissions = {
        "type": "directory" if permission_string[0] == 'd' else "file",
        "string": permission_string,
        "user": {
            "read": permission_string[1] == 'r',
            "write": permission_string[2] == 'w',
            "execute": permission_string[3] == 'x' or permission_string[3] == 's',
            "setuid": permission_string[3] == 's',
        },
        "group": {
            "read": permission_string[4] == 'r',
            "write": permission_string[5] == 'w',
            "execute": permission_string[6] == 'x' or permission_string[6] == 's',
            "setgid": permission_string[6] == 's',
        },
        "others": {
            "read": permission_string[7] == 'r',
            "write": permission_string[8] == 'w',
            "execute": permission_string[9] == 'x' or permission_string[9] == 't',
            "sticky": permission_string[9] == 't',
        }
    }
    return permissions

def execute_ssh_command(server:str, port:int, command:str) -> Tuple[str, str, int]:
    """Executes a given command via SSH on the server and returns the output."""
    ssh_command = f'ssh {server} -p {port} {command}'
    process = Popen(ssh_command, shell=True, stdout=PIPE, stderr=PIPE)
    stdout, stderr = process.communicate()
    return stdout.decode('utf-8', errors='replace'), stderr.decode(), process.returncode

def powershell_to_unix_format(ps_output) -> List[str]:
    unix_style_output = []

    for item in ps_output:
        mode = 'd' if item["Mode"].startswith('d') else '-'
        mode += ''.join(['r' if 'r' in perm else '-' for perm in item["Mode"][1:3]])
        mode += ''.join(['w' if 'w' in perm else '-' for perm in item["Mode"][3:5]])
        mode += ''.join(['x' if 'x' in perm else '-' for perm in item["Mode"][5:7]])
        mode = mode.ljust(10, '-')  # Fill the rest with '-' to mimic Unix style

        # Convert the "LastWriteTime" to a more Unix-like date format, e.g., "Nov 10 02:29"
        last_write_time = datetime.datetime.fromisoformat(item["LastWriteTime"].rstrip('Z')).strftime('%b %d %H:%M')

        # Assuming directories are of a fixed size like '4096' and files show their actual size
        size = str(item["Length"]) if item["Length"] is not None else '4096'

        name = item["Name"]

        unix_style_output.append(f"{mode} 1 user group {size.rjust(5)} {last_write_time} {name}")

    return unix_style_output

def is_powershell(server:str, port:int) -> bool:
    """Detects if the remote server is using PowerShell."""
    command = "'$PSVersionTable | Out-String -Width 4096'"
    stdout, stderr, returncode = execute_ssh_command(server, port, command)
    return "PSVersion" in stdout

def is_unix(server:str, port:int) -> bool:
    """Detects if the remote server is using a Unix-like shell."""
    command = "'uname -a'"
    stdout, stderr, returncode = execute_ssh_command(server, port, command)
    return "Linux" in stdout

class ShellDetect(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Detect Shell",
        operation_description="Detect the shell used on the remote server",
        tags=['SFTP'],
    )
    def get(self, request, server_id, username, format=None):
        user = request.user
        reverse_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id, user=user)
        try:
            # Check username exists
            ReverseServerUsernames.objects.get(
                reverse_server=reverse_server,
                username=username,
                user=user
            )
        except ReverseServerUsernames.DoesNotExist:
            return Response({"error": "Username not found"}, status=400)

        port = reverse_server.reverse_port
        server = f"{username}@reverse"
        try:
            if is_powershell(server, port):
                return Response({"shell": "powershell"})
            if is_unix(server, port):
                return Response({"shell": "unix"})
            return Response({"shell": "unknown"})
        except Exception as e:
            return Response({"error": str(e)}, status=400)


class ListPath(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="List Path",
        operation_description="List the contents of a directory on a remote server",
        tags=['SFTP'],
        manual_parameters=[
            openapi.Parameter(
                name='path',
                in_=openapi.IN_QUERY,
                type=openapi.TYPE_STRING,
                required=False,
                description='The path to list. Defaults to the home directory in Unix-like shell and C:\\ in PowerShell.'
            )
        ]
    )
    def get(self, request, server_id, username, format=None):
        user = request.user
        reverse_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id, user=user)
        try:
            # Check username exists
            ReverseServerUsernames.objects.get(
                reverse_server=reverse_server,
                username=username,
                user=user
            )
        except ReverseServerUsernames.DoesNotExist:
            return Response({"error": "Username not found"}, status=400)

        port = reverse_server.reverse_port
        server = f"{username}@reverse"
        
        path = request.query_params.get('path', '~/')
        command = f"'ls -la {path}'"

        if is_powershell(server, port):
            path = request.query_params.get('path', 'C:\\')
            command = f"""'Get-ChildItem -Path "{path}" | Select-Object Mode, LastWriteTime, Length, Name | ConvertTo-Json'"""
        stdout, stderr, returncode = execute_ssh_command(server, port, command)
      
        if returncode == 0:

            # Process output based on the executed command
            if "ConvertTo-Json" in command:
                # Parse the JSON output
                try:
                    result_of_powershell = json.loads(stdout)
                    if isinstance(result_of_powershell, dict):
                        result_of_powershell = [result_of_powershell]
                except json.JSONDecodeError:
                    return Response({"error": "Powershell result failed to parse JSON output"}, status=400)
                # Convert the PowerShell output to a Unix-like format
                output = {
                    "shell": "powershell",  # Indicate that the shell used was "powershell"
                    "total": len(result_of_powershell)
                }
                lines = powershell_to_unix_format(result_of_powershell)
            else:
                lines = stdout.strip().split('\n')
                output = {
                    "shell": "unix",  # Indicate that the shell used was "unix
                    "total": lines.pop(0).split()[1],  # Extract total and remove the first line
                }

            elements = []

            for line in lines:
                parts = line.split(maxsplit=8)
                if len(parts) < 9:  # Skip if line does not have all parts
                    continue

                permissions = parse_permissions(parts[0])
                name = parts[-1]
                if name in ['.', '..']:
                    continue

                # Date parsing
                try:
                    date_str = ' '.join(parts[5:8])
                    if ':' in date_str:
                        date = datetime.datetime.strptime(date_str, "%b %d %H:%M").replace(year=datetime.datetime.now().year).strftime("%Y-%m-%d %H:%M")
                    else:
                        date = datetime.datetime.strptime(date_str, "%b %d %Y").strftime("%Y-%m-%d %H:%M")
                except ValueError:
                    date = "Unknown"

                elements.append({
                    "type": permissions["type"],
                    "permissions": permissions,
                    "links": parts[1],
                    "owner": parts[2],
                    "group": parts[3],
                    "size": parts[4],
                    "date": date,
                    "name": name
                })

            output["files"] = elements
            return Response(output)
        else:
            return Response({"error": stderr}, status=404)

class Download(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Download",
        operation_description="Download a file or directory from a remote server",
        tags=['SFTP'],
        manual_parameters=[
            openapi.Parameter(
                name='path',
                in_=openapi.IN_QUERY,
                type=openapi.TYPE_STRING,
                required=True,
                description='The path to download'
            )
        ]
    )
    def get(self, request, server_id, username, format=None):
        user = request.user
        reverse_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id, user=user)
        try:
            # Check username exists
            ReverseServerUsernames.objects.get(
                reverse_server=reverse_server,
                username=username,
                user=user
            )
        except ReverseServerUsernames.DoesNotExist:
            return Response({"error": "Username not found"}, status=400)

        reverse_port = reverse_server.reverse_port    
        server = f"{username}@reverse"
        path = request.query_params.get('path')

        # Set up the base SSH command with options
        base_ssh_cmd = f'ssh {server} -p {reverse_port}'

        # Determine if path is a file or directory
        is_dir_command = base_ssh_cmd + f" '[ -d {path} ] && echo true || echo false'"
        process = subprocess.Popen(is_dir_command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, _ = process.communicate()
        is_directory = stdout.decode().strip() == 'true'

        with tempfile.TemporaryDirectory() as tmpdir:
            local_path = Path(tmpdir)
            name = path.split("/")[-1]
            if is_directory:
                # Handle directory by creating a zip archive
                # Copy the directory to the local machine and zip it
                command = f'scp -P {reverse_port} -r {server}:\"{path}\" {local_path} && cd {local_path} && zip -r - ./{name} > ./{name}.zip'
                # Add the zip extension to the local path
                local_path = local_path / f"{name}.zip"
            else:
                # Handle file by directly copying
                local_path = local_path / name
                command = f"scp -P {reverse_port} {server}:\"{path}\" {local_path}"

            result = subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            if result.returncode != 0:
                return Response({"error": "Failed to download file or directory"}, status=400)

            with open(local_path, 'rb') as f:
                file_data = f.read()
                response = HttpResponse(file_data, content_type='application/octet-stream')
                filename = path.split("/")[-1]
                if is_directory:
                    response['Content-Type'] = 'application/zip'
                    filename += ".zip"
                response['Content-Disposition'] = f'attachment; filename="{filename}"'
                return response

class UploadFiles(APIView):
    permission_classes = (IsAuthenticated,)
    parser_classes = (FormParser, MultiPartParser)

    @swagger_auto_schema(
        operation_summary="Upload Files",
        operation_description="Upload a file to a remote server",
        tags=['SFTP'],
        manual_parameters=[
            openapi.Parameter(
                name='destination_path',
                in_=openapi.IN_QUERY,
                type=openapi.TYPE_STRING,
                required=True,
                description='The path to upload the file to on the remote server.'
            ),
            openapi.Parameter(
                name="file",
                in_=openapi.IN_FORM,
                type=openapi.TYPE_FILE,
                required=True,
                description="The file to upload."
            ),
        ]
    )
    def post(self, request, server_id, username, format=None):
        user = request.user
        reverse_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id, user=user)
        try:
            # Check username exists
            ReverseServerUsernames.objects.get(
                reverse_server=reverse_server,
                username=username,
                user=user
            )
        except ReverseServerUsernames.DoesNotExist:
            return Response({"error": "Username not found"}, status=400)

        reverse_port = reverse_server.reverse_port
        server = f"{username}@reverse"
        destination_path = request.query_params.get('destination_path')
        file_obj = request.FILES.get('file')

        if not file_obj or not destination_path:
            return Response({"error": "File and destination path required"}, status=400)

        # Create a temporary directory and save the file there with its original name
        with tempfile.TemporaryDirectory() as tmp_dir:
            temp_file_path = Path(tmp_dir) / file_obj.name
            with open(temp_file_path, 'wb+') as temp_file:
                for chunk in file_obj.chunks():
                    temp_file.write(chunk)

            # Use SCP to upload the file
            scp_cmd = f"scp -P {reverse_port} '{temp_file_path}' {server}:\"{destination_path}\""
            process = subprocess.Popen(scp_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = process.communicate()

            if process.returncode == 0:
                return Response({"success": "File uploaded successfully"})
            else:
                return Response({"error": stderr.decode()}, status=400)
