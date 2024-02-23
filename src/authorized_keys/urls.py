from django.urls import path, include
from authorized_keys.views import ReverseServerAuthorizedKeysList
from authorized_keys.views import CheckReverseServerPortStatus

urlpatterns = [

    path('server/keys', ReverseServerAuthorizedKeysList.as_view(), name='reverse-server-keys-list'),
    path('server/status/ports', CheckReverseServerPortStatus.as_view(), name='reverse-server-ports-status'),

]

from rest_framework.routers import DefaultRouter
from authorized_keys.views import UserAuthorizedKeysViewSet

router = DefaultRouter(trailing_slash=False)
router.register(r'user/keys', UserAuthorizedKeysViewSet)

urlpatterns += [
    path('', include(router.urls)),
]