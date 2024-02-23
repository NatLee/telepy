from rest_framework import generics
from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.serializers import ReverseServerAuthorizedKeysSerializer

from authorized_keys.utils import monitor_used_ports

class ReverseServerAuthorizedKeysList(generics.ListAPIView):
    queryset = ReverseServerAuthorizedKeys.objects.all()
    serializer_class = ReverseServerAuthorizedKeysSerializer
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)

class CheckReverseServerPortStatus(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        monitor_ports = monitor_used_ports()
        active_ports = ReverseServerAuthorizedKeys.objects.values_list('reverse_port', flat=True)
        result = {
            port: True if port in monitor_ports else False
            for port in active_ports
        }
        return Response(result)

