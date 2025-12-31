from django.db.models.signals import post_save, pre_save
from django.dispatch import receiver
from django.contrib.auth.models import User
from django.db import transaction
from django.core.exceptions import ValidationError

from site_settings.models import SiteSettings

@receiver(post_save, sender=User)
def make_first_user_as_superuser(sender, instance, created, **kwargs):
    """
    This signal is used to make the first user as superuser
    """
    # Check if the user is created and the user count is 1
    if created and User.objects.count() == 1:
        # Use transaction to avoid multiple users make creation with the same time
        with transaction.atomic():
            instance.is_superuser = True
            instance.is_staff = True
            instance.save()

@receiver(pre_save, sender=User)
def check_user_creation_allowed(sender, instance, **kwargs):
    # 檢查是否為新使用者且使用者數量不為 0
    if not instance.pk and User.objects.count() != 0:
        # 檢查是否允許註冊新使用者
        try:
            settings = SiteSettings.get_solo()
            if not settings.allow_registration:
                # 如果不允許註冊新使用者，則拋出錯誤
                raise ValidationError('Registration is currently disabled.')
        except Exception:
            pass
