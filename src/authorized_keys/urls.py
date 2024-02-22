from django.urls import path
from authorized_keys.views import ReverseServerAuthorizedKeysList

urlpatterns = [
    path('server/keys', ReverseServerAuthorizedKeysList.as_view(), name='reverse-server-keys-list'),
]
