from django.urls import path
from tunnels.views import TunnelsIndex
from tunnels.views import TunnelsCreate
urlpatterns = [
    path('index', TunnelsIndex.as_view(), name='tunnels-index'),
    path('create', TunnelsCreate.as_view(), name='tunnels-create'),
]

