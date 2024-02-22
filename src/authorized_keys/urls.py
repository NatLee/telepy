from django.urls import path
from authorized_keys.views import ReverseServerAuthorizedKeysList
from authorized_keys.views import CheckReverseServerPortStatus
urlpatterns = [
    path('server/keys', ReverseServerAuthorizedKeysList.as_view(), name='reverse-server-keys-list'),
    path('server/status/ports', CheckReverseServerPortStatus.as_view(), name='reverse-server-ports-status'),
]
