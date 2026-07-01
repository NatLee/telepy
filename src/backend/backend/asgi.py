"""
ASGI config for backend project.
It exposes the ASGI callable as a module-level variable named ``application``.
"""

import os

# 必須在 import 任何會觸碰 app registry / ORM models 的模組（例如 tunnels.routing ->
# consumers -> django.contrib.auth.models）之前，先設定 settings 並初始化 Django ASGI app。
# daphne 會「直接」import 本模組（不經過 manage.py），因此 DJANGO_SETTINGS_MODULE 必須在
# 這裡先設定，否則頂層的 model import 會丟出 ImproperlyConfigured（settings are not configured）。
# runserver 之所以沒事，是因為 manage.py 已先設好環境變數並呼叫 django.setup()。
#
# Set DJANGO_SETTINGS_MODULE and initialize the ASGI app BEFORE importing anything that
# touches the app registry / ORM models. daphne imports this module directly (no manage.py),
# so the settings module must be configured here first — otherwise the top-level model
# imports in tunnels.routing raise ImproperlyConfigured.
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')

from django.core.asgi import get_asgi_application

# get_asgi_application() 會填充 AppRegistry（等同 django.setup()）。
# get_asgi_application() populates the AppRegistry (runs django.setup()).
django_asgi_app = get_asgi_application()

# 只有在 app registry 就緒後，才 import 會載入 consumers / models 的 routing。
# Import channels routing (which loads consumers/models) only AFTER the registry is ready.
from channels.auth import AuthMiddlewareStack  # noqa: E402
from channels.routing import ProtocolTypeRouter, URLRouter  # noqa: E402
from channels.security.websocket import AllowedHostsOriginValidator  # noqa: E402

from tunnels.routing import websocket_urlpatterns  # noqa: E402

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
