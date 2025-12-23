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
from tunnels.views import DockerRunTunnelScript
from tunnels.views import DockerComposeTunnelScript
from tunnels.views import ShareTunnelView
from tunnels.views import UnshareTunnelView
from tunnels.views import ListSharedUsersView
from tunnels.views import ListAvailableUsersView
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
    path('server/script/docker-run/<int:server_id>/<int:ssh_port>', DockerRunTunnelScript.as_view(), name='docker-run-tunnel-script'),
    path('server/script/docker-compose/<int:server_id>/<int:ssh_port>', DockerComposeTunnelScript.as_view(), name='docker-compose-tunnel-script'),

    # Tunnel sharing endpoints
    path('share/<int:tunnel_id>', ShareTunnelView.as_view(), name='share-tunnel'),
    path('unshare/<int:tunnel_id>/<int:user_id>', UnshareTunnelView.as_view(), name='unshare-tunnel'),
    path('shared-users/<int:tunnel_id>', ListSharedUsersView.as_view(), name='list-shared-users'),
    path('available-users/<int:tunnel_id>', ListAvailableUsersView.as_view(), name='list-available-users'),

]

