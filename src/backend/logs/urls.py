from django.urls import path
from logs.views import SSHLogs

urlpatterns = [
    path('ssh', SSHLogs.as_view(), name='ssh-logs'),
]

