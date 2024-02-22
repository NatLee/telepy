from django.urls import path
from tunnels.views import TunnelsIndex

urlpatterns = [
    path('index', TunnelsIndex.as_view(), name='tunnels-index'),
]

