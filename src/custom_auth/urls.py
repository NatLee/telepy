from django.contrib.auth import views as auth_views
from django.urls import path

from custom_auth import views

urlpatterns = [
    path("token", views.GoogleLogin.as_view(), name="google_token"),
]
