from django.contrib.auth.models import User
from django.db import models


class UserSettings(models.Model):
    """
    每位使用者的個人設定(目前只有介面語言,之後的個人偏好都放這裡)。
    與 SiteSettings(全站)不同,這是跟著使用者走的,登入後前端會套用並跨裝置同步。
    Per-user settings (currently just the UI language; future personal preferences live here too).
    Unlike SiteSettings (site-wide), these follow the user and sync across devices after login.
    """

    LANGUAGE_AUTO = "auto"
    LANGUAGE_CHOICES = [
        (LANGUAGE_AUTO, "Auto (follow browser)"),
        ("en", "English"),
        ("zh-TW", "Traditional Chinese"),
        ("ja", "Japanese"),
    ]

    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name="settings")

    THEME_CHOICES = [
        ("system", "Follow system"),
        ("light", "Light"),
        ("dark", "Dark"),
    ]

    # null = 使用者從未主動選過語言:前端據此決定「用本機偏好回填」而不是覆蓋掉使用者在裝置上的選擇。
    # null = the user never explicitly picked a language; the frontend then pushes its local
    # preference up instead of overwriting the device-side choice with a default.
    language = models.CharField(
        max_length=8,
        choices=LANGUAGE_CHOICES,
        null=True,
        blank=True,
        default=None,
        verbose_name="Interface language",
        help_text="使用者介面語言。auto = 跟隨瀏覽器語言;null = 使用者尚未選擇過。"
                  "UI language. auto = follow the browser; null = never explicitly chosen.",
    )

    theme = models.CharField(
        max_length=8,
        choices=THEME_CHOICES,
        default="system",
        verbose_name="Theme",
        help_text="介面主題:system = 跟隨系統深淺色,light / dark 固定。"
                  "UI theme: system follows the OS light/dark preference.",
    )

    terminal_font_size = models.PositiveSmallIntegerField(
        default=14,
        verbose_name="Terminal font size",
        help_text="網頁終端機(xterm)字型大小(px),前端限制 10–24。"
                  "Web terminal (xterm) font size in px; the frontend clamps to 10–24.",
    )

    class Meta:
        verbose_name = "User settings"
        verbose_name_plural = "User settings"

    def __str__(self):
        return f"Settings for {self.user.username}"

    @classmethod
    def for_user(cls, user):
        # 沒有就建立,確保每個使用者都拿得到設定列。/ Create on first access so every user has a row.
        obj, _created = cls.objects.get_or_create(user=user)
        return obj
