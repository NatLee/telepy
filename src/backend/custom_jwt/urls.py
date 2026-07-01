from django.contrib.auth import views as auth_views
from django.urls import path

from custom_jwt import views

urlpatterns = [
    path("setup-status", views.SetupStatusView.as_view(), name="setup-status"),
    path("token", views.MyTokenObtainPairView.as_view(), name="token-get"),
    path("token/refresh", views.MyTokenRefreshView.as_view(), name="token-refresh"),
    path("token/verify", views.MyTokenVerifyView.as_view(), name="token-verify"),
    path("user/profile", views.UserProfileView.as_view(), name="user-profile"),
    # 一次性 WebSocket 連線票 / one-time WebSocket ticket
    path("ws-ticket", views.WsTicketView.as_view(), name="ws-ticket"),
]
