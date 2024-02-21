from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from authorized_keys.models import AuthorizedKeys
import os

@receiver(post_save, sender=AuthorizedKeys)
@receiver(post_delete, sender=AuthorizedKeys)
def update_authorized_keys(sender, **kwargs):
    keys = AuthorizedKeys.objects.all()
    authorized_keys_content = "\n".join([key.key for key in keys])
    with open(os.path.expanduser('/ssh/authorized_keys'), 'w') as f:
        f.write(authorized_keys_content)
