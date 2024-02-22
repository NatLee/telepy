from rest_framework import generics
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.serializers import ReverseServerAuthorizedKeysSerializer

class ReverseServerAuthorizedKeysList(generics.ListAPIView):
    queryset = ReverseServerAuthorizedKeys.objects.all()
    serializer_class = ReverseServerAuthorizedKeysSerializer
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)
