
from django.urls import re_path
from tunnels import consumers

websocket_urlpatterns = [
    re_path(r'ws/notifications/$', consumers.NotificationConsumer.as_asgi()),
    re_path(r'ws/terminal/$', consumers.TerminalConsumer.as_asgi()),
]

