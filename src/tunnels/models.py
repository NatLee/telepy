from django.db import models
from django.contrib.auth.models import User
from authorized_keys.models import ReverseServerAuthorizedKeys

class TunnelSharing(models.Model):
    """
    Model to track tunnel sharing between users.
    A tunnel owner can share their tunnel with other users.
    """
    tunnel = models.ForeignKey(
        ReverseServerAuthorizedKeys,
        on_delete=models.CASCADE,
        related_name='shared_with',
        verbose_name='Shared Tunnel'
    )
    shared_by = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='tunnels_shared_by_me',
        verbose_name='Shared By'
    )
    shared_with = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='shared_tunnels_with_me',
        verbose_name='Shared With'
    )
    can_edit = models.BooleanField(
        default=False,
        verbose_name='Can Edit',
        help_text='Whether the shared user can edit tunnel settings'
    )
    shared_at = models.DateTimeField(auto_now_add=True, verbose_name='Shared At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    class Meta:
        verbose_name = 'Tunnel Sharing'
        verbose_name_plural = 'Tunnel Sharings'
        unique_together = ('tunnel', 'shared_with')

    def __str__(self):
        return f'{self.tunnel.host_friendly_name} shared by {self.shared_by.username} with {self.shared_with.username}'
