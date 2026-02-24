import re
import urllib.parse
from subprocess import Popen, PIPE
from django.http import HttpResponse, StreamingHttpResponse, JsonResponse
from django.views.decorators.clickjacking import xframe_options_exempt
from django.utils.decorators import method_decorator
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated
from rest_framework_simplejwt.authentication import JWTAuthentication

from authorized_keys.models import ReverseServerAuthorizedKeys, ReverseServerUsernames
from tunnels.models import TunnelPermissionManager, TunnelPermission
from services.tunnel_permissions import TunnelPermissionService
from authorized_keys.remote_browser_service import start_remote_browser, stop_remote_browser, ping_remote_browser

def check_username_allowed(user, reverse_server, username):
    allowed = TunnelPermissionService.get_allowed_usernames(user, reverse_server)
    return allowed.filter(username=username).exists()



class RemoteBrowserStartView(APIView):
    permission_classes = (IsAuthenticated,)

    def post(self, request, server_id):
        user = request.user
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=server_id)
            if not TunnelPermissionManager.check_access(user, tunnel, TunnelPermission.VIEW):
                return JsonResponse({"error": "Permission denied"}, status=403)
        except ReverseServerAuthorizedKeys.DoesNotExist:
            return JsonResponse({"error": "Tunnel not found"}, status=404)

        username = request.data.get('username')
        if not username:
            allowed = TunnelPermissionService.get_allowed_usernames(user, tunnel)
            if allowed.exists():
                default_username_id = tunnel.default_username_id
                if default_username_id and allowed.filter(id=default_username_id).exists():
                    username = allowed.get(id=default_username_id).username
                else:
                    username = allowed.first().username
            else:
                return JsonResponse({"error": "No authorized target user available"}, status=403)
        else:
            if not check_username_allowed(user, tunnel, username):
                return JsonResponse({"error": "Username not authorized"}, status=403)

        try:
            result = start_remote_browser(
                target_username=username,
                target_reverse_port=tunnel.reverse_port,
                server_id=server_id
            )
            return JsonResponse(result)
        except Exception as e:
            return JsonResponse({"error": str(e)}, status=500)


class RemoteBrowserStopView(APIView):
    permission_classes = (IsAuthenticated,)

    def post(self, request, session_id):
        stopped = stop_remote_browser(session_id)
        if stopped:
            return JsonResponse({"status": "success"})
        else:
            return JsonResponse({"error": "Session not found"}, status=404)

class RemoteBrowserPingView(APIView):
    permission_classes = (IsAuthenticated,)

    def post(self, request, session_id):
        pinged = ping_remote_browser(session_id)
        if pinged:
            return JsonResponse({"status": "ok"})
        else:
            return JsonResponse({"error": "Session not found"}, status=404)
