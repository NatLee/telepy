from rest_framework import generics
from .models import ReverseServerAuthorizedKeys
from .serializers import ReverseServerAuthorizedKeysSerializer
from drf_yasg.utils import swagger_auto_schema

class ReverseServerAuthorizedKeysList(generics.ListAPIView):
    queryset = ReverseServerAuthorizedKeys.objects.all()
    serializer_class = ReverseServerAuthorizedKeysSerializer

    @swagger_auto_schema(tags=['Reverse Server Keys'])
    def get(self, request, *args, **kwargs):
        return super().get(request, *args, **kwargs)
