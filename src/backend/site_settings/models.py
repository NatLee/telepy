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

    remote_browser_max_sessions = models.IntegerField(
        default=10,
        verbose_name="Remote Browser Max Concurrent Sessions",
        help_text="Maximum number of concurrent proxy-browser sessions (0 = unlimited).",
    )

    remote_browser_geometry = models.CharField(
        max_length=32,
        default="1280x720",
        verbose_name="Remote Browser Screen Geometry",
        help_text="Xvnc display geometry (e.g. 1280x720) for each KasmVNC "
                  "proxy-browser session.",
    )

    @classmethod
    def get_solo(cls):
        # `get_or_create` will create a new object if it doesn't exist
        # Here is keeping only one object of this type
        obj, created = cls.objects.get_or_create(pk=1)
        return obj

