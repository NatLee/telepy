from typing import List

from django.db.models.signals import post_save, post_delete, post_migrate
from django.dispatch import receiver
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ServiceAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys

from tunnels.consumers import send_notification_to_users
from tunnels.models import TunnelPermissionManager
from django.contrib.auth.models import User

def get_authorized_keys() -> List[str]:
    # Get service keys
    service_keys = ServiceAuthorizedKeys.objects.all().values_list('key', flat=True)
    # Get reverse server keys
    reverse_keys = ReverseServerAuthorizedKeys.objects.all().values_list('key', flat=True)
    # Get user keys
    user_keys = UserAuthorizedKeys.objects.all().values_list('key', flat=True)
    # Merge keys
    keys = list(service_keys) + list(reverse_keys) + list(user_keys)
    return keys

def update_authorized_keys_file(keys: List[str]):
    authorized_keys_content = "\n".join(keys)
    with open('/ssh/authorized_keys', 'w') as f:
        f.write(authorized_keys_content)

# Update the authorized_keys file on startup
@receiver(post_migrate)
def update_authorized_keys_on_startup(sender, **kwargs):
    if sender.name != 'authorized_keys':
        return
    try:
        keys = get_authorized_keys()
        update_authorized_keys_file(keys)
    except Exception as e:
        print(f"Error updating authorized_keys file: {e}")

@receiver(post_save, sender=ReverseServerAuthorizedKeys)
@receiver(post_delete, sender=ReverseServerAuthorizedKeys)
def update_reverse_server_authorized_keys(sender, instance, **kwargs):
    keys = get_authorized_keys()
    update_authorized_keys_file(keys)

    # Find all users who have access to this tunnel
    authorized_users = set()

    # Owner always has access
    authorized_users.add(instance.user.id)

    # Find users who have been granted access via sharing
    from tunnels.models import TunnelSharing
    sharings = TunnelSharing.objects.filter(tunnel=instance).select_related('shared_with')
    for sharing in sharings:
        authorized_users.add(sharing.shared_with.id)

    # Send notification only to users who have access to this tunnel
    if authorized_users:
        print(f"Sending UPDATED-TUNNELS notification to users {list(authorized_users)} for tunnel {instance.id}")
        send_notification_to_users(
            list(authorized_users),
            {
                "action": "UPDATED-TUNNELS",
                "details": f"Tunnel '{instance.host_friendly_name}' has been updated",
                "tunnel_id": instance.id
            }
        )


@receiver(post_save, sender=ServiceAuthorizedKeys)
@receiver(post_delete, sender=ServiceAuthorizedKeys)
def update_service_authorized_keys(sender, **kwargs):
    keys = get_authorized_keys()
    update_authorized_keys_file(keys)

@receiver(post_save, sender=UserAuthorizedKeys)
@receiver(post_delete, sender=UserAuthorizedKeys)
def update_user_authorized_keys(sender, **kwargs):
    keys = get_authorized_keys()
    update_authorized_keys_file(keys)

@receiver(post_migrate)
def insert_initial_public_key(sender, **kwargs):
    if sender.name != 'authorized_keys':
        return
    # Define the service name
    service_name = "web-service"
    try:
        with open('/root/.ssh/id_rsa.pub', 'r') as f:
            public_key = f.read().strip()
    except (FileNotFoundError, PermissionError):
        # For testing environment
        public_key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD..."

    try:
        # Check if the service key exists
        if not ServiceAuthorizedKeys.objects.filter(key=public_key).exists():
            ServiceAuthorizedKeys.objects.create(
                service=service_name,
                key=public_key,
                description="Initial public key for web service to connect with the SSH server"
            )
    except Exception:
        pass
