from django.db.models.signals import post_migrate
from django.dispatch import receiver
from site_settings.models import SiteSettings

@receiver(post_migrate)
def create_default_site_settings(sender, **kwargs):
    if sender.name != 'site_settings':
        return
    SiteSettings.get_solo()  # This will create the default settings if it doesn't exist
