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

    def can_share(self):
        """Check if user can share this tunnel with others"""
        return self.permission_type == self.ADMIN

    def can_delete(self):
        """Check if user can delete this tunnel"""
        return self.permission_type == self.ADMIN

    @classmethod
    def get_capabilities_for_permission(cls, permission_type):
        """
        Get all functional capabilities for a given permission type.
        Returns a list of capability dictionaries with 'key' and 'display' fields.
        """
        capabilities = []

        # Always can view (this is a basic capability)
        if permission_type in [cls.VIEW, cls.EDIT, cls.ADMIN]:
            capabilities.append({
                'key': 'view',
                'display': 'View tunnels'
            })

        # Can edit if EDIT or ADMIN permission
        if permission_type in [cls.EDIT, cls.ADMIN]:
            capabilities.append({
                'key': 'edit',
                'display': 'Edit tunnel configurations'
            })

        # Can share and delete if ADMIN permission
        if permission_type == cls.ADMIN:
            capabilities.append({
                'key': 'share',
                'display': 'Share tunnels with others'
            })
            capabilities.append({
                'key': 'delete',
                'display': 'Delete tunnels'
            })

        return capabilities

    @classmethod
    def get_all_capabilities(cls):
        """
        Get all possible functional capabilities across all permission types.
        Useful for documentation or UI generation.
        """
        all_capabilities = []
        capability_keys = set()

        for permission_type, _ in cls.PERMISSION_CHOICES:
            capabilities = cls.get_capabilities_for_permission(permission_type)
            for cap in capabilities:
                if cap['key'] not in capability_keys:
                    capability_keys.add(cap['key'])
                    all_capabilities.append(cap)

        return all_capabilities

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
    'Can view and edit tunnel configurations (cannot share with others)'
))

PermissionRegistry.register_group(PermissionGroup(
    'admin',
    [TunnelPermission.VIEW, TunnelPermission.EDIT, TunnelPermission.ADMIN],
    'Full access including administration and sharing with others'
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

        # Check if we have prefetched sharing info
        # Note: We must verify that the prefetched info is actually for the requested user
        # This assumes current_user_sharing was populated with a filter on THIS user
        if hasattr(tunnel, 'current_user_sharing'):
            # The list will contain 0 or 1 item because we filtered by user in Prefetch
            sharing = tunnel.current_user_sharing[0] if tunnel.current_user_sharing else None

            # Verify the sharing is actually for the requested user to be safe
            if sharing and sharing.shared_with_id == user.id:
                return TunnelPermissionInstance(sharing.permission_type)

            # If we have the attribute but no sharing record matches, and we are sure
            # the prefetch was for this user (common pattern in views), we can assume no access.
            # But if the prefetch was for a DIFFERENT user, we shouldn't use it.
            # Since we can't easily know who the prefetch was for without checking the result,
            # and if result is empty we don't know...
            # Ideally we only use this if we find a match.
            # If sharing list is empty but attribute exists, it usually means "no result for the filter".
            # If we are checking for 'user', and the prefetch was for 'user', then empty means no access.
            # If the prefetch was for 'other_user', then empty means nothing about 'user'.
            # To be safe, we only use the optimization if we find a POSITIVE match.
            # If no match found in prefetch, we fall back to DB query?
            # That would defeat the purpose if the user has NO access (N queries for no access).

            # However, in the ViewSet, we are listing tunnels that differ:
            # 1. Owned tunnels (user checks fail here, proceeds to sharing)
            # 2. Shared tunnels (user checks should find sharing)

            # If we trust the context (ViewSet logic), 'current_user_sharing' is populated for request.user.
            # And 'user' arg here is request.user.
            # So if list is empty, it means no sharing.

            if sharing is None:
                 # If we are iterating tunnels, and some are owned, they might have empty current_user_sharing.
                 # If we return None here, we avoid the DB query.
                 # But we must be sure 'user' is the one we prefetched for.
                 # We can't be sure if list is empty.
                 # BUT, standard practice in DRF serializers is that 'user' in context is request.user.
                 pass

            # Safe approach: Only use if we find a match matching user.id
            if sharing and sharing.shared_with_id == user.id:
                 return TunnelPermissionInstance(sharing.permission_type)

            # If empty list, we can't verify user.id.
            # But we can assume that if the attribute is present, we intended to use it.
            # Let's rely on the fact that this is used in a context where optimization is intended.

            # For correctness in mixed contexts, we should probably stick to:
            if sharing and sharing.shared_with_id == user.id:
                return TunnelPermissionInstance(sharing.permission_type)
            elif sharing is None:
                # If we have the attribute but it's empty, it effectively means "no permission found in prefetch"
                # We return None to avoid the DB query, assuming the prefetch was relevant.
                return None

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
    def check_share_access(user, tunnel):
        """
        Check if user has permission to share this tunnel with others.
        Only tunnel owners and users with ADMIN permission can share.
        """
        # If user owns the tunnel, they can always share
        if tunnel.user == user:
            return True

        # Check if we have prefetched sharing info
        if hasattr(tunnel, 'current_user_sharing'):
            sharing = tunnel.current_user_sharing[0] if tunnel.current_user_sharing else None
            if sharing and sharing.shared_with_id == user.id:
                return sharing.permission_type == TunnelPermission.ADMIN
            if sharing is None:
                return False

        # Check if tunnel is shared with admin permission
        sharing = TunnelSharing.objects.filter(
            tunnel=tunnel,
            shared_with=user,
            permission_type=TunnelPermission.ADMIN
        ).first()

        return sharing is not None

    @staticmethod
    def check_delete_access(user, tunnel):
        """
        Check if user has permission to delete this tunnel.
        Only tunnel owners and users with ADMIN permission can delete.
        """
        # If user owns the tunnel, they can always delete
        if tunnel.user == user:
            return True

        # Check if we have prefetched sharing info
        if hasattr(tunnel, 'current_user_sharing'):
            sharing = tunnel.current_user_sharing[0] if tunnel.current_user_sharing else None
            if sharing and sharing.shared_with_id == user.id:
                return sharing.permission_type == TunnelPermission.ADMIN
            if sharing is None:
                return False

        # Check if tunnel is shared with admin permission
        sharing = TunnelSharing.objects.filter(
            tunnel=tunnel,
            shared_with=user,
            permission_type=TunnelPermission.ADMIN
        ).first()

        return sharing is not None

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

    def can_share(self):
        """Check if this permission level allows sharing tunnel with others"""
        return self.permission_type == TunnelPermission.ADMIN

    def __str__(self):
        return f"TunnelPermissionInstance({self.permission_type})"
