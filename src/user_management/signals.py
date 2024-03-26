from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.auth.models import User
from django.db import transaction

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
