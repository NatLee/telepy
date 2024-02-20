from django.contrib.auth import views as auth_views
from django.urls import path

from rest_framework_simplejwt.views import (
    TokenVerifyView,
)

from custom_jwt import views

urlpatterns = [
    path("token", views.MyTokenObtainPairView.as_view(), name="token_get"),
    path("token/refresh", views.MyTokenRefreshView.as_view(), name="token_refresh"),
    path("token/verify", TokenVerifyView.as_view(), name="token_verify"),
]
