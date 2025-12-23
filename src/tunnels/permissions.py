from django.contrib.auth.models import User
from django.db import transaction
from authorized_keys.models import ReverseServerAuthorizedKeys, ReverseServerUsernames
from .models import TunnelSharing, TunnelPermission

class TunnelPermissionService:
    """
    Centralized service for managing tunnel permissions.
    Follows polymorphism principles with different permission strategies.
    """

    @staticmethod
    def check_tunnel_access(user: User, tunnel_id: int) -> tuple[bool, ReverseServerAuthorizedKeys | None]:
        """
        Check if user has access to a tunnel.
        Returns (has_access, tunnel_object)
        """
        # First check if user owns the tunnel
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id, user=user)
            return True, tunnel
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        # Check if tunnel is shared with the user
        try:
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id)
            sharing = TunnelSharing.objects.filter(
                tunnel=tunnel,
                shared_with=user
            ).first()
            if sharing:
                return True, tunnel
        except ReverseServerAuthorizedKeys.DoesNotExist:
            pass

        return False, None

    @staticmethod
    def check_tunnel_edit_permission(user: User, tunnel: ReverseServerAuthorizedKeys) -> bool:
        """
        Check if user can edit a tunnel (ownership or edit permission).
        """
        # If user owns the tunnel, they can always edit
        if tunnel.user == user:
            return True

        # Check if tunnel is shared with edit permission
        sharing = TunnelSharing.objects.filter(
            tunnel=tunnel,
            shared_with=user
        ).first()

        # Check if sharing has edit or admin permission
        if sharing:
            return sharing.permission_type in [TunnelPermission.EDIT, TunnelPermission.ADMIN]

        return False

    @staticmethod
    def check_username_edit_permission(user: User, username_obj: ReverseServerUsernames) -> bool:
        """
        Check if user can edit a username (must have edit permission on the tunnel).
        """
        return TunnelPermissionService.check_tunnel_edit_permission(user, username_obj.reverse_server)

    @staticmethod
    @transaction.atomic
    def share_tunnel(shared_by: User, tunnel_id: int, shared_with_user_id: int, permission_type: str = 'view') -> dict:
        """
        Share a tunnel with another user with specified permission level.
        Returns dict with success status and message.
        """
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id)

            # Check if shared_by has permission to share this tunnel
            from .models import TunnelPermissionManager
            if not TunnelPermissionManager.check_share_access(shared_by, tunnel):
                return {'success': False, 'error': 'You do not have permission to share this tunnel'}

            # Get the user to share with
            shared_with = User.objects.get(id=shared_with_user_id)

            # Validate permission type
            if permission_type not in [TunnelPermission.VIEW, TunnelPermission.EDIT, TunnelPermission.ADMIN]:
                return {'success': False, 'error': 'Invalid permission type'}

            # Check if already shared
            existing_share = TunnelSharing.objects.filter(
                tunnel=tunnel,
                shared_with=shared_with
            ).first()

            if existing_share:
                return {'success': False, 'error': 'Tunnel already shared with this user'}

            # Don't allow sharing with self
            if shared_with == shared_by:
                return {'success': False, 'error': 'Cannot share tunnel with yourself'}

            # Create the sharing record
            TunnelSharing.objects.create(
                tunnel=tunnel,
                shared_by=shared_by,
                shared_with=shared_with,
                permission_type=permission_type
            )

            return {'success': True, 'message': 'Tunnel shared successfully'}

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return {'success': False, 'error': 'Tunnel not found or access denied'}
        except User.DoesNotExist:
            return {'success': False, 'error': 'User not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @staticmethod
    @transaction.atomic
    def unshare_tunnel(shared_by: User, tunnel_id: int, shared_with_user_id: int) -> dict:
        """
        Remove sharing of a tunnel from a user.
        """
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id)

            # Check if shared_by has permission to manage sharing for this tunnel
            from .models import TunnelPermissionManager
            if not TunnelPermissionManager.check_share_access(shared_by, tunnel):
                return {'success': False, 'error': 'You do not have permission to manage sharing for this tunnel'}

            # Get and delete the sharing record
            sharing = TunnelSharing.objects.get(
                tunnel=tunnel,
                shared_with_id=shared_with_user_id
            )

            sharing.delete()
            return {'success': True, 'message': 'Tunnel unshared successfully'}

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return {'success': False, 'error': 'Tunnel not found or access denied'}
        except TunnelSharing.DoesNotExist:
            return {'success': False, 'error': 'Sharing not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    @staticmethod
    @transaction.atomic
    def update_sharing_permission(shared_by: User, tunnel_id: int, shared_with_user_id: int, permission_type: str) -> dict:
        """
        Update sharing permission for a user.
        """
        try:
            # Get the tunnel
            tunnel = ReverseServerAuthorizedKeys.objects.get(id=tunnel_id)

            # Check if shared_by has permission to manage sharing for this tunnel
            from .models import TunnelPermissionManager
            if not TunnelPermissionManager.check_share_access(shared_by, tunnel):
                return {'success': False, 'error': 'You do not have permission to manage sharing for this tunnel'}

            # Get the sharing record
            sharing = TunnelSharing.objects.get(
                tunnel=tunnel,
                shared_with_id=shared_with_user_id
            )

            # Validate permission type
            if permission_type not in [TunnelPermission.VIEW, TunnelPermission.EDIT, TunnelPermission.ADMIN]:
                return {'success': False, 'error': 'Invalid permission type'}

            # Update permission
            sharing.permission_type = permission_type
            sharing.save()

            return {'success': True, 'message': 'Sharing permission updated successfully'}

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return {'success': False, 'error': 'Tunnel not found or access denied'}
        except TunnelSharing.DoesNotExist:
            return {'success': False, 'error': 'Sharing not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

class PermissionMixin:
    """
    Mixin to provide permission checking methods to views.
    """

    def check_tunnel_access(self, tunnel_id: int) -> tuple[bool, ReverseServerAuthorizedKeys | None]:
        """Check if current user has access to tunnel"""
        return TunnelPermissionService.check_tunnel_access(self.request.user, tunnel_id)

    def check_tunnel_edit_permission(self, tunnel: ReverseServerAuthorizedKeys) -> bool:
        """Check if current user can edit tunnel"""
        return TunnelPermissionService.check_tunnel_edit_permission(self.request.user, tunnel)

    def check_username_edit_permission(self, username_obj: ReverseServerUsernames) -> bool:
        """Check if current user can edit username"""
        return TunnelPermissionService.check_username_edit_permission(self.request.user, username_obj)


class ConsumerPermissionMixin:
    """
    Mixin to provide permission checking methods to WebSocket consumers.
    """

    def check_tunnel_access_sync(self, user, tunnel_id: int) -> tuple[bool, ReverseServerAuthorizedKeys | None]:
        """Check if user has access to tunnel (synchronous version for consumers)"""
        return TunnelPermissionService.check_tunnel_access(user, tunnel_id)
