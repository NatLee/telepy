from django.conf import settings
from django.shortcuts import render, redirect

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

class TunnelsIndex(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Tunnels Index",
        operation_description="Index page for Tunnels",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'tunnels.html')

class TunnelsCreate(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Tunnels Create",
        operation_description="Create page for Tunnels",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'create.html')

class UserKeys(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="User Keys",
        operation_description="User Keys page",
        tags=['Page']
    )
    def get(self, request):
        return render(request, 'keys.html')

class Terminal(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Terminal",
        operation_description="Terminal page",
        tags=['Page']
    )
    def get(self, request, server_id):
        return render(request, 'terminal.html')



from authorized_keys.models import ReverseServerAuthorizedKeys
class ReverseServerAuthorizedKeysConfig(APIView):
    permission_classes = (IsAuthenticated,)
    @swagger_auto_schema(
        operation_summary="Reverse Server Authorized Keys Config",
        operation_description="Reverse Server Authorized Keys Config",
        tags=['Script']
    )
    def get(self, request, server_id, ssh_server_hostname):
        try:
            server_auth_key = ReverseServerAuthorizedKeys.objects.get(id=server_id)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return Response({'error': 'Reverse server keys not found'}, status=404)

        config_string = f"""Host telepy-ssh-server
    HostName {ssh_server_hostname}
    Port {settings.REVERSE_SERVER_SSH_PORT}
    User telepy
"""
        server_auth_key_user = server_auth_key.reverseserverusernames_set.all()
           

        for username in server_auth_key_user:
            config_string += f"""
Host {server_auth_key.hostname}
    HostName localhost
    Port {server_auth_key.reverse_port}
    User {username.username}
    ProxyCommand ssh -W %h:%p telepy-ssh-server"""
        return Response({'config': config_string})
        



