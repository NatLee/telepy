import datetime

from django.conf import settings
from django.contrib.auth.models import User

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status

from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

from authorized_keys.models import ReverseServerAuthorizedKeys
from reverse_keys.utils import issue_token, verify_token, remove_token, get_user_id_from_token
from reverse_keys.utils import find_multiple_free_ports

from authorized_keys.utils import is_valid_ssh_public_key

class IssueToken(APIView):
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="Issue Token",
        operation_description="Issues a token with a 10-minute expiration",
        responses={
            200: openapi.Response(
                description="A token is issued",
                examples={
                    "application/json": {
                        "token": "your-issued-token",
                        "created_at": "2021-01-01T00:00:00.000000"
                    }
                }
            )
        },
        tags=['Reverse Server Keys']
    )
    def get(self, request, *args, **kwargs):
        token = issue_token(request.user.id)
        return Response({
            'token': token,
            'issuer': {
                'id': request.user.id,
                'username': request.user.username
            },
            'created_at': datetime.datetime.now().isoformat(),
        })

class CreateReverseServerKey(APIView):
    permission_classes = (AllowAny, IsAuthenticated,)
    parser_classes = (MultiPartParser, FormParser, JSONParser,)

    @swagger_auto_schema(
        operation_summary="Create Reverse Server Key",
        operation_description="Creates a Reverse Server Authorized Key using a valid token",
        responses={
            200: openapi.Response(
                description="Reverse Server Key created successfully"
            ),
            400: "Invalid or expired token"
        },
        request_body=openapi.Schema(
            type=openapi.TYPE_OBJECT, 
            properties={
                'hostname': openapi.Schema(type=openapi.TYPE_STRING, description='string'),
                'key': openapi.Schema(type=openapi.TYPE_STRING, description='string'),
                'description': openapi.Schema(type=openapi.TYPE_STRING, description='string'),
            },
        ),
        tags=['Reverse Server Keys']
    )
    def post(self, request, token, *args, **kwargs):

        if token == '':
            return Response({"error": "Token is required"}, status=status.HTTP_400_BAD_REQUEST)

        if not verify_token(token):
            return Response({"error": "Invalid or expired token"}, status=status.HTTP_400_BAD_REQUEST)

        user:User = get_user_id_from_token(token)
        if not user:
            return Response({"error": "Invalid or expired token"}, status=status.HTTP_400_BAD_REQUEST)

        # =====================================

        hostname:str = request.data.get('hostname', None)
        if not hostname:
            return Response({"error": "Hostname is required"}, status=status.HTTP_400_BAD_REQUEST)

        # Hostname cannot start with a number
        if not hostname[0].isalpha():
            return Response({"error": "Hostname cannot start with a number."}, status=status.HTTP_400_BAD_REQUEST)

        key:str = request.data.get('key', None)
        if not key:
            return Response({"error": "Key is required"}, status=status.HTTP_400_BAD_REQUEST)

        if not is_valid_ssh_public_key(key):
            return Response({"error": "Invalid SSH public key format"}, status=status.HTTP_400_BAD_REQUEST)

        description = request.data.get('description', '')

        try:
            reverse_key = ReverseServerAuthorizedKeys.objects.create(
                user=user,
                hostname=hostname,
                key=key,
                reverse_port=find_multiple_free_ports(1)[0],
                description=description
            )
            remove_token(token)
            return Response({
                "id": reverse_key.id,
                "hostname": reverse_key.hostname,
                "key": reverse_key.key,
                "port": settings.REVERSE_SERVER_SSH_PORT,
                "issuer": {
                    "id": user.id,
                    "username": user.username
                },
                "reverse_port": reverse_key.reverse_port,
                "description": reverse_key.description,
            })
        except Exception as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

