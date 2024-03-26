from rest_framework.permissions import AllowAny
from rest_framework_simplejwt.views import TokenObtainPairView

from custom_auth.serializers import GoogleLoginSerializer
from custom_auth.utils.third_party_login import third_party_login

import logging

logger = logging.getLogger(__name__)

class GoogleLogin(TokenObtainPairView):
    permission_classes = (AllowAny,)  # AllowAny for login
    serializer_class = GoogleLoginSerializer

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        return third_party_login(serializer, request)
