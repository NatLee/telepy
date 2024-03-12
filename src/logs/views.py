from pathlib import Path

from django.conf import settings

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi


class SSHLogs(APIView):
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="SSH Logs",
        operation_description="SSH Logs",
        responses={
            200: openapi.Response(
                description="Show SSH server logs.",
                examples={
                    "application/json": {
                        "token": "your-issued-token",
                        "created_at": "2021-01-01T00:00:00.000000"
                    }
                }
            )
        },
        tags=['Logs']
    )
    def get(self, request):
        ssh_logs_path = Path('/ssh-logs/openssh/current')
        if not ssh_logs_path.exists():
            return Response("Logs not found", status=404)
        with open(ssh_logs_path, 'r') as f:
            # Only need to read the last 500 lines
            logs = f.readlines()[-500:]
            logs = '\n'.join(logs)
        return Response(logs)
