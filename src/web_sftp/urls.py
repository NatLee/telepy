from django.urls import path
from web_sftp.views import ListPath
from web_sftp.views import Download
from web_sftp.views import UploadFiles

urlpatterns = [

    path('list/<int:server_id>/<str:username>', ListPath.as_view(), name='list-path'),
    path('download/<int:server_id>/<str:username>', Download.as_view(), name='sftp-download'),
    path('upload/<int:server_id>/<str:username>', UploadFiles.as_view(), name='sftp-upload'),

]
