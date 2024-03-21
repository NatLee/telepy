from django.urls import path
from tunnels.views import TunnelsIndex
from tunnels.views import TunnelsCreate
from tunnels.views import UserKeys
from tunnels.views import Terminal
from tunnels.views import SSHServerLogs
from tunnels.views import ReverseServerAuthorizedKeysConfig
from tunnels.views import AutoSSHTunnelScript
from tunnels.views import WindowsSSHTunnelScript
urlpatterns = [

    path('index', TunnelsIndex.as_view(), name='tunnels-index'),
    path('create', TunnelsCreate.as_view(), name='tunnels-create'),
    path('keys', UserKeys.as_view(), name='user-keys'),
    path('terminal/<int:server_id>', Terminal.as_view(), name='terminal'),
    path('logs', SSHServerLogs.as_view(), name='ssh-server-logs'),
    path('server/<str:ssh_server_hostname>/config/<int:server_id>', ReverseServerAuthorizedKeysConfig.as_view(), name='authorized-keys-config'),
    path('server/<str:ssh_server_hostname>/script/autossh/<int:server_id>/<int:ssh_port>', AutoSSHTunnelScript.as_view(), name='auto-ssh-tunnel-script'),
    path('server/<str:ssh_server_hostname>/script/windows/<int:server_id>/<int:ssh_port>', WindowsSSHTunnelScript.as_view(), name='windows-ssh-tunnel-script'),

]

