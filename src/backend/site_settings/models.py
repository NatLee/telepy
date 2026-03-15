from django.db import models

class SiteSettings(models.Model):
    """
    Site settings model

    This model is used to store site settings.
    """
    allow_registration = models.BooleanField(default=False, verbose_name="Allow registration")

    # Remote Browser Settings
    remote_browser_session_idle_timeout = models.IntegerField(
        default=60,
        verbose_name="Remote Browser Session Idle Timeout (seconds)",
        help_text="If no ping is received within this duration, the remote browser session will be terminated."
    )

    @classmethod
    def get_solo(cls):
        # `get_or_create` will create a new object if it doesn't exist
        # Here is keeping only one object of this type
        obj, created = cls.objects.get_or_create(pk=1)
        return obj

