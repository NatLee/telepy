from typing import List

from django.db.models.signals import post_save, post_delete, post_migrate
from django.dispatch import receiver
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ServiceAuthorizedKeys

def get_authorized_keys() -> List[str]:
    # Get service keys
    service_keys = ServiceAuthorizedKeys.objects.all().values_list('key', flat=True)
    # Get reverse server keys
    reverse_keys = ReverseServerAuthorizedKeys.objects.all().values_list('key', flat=True)
    # Merge keys
    keys = list(service_keys) + list(reverse_keys)
    return keys

def update_authorized_keys_file(keys: List[str]):
    authorized_keys_content = "\n".join(keys)
    with open('/ssh/authorized_keys', 'w') as f:
        f.write(authorized_keys_content)

@receiver(post_save, sender=ReverseServerAuthorizedKeys)
@receiver(post_delete, sender=ReverseServerAuthorizedKeys)
def update_reverse_server_authorized_keys(sender, **kwargs):
    keys = get_authorized_keys()
    update_authorized_keys_file(keys)

@receiver(post_save, sender=ServiceAuthorizedKeys)
@receiver(post_delete, sender=ServiceAuthorizedKeys)
def update_service_authorized_keys(sender, **kwargs):
    keys = get_authorized_keys()
    update_authorized_keys_file(keys)

@receiver(post_migrate)
def insert_initial_public_key(sender, **kwargs):
    # Define the service name
    service_name = "web-service"
    with open('/root/.ssh/id_rsa.pub', 'r') as f:
        public_key = f.read().strip()

    # Check if the service key exists
    if not ServiceAuthorizedKeys.objects.filter(key=public_key).exists():
        ServiceAuthorizedKeys.objects.create(
            service=service_name,
            key=public_key,
            description="Initial public key for web service to connect with the SSH server"
        )
