from django.db.models.signals import post_save, post_delete, post_migrate
from django.dispatch import receiver
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import ServiceAuthorizedKeys

from tunnels.consumers import send_notification_to_users


@receiver(post_save, sender=ReverseServerAuthorizedKeys)
@receiver(post_delete, sender=ReverseServerAuthorizedKeys)
def notify_reverse_server_authorized_keys_changed(sender, instance, **kwargs):
    """Send WebSocket notification when a reverse server key is created/updated/deleted."""
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


@receiver(post_migrate)
def insert_initial_public_key(sender, **kwargs):
    """Seed or update the web-service SSH public key on every migration.

    The backend's SSH keypair may be regenerated on container rebuild,
    so we must update the stored key to stay in sync.
    """
    service_name = "web-service"
    with open('/root/.ssh/id_rsa.pub', 'r') as f:
        public_key = f.read().strip()

    obj, created = ServiceAuthorizedKeys.objects.update_or_create(
        service=service_name,
        defaults={
            'key': public_key,
            'description': "Public key for web service to connect with the SSH server",
        },
    )
    if created:
        print(f"[authorized_keys] Created service key for '{service_name}'")
    else:
        print(f"[authorized_keys] Updated service key for '{service_name}'")
