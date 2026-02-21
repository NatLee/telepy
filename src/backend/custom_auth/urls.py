from django.urls import path

from custom_auth.views import GoogleLogin

urlpatterns = [
    path(f"token", GoogleLogin.as_view(), name='google-token'),
]
