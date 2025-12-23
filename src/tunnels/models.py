from django.db import models
from django.contrib.auth.models import User
from authorized_keys.models import ReverseServerAuthorizedKeys
from django.core.exceptions import PermissionDenied

class TunnelPermission(models.Model):
    """
    Base permission model for different access levels.
    """
    VIEW = 'view'
    EDIT = 'edit'
    ADMIN = 'admin'

    PERMISSION_CHOICES = [
        (VIEW, 'View Only'),
        (EDIT, 'Edit'),
        (ADMIN, 'Admin'),
    ]

    permission_type = models.CharField(
        max_length=10,
        choices=PERMISSION_CHOICES,
        default=VIEW
    )

    class Meta:
        abstract = True

    def can_view(self):
        return True

    def can_edit(self):
        return self.permission_type in [self.EDIT, self.ADMIN]

    def can_admin(self):
        return self.permission_type == self.ADMIN

class TunnelSharing(TunnelPermission):
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
    shared_at = models.DateTimeField(auto_now_add=True, verbose_name='Shared At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    class Meta:
        verbose_name = 'Tunnel Sharing'
        verbose_name_plural = 'Tunnel Sharings'
        unique_together = ('tunnel', 'shared_with')

    def __str__(self):
        return f'{self.tunnel.host_friendly_name} shared by {self.shared_by.username} with {self.shared_with.username} ({self.get_permission_type_display()})'

    @property
    def can_edit(self):
        """Backward compatibility property - checks if user can edit"""
        return self.permission_type in [self.EDIT, self.ADMIN]

    @can_edit.setter
    def can_edit(self, value):
        """Backward compatibility setter"""
        if value:
            self.permission_type = self.EDIT
        else:
            self.permission_type = self.VIEW


class PermissionGroup:
    """
    Represents a group of permissions that can be assigned together.
    This enables extensible permission management.
    """
    def __init__(self, name, permissions, description=""):
        self.name = name
        self.permissions = set(permissions)  # Set of permission types
        self.description = description

    def has_permission(self, permission_type):
        return permission_type in self.permissions

    def __str__(self):
        return f"PermissionGroup({self.name}: {self.permissions})"


class PermissionRegistry:
    """
    Registry for managing permission groups and their definitions.
    Enables easy extension of permission system.
    """
    _groups = {}

    @classmethod
    def register_group(cls, group):
        """Register a new permission group"""
        cls._groups[group.name] = group

    @classmethod
    def get_group(cls, name):
        """Get a permission group by name"""
        return cls._groups.get(name)

    @classmethod
    def get_all_groups(cls):
        """Get all registered permission groups"""
        return cls._groups.values()

    @classmethod
    def get_permissions_for_group(cls, group_name):
        """Get permissions for a specific group"""
        group = cls.get_group(group_name)
        return group.permissions if group else set()


# Register default permission groups
PermissionRegistry.register_group(PermissionGroup(
    'viewer',
    [TunnelPermission.VIEW],
    'Can only view tunnel configurations'
))

PermissionRegistry.register_group(PermissionGroup(
    'editor',
    [TunnelPermission.VIEW, TunnelPermission.EDIT],
    'Can view and edit tunnel configurations'
))

PermissionRegistry.register_group(PermissionGroup(
    'admin',
    [TunnelPermission.VIEW, TunnelPermission.EDIT, TunnelPermission.ADMIN],
    'Full access including administration'
))


class TunnelPermissionManager:
    """
    Centralized permission manager for tunnel access control.
    Provides unified permission checking across the application.
    """

    @staticmethod
    def get_user_permissions_for_tunnel(user, tunnel):
        """
        Get the effective permissions a user has for a tunnel.

        Returns a TunnelPermissionInstance with the user's effective permissions,
        or None if user has no access.
        """
        # If user owns the tunnel, they have full admin permissions
        if tunnel.user == user:
            return TunnelPermissionInstance(TunnelPermission.ADMIN)

        # Check if tunnel is shared with the user
        sharing = TunnelSharing.objects.filter(
            tunnel=tunnel,
            shared_with=user
        ).first()

        if sharing:
            return TunnelPermissionInstance(sharing.permission_type)

        return None

    @staticmethod
    def check_access(user, tunnel, required_permission=TunnelPermission.VIEW):
        """
        Check if user has the required permission level for a tunnel.

        Args:
            user: User instance
            tunnel: ReverseServerAuthorizedKeys instance
            required_permission: Required permission level (VIEW, EDIT, ADMIN)

        Returns:
            bool: True if user has access, False otherwise
        """
        permissions = TunnelPermissionManager.get_user_permissions_for_tunnel(user, tunnel)
        if permissions is None:
            return False

        permission_levels = {
            TunnelPermission.VIEW: 1,
            TunnelPermission.EDIT: 2,
            TunnelPermission.ADMIN: 3
        }

        required_level = permission_levels.get(required_permission, 0)
        user_level = permission_levels.get(permissions.permission_type, 0)

        return user_level >= required_level

    @staticmethod
    def check_group_access(user, tunnel, group_name):
        """
        Check if user has permissions equivalent to a permission group.

        Args:
            user: User instance
            tunnel: ReverseServerAuthorizedKeys instance
            group_name: Name of the permission group

        Returns:
            bool: True if user has equivalent permissions
        """
        group_permissions = PermissionRegistry.get_permissions_for_group(group_name)
        if not group_permissions:
            return False

        user_permissions = TunnelPermissionManager.get_user_permissions_for_tunnel(user, tunnel)
        if user_permissions is None:
            return False

        # Check if user has all permissions required by the group
        return user_permissions.permission_type in group_permissions

    @staticmethod
    def require_access(user, tunnel, required_permission=TunnelPermission.VIEW, raise_exception=True):
        """
        Require that user has the specified permission level for a tunnel.

        Args:
            user: User instance
            tunnel: ReverseServerAuthorizedKeys instance
            required_permission: Required permission level
            raise_exception: Whether to raise PermissionDenied if access denied

        Returns:
            TunnelPermissionInstance or None

        Raises:
            PermissionDenied: If raise_exception=True and user lacks permission
        """
        permissions = TunnelPermissionManager.get_user_permissions_for_tunnel(user, tunnel)
        if permissions is None:
            if raise_exception:
                raise PermissionDenied("You don't have access to this tunnel.")
            return None

        if not TunnelPermissionManager.check_access(user, tunnel, required_permission):
            if raise_exception:
                raise PermissionDenied(f"You need {required_permission} permission for this tunnel.")
            return None

        return permissions

    @staticmethod
    def require_group_access(user, tunnel, group_name, raise_exception=True):
        """
        Require that user has permissions equivalent to a permission group.

        Args:
            user: User instance
            tunnel: ReverseServerAuthorizedKeys instance
            group_name: Name of the permission group
            raise_exception: Whether to raise PermissionDenied if access denied

        Returns:
            TunnelPermissionInstance or None

        Raises:
            PermissionDenied: If raise_exception=True and user lacks permission
        """
        if not TunnelPermissionManager.check_group_access(user, tunnel, group_name):
            if raise_exception:
                raise PermissionDenied(f"You need {group_name} permissions for this tunnel.")
            return None

        return TunnelPermissionManager.get_user_permissions_for_tunnel(user, tunnel)


class TunnelPermissionInstance:
    """
    A lightweight object representing a user's permissions for a tunnel.
    """

    def __init__(self, permission_type):
        self.permission_type = permission_type

    def can_view(self):
        return True

    def can_edit(self):
        return self.permission_type in [TunnelPermission.EDIT, TunnelPermission.ADMIN]

    def can_admin(self):
        return self.permission_type == TunnelPermission.ADMIN

    def __str__(self):
        return f"TunnelPermissionInstance({self.permission_type})"
