from django.urls import path
from reverse_keys.views import IssueToken, CreateReverseServerKey

urlpatterns = [
    path('issue/token', IssueToken.as_view(), name='issue-token'),
    path('create/key/<str:token>', CreateReverseServerKey.as_view(), name='create-reverse-key'),
]
