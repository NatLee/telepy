from django.urls import path
from site_settings.views import SiteSettingsView

urlpatterns = [
    path("settings", SiteSettingsView.as_view(), name="site-settings"),
]