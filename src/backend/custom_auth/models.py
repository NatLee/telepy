from django.db import models
from django.contrib.auth.models import User

class SocialAccount(models.Model):
    provider = models.CharField(
        max_length=200, default="google", verbose_name="提供者"
    )
    unique_id = models.CharField(verbose_name="唯一ID", max_length=200)
    user = models.ForeignKey(
        User, verbose_name="使用者", related_name="social", on_delete=models.CASCADE
    )

    class Meta:
        db_table = "social_account"
        verbose_name_plural = "第三方登入"
