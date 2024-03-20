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

def parse_permissions(permission_string:str):
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
                description='The path to list. Defaults to the current directory.'
            )
        ]
    )

    def get(self, request, server_id, username, format=None):
        reverser_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id)
        reverse_port = reverser_server.reverse_port    
        server = f"{username}@localhost -p {reverse_port}"
        path = request.query_params.get('path', '.')
        command = f'ssh -o "ProxyCommand=ssh -W %h:%p telepy-ssh" -o "StrictHostKeyChecking=no" -o "UserKnownHostsFile=/dev/null" {server} \'LC_TIME="C" ls -la {path}\''
        
        process = Popen(command, shell=True, stdout=PIPE, stderr=PIPE)
        stdout, stderr = process.communicate()

        if process.returncode == 0:
            lines = stdout.decode().strip().split('\n')
            output = {"total": lines.pop(0).split()[1]}  # Extract total and remove the first line
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
            return Response({"error": stderr.decode()}, status=400)


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
        reverser_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id)
        reverse_port = reverser_server.reverse_port    
        server = f"{username}@localhost"
        path = request.query_params.get('path')

        # Set up the base SSH command with options
        base_ssh_cmd = f'ssh -o "ProxyCommand=ssh -W %h:%p telepy-ssh" -o "StrictHostKeyChecking=no" -o "UserKnownHostsFile=/dev/null" {server}'

        # Determine if path is a file or directory
        is_dir_command = f"{base_ssh_cmd} '[ -d \"{path}\" ] && echo true || echo false'"
        process = subprocess.Popen(is_dir_command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, _ = process.communicate()
        is_directory = stdout.decode().strip() == 'true'

        with tempfile.TemporaryDirectory() as tmpdirname:
            local_path = f"{tmpdirname}/archive"
            if is_directory:
                # Handle directory by creating a zip archive
                local_path += ".zip"
                command = f"{base_ssh_cmd} 'cd \"{path}\" && zip -r - .' > '{local_path}'"
            else:
                # Handle file by directly copying
                command = f"scp -P {reverse_port} -o ProxyCommand='ssh -W %h:%p telepy-ssh' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null {server}:\"{path}\" {local_path}"

            result = subprocess.run(command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if result.returncode != 0:
                return Response({"error": "Failed to download file or directory"}, status=400)

            with open(local_path, 'rb') as f:
                file_data = f.read()
                response = HttpResponse(file_data, content_type='application/octet-stream')
                response['Content-Disposition'] = f'attachment; filename="{path.split("/")[-1]}"'
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
        reverser_server = get_object_or_404(ReverseServerAuthorizedKeys, id=server_id)
        reverse_port = reverser_server.reverse_port    
        server = f"{username}@localhost"
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
            scp_cmd = f"scp -P {reverse_port} -o ProxyCommand='ssh -W %h:%p telepy-ssh' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null '{temp_file_path}' {server}:\"{destination_path}\""
            process = subprocess.Popen(scp_cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, stderr = process.communicate()

            if process.returncode == 0:
                return Response({"success": "File uploaded successfully"})
            else:
                return Response({"error": stderr.decode()}, status=400)
