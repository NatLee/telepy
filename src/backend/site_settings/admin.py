from django.contrib import admin

from site_settings.models import SiteSettings

@admin.register(SiteSettings)
class SiteSettingsAdmin(admin.ModelAdmin):
    list_display = [
        'allow_registration',
        'remote_browser_session_idle_timeout',
        'remote_browser_max_sessions',
        'remote_browser_cdp_url',
        'remote_browser_screencast_quality',
        'remote_browser_screencast_every_nth_frame',
    ]
