from django.urls import path
from tunnels.views import TunnelsIndex
from tunnels.views import TunnelsCreate
from tunnels.views import UserKeys
from tunnels.views import Terminal

urlpatterns = [

    path('index', TunnelsIndex.as_view(), name='tunnels-index'),
    path('create', TunnelsCreate.as_view(), name='tunnels-create'),
    path('keys', UserKeys.as_view(), name='user-keys'),
    path('terminal/<int:server_id>', Terminal.as_view(), name='terminal'),

]

