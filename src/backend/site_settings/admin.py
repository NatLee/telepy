from django.contrib import admin

from site_settings.models import SiteSettings

@admin.register(SiteSettings)
class SiteSettingsAdmin(admin.ModelAdmin):
    list_display = [
        'allow_registration',
        'valid_register_domains',
        'remote_browser_session_idle_timeout',
        'remote_browser_max_sessions',
        'remote_browser_geometry',
        'remote_browser_ssh_timeout',
        'remote_browser_ssh_attempts',
        'remote_browser_kasm_create_timeout',
        'remote_browser_homepage',
        'remote_browser_language',
    ]
