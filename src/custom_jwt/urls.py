from django.contrib.auth import views as auth_views
from django.urls import path

from custom_jwt import views

urlpatterns = [
    path("token", views.MyTokenObtainPairView.as_view(), name="token-get"),
    path("token/refresh", views.MyTokenRefreshView.as_view(), name="token-refresh"),
    path("token/verify", views.MyTokenVerifyView.as_view(), name="token-verify"),
]
