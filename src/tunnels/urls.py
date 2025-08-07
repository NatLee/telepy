from django.urls import path
from tunnels.views import TunnelsIndex
from tunnels.views import TunnelsCreate
from tunnels.views import UserKeys
from tunnels.views import Terminal
from tunnels.views import AdminSettings
from tunnels.views import SSHServerLogs
from tunnels.views import ReverseServerAuthorizedKeysConfig
from tunnels.views import PowershellSSHTunnelScript
from tunnels.views import SSHTunnelScript
from tunnels.views import AutoSSHTunnelScript
from tunnels.views import AutoSSHServiceTunnelScript
urlpatterns = [

    path('index', TunnelsIndex.as_view(), name='tunnels-index'),
    path('create', TunnelsCreate.as_view(), name='tunnels-create'),
    path('keys', UserKeys.as_view(), name='user-keys'),
    path('terminal/<int:server_id>', Terminal.as_view(), name='terminal'),
    path('settings', AdminSettings.as_view(), name='admin-settings'),
    path('logs', SSHServerLogs.as_view(), name='ssh-server-logs'),

    path('server/config/<int:server_id>', ReverseServerAuthorizedKeysConfig.as_view(), name='authorized-keys-config'),
    path('server/script/powershell/<int:server_id>/<int:ssh_port>', PowershellSSHTunnelScript.as_view(), name='powershell-ssh-tunnel-script'),
    path('server/script/ssh/<int:server_id>/<int:ssh_port>', SSHTunnelScript.as_view(), name='ssh-tunnel-script'),
    path('server/script/autossh/<int:server_id>/<int:ssh_port>', AutoSSHTunnelScript.as_view(), name='auto-ssh-tunnel-script'),
    path('server/script/autossh-service/<int:server_id>/<int:ssh_port>', AutoSSHServiceTunnelScript.as_view(), name='auto-ssh-service-tunnel-script'),

]

