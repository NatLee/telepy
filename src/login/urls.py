from django.urls import path

from login import views

import logging

logger = logging.getLogger(__name__)

urlpatterns = [
    path('', views.Login.as_view(), name='login-page'),
]