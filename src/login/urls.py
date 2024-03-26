from django.urls import path
from login import views
import logging

logger = logging.getLogger(__name__)

urlpatterns = [

    path('', views.Login.as_view(), name='login-page-root'), # <- when you go to the root, it will redirect to the login page
    path('login', views.Login.as_view(), name='login-page'), # normal login page

]