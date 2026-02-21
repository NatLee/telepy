from rest_framework.permissions import AllowAny
from rest_framework_simplejwt.views import TokenObtainPairView

from drf_yasg.utils import swagger_auto_schema

from custom_auth.serializers import GoogleLoginSerializer
from custom_auth.utils.third_party_login import third_party_login

import logging

logger = logging.getLogger(__name__)

class GoogleLogin(TokenObtainPairView):
    permission_classes = (AllowAny,)  # AllowAny for login
    serializer_class = GoogleLoginSerializer

    @swagger_auto_schema(tags=["Login"])
    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        return third_party_login(
            serializer=serializer,
            request=request,
            session=True # Also login with session for Google login
        )
