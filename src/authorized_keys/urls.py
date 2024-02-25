from django.urls import path, include
from authorized_keys.views import CheckReverseServerPortStatus
from authorized_keys.views import ReverseServerUsernamesMapServerId
from authorized_keys.views import ServiceAuthorizedKeysListView
urlpatterns = [
    path('server/status/ports', CheckReverseServerPortStatus.as_view(), name='reverse-server-ports-status'),
    path('server/<int:server_id>/usernames', ReverseServerUsernamesMapServerId.as_view(), name='reverse-server-usernames'),
    path('service/keys', ServiceAuthorizedKeysListView.as_view(), name='service-authorized-keys'),
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