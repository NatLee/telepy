from django.urls import path, include
from authorized_keys.views import CheckReverseServerPortStatus
from authorized_keys.views import ReverseServerUsernamesMapServerId
from authorized_keys.views import SetDefaultUsernameView
from authorized_keys.views import ServiceAuthorizedKeysListView
from authorized_keys.views import InternalKeysView
from authorized_keys.browse_views import RemoteBrowserStartView, RemoteBrowserStopView, RemoteBrowserPingView
urlpatterns = [
    path('server/status/ports', CheckReverseServerPortStatus.as_view(), name='reverse-server-ports-status'),
    path('server/<int:server_id>/usernames', ReverseServerUsernamesMapServerId.as_view(), name='reverse-server-usernames'),
    path('server/<int:server_id>/default-username', SetDefaultUsernameView.as_view(), name='set-default-username'),
    path('server/<int:server_id>/remote-browser/start', RemoteBrowserStartView.as_view(), name='remote-browser-start'),
    path('server/remote-browser/<str:session_id>/stop', RemoteBrowserStopView.as_view(), name='remote-browser-stop'),
    path('server/remote-browser/<str:session_id>/ping', RemoteBrowserPingView.as_view(), name='remote-browser-ping'),
    path('service/keys', ServiceAuthorizedKeysListView.as_view(), name='service-authorized-keys'),
    path('internal/keys', InternalKeysView.as_view(), name='internal-keys'),
]

from rest_framework.routers import DefaultRouter
from authorized_keys.views import UserAuthorizedKeysViewSet
from authorized_keys.views import ReverseServerUsernamesViewSet
from authorized_keys.views import ReverseServerAuthorizedKeysViewSet

router = DefaultRouter(trailing_slash=False)
router.register(r'user/keys', UserAuthorizedKeysViewSet)
router.register(r'server/usernames', ReverseServerUsernamesViewSet)
router.register(r'server/keys', ReverseServerAuthorizedKeysViewSet)

urlpatterns += [
    path('', include(router.urls)),
]