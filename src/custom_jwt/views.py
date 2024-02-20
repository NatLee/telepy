from django.shortcuts import render

# Create your views here.


from rest_framework_simplejwt.serializers import TokenObtainPairSerializer
from rest_framework_simplejwt.views import TokenObtainPairView

from rest_framework_simplejwt.serializers import TokenRefreshSerializer
from rest_framework_simplejwt.views import TokenRefreshView


def get_client_ip(request):
    x_forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if x_forwarded_for:
        ip = x_forwarded_for.split(",")[0]
    else:
        ip = request.META.get("REMOTE_ADDR")

    return ip


class MyTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        refresh = self.get_token(self.user)
        # data["refresh"] = str(refresh)
        # data["access"] = str(refresh.access_token)
        data["refresh_token"] = str(refresh)
        data["access_token"] = str(refresh.access_token)
        del data["access"]
        del data["refresh"]

        """
        # Add extra responses here
        data["username"] = self.user.username
        data["groups"] = self.user.groups.values_list("name", flat=True)
        """

        return data


class MyTokenObtainPairView(TokenObtainPairView):
    serializer_class = MyTokenObtainPairSerializer


class MyTokenRefreshSerializer(TokenRefreshSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        data["access_token"] = data.get("access")
        del data["access"]

        return data


class MyTokenRefreshView(TokenRefreshView):
    serializer_class = MyTokenRefreshSerializer
