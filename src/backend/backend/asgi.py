"""
ASGI config for backend project.
It exposes the ASGI callable as a module-level variable named ``application``.
"""

import os

from channels.auth import AuthMiddlewareStack
from channels.routing import ProtocolTypeRouter, URLRouter
from channels.security.websocket import AllowedHostsOriginValidator
from django.core.asgi import get_asgi_application

from tunnels.routing import websocket_urlpatterns

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
# Initialize Django ASGI application early to ensure the AppRegistry
# is populated before importing code that may import ORM models.
django_asgi_app = get_asgi_application()

import tunnels.routing

DEBUG = os.getenv("DEBUG", "False").lower() == "true"

# In development, skip AllowedHostsOriginValidator so the Next.js dev server
# (localhost:3000) can connect to WebSockets on a different port (e.g. 8787).
# In production, keep the validator for security.
_ws_stack = AuthMiddlewareStack(URLRouter(websocket_urlpatterns))
if not DEBUG:
    _ws_stack = AllowedHostsOriginValidator(_ws_stack)

application = ProtocolTypeRouter(
    {
        "http": django_asgi_app,
        "websocket": _ws_stack,
    }
)
