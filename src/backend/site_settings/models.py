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

    remote_browser_cdp_url = models.CharField(
        max_length=255,
        default="http://chromium:9222",
        verbose_name="Remote Browser CDP URL",
        help_text="Chrome DevTools Protocol endpoint of the shared headless Chromium "
                  "(internal to telepy-network; never published to the host).",
    )

    remote_browser_screencast_quality = models.IntegerField(
        default=60,
        verbose_name="Remote Browser Screencast JPEG Quality",
        help_text="JPEG quality (1–100) for CDP Page.startScreencast frames. "
                  "Lower = less bandwidth, softer image.",
    )

    remote_browser_screencast_every_nth_frame = models.IntegerField(
        default=1,
        verbose_name="Remote Browser Screencast Every Nth Frame",
        help_text="Send only every Nth frame (1 = every frame). Raise to cut "
                  "bandwidth/CPU on high-motion pages.",
    )

    @classmethod
    def get_solo(cls):
        # `get_or_create` will create a new object if it doesn't exist
        # Here is keeping only one object of this type
        obj, created = cls.objects.get_or_create(pk=1)
        return obj

