from django.urls import path
from reverse_keys import views

urlpatterns = [
    path('issue/token', views.IssueToken.as_view(), name='issue-token'),
    path('create/key/<str:token>', views.CreateReverseServerKey.as_view(), name='create-reverse-key'),
    path('create/key/duplicate/<str:token>', views.CheckReverseServerKeyDuplicate.as_view(), name='check-reverse-key-duplicate'),
]
