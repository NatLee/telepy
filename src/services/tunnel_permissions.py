"""
Tunnel Permissions Service Layer

This module provides high-level business logic for tunnel permission management,
including sharing, unsharing, and permission updates.
"""

from django.contrib.auth.models import User
from django.db import transaction
from authorized_keys.models import ReverseServerAuthorizedKeys, ReverseServerUsernames
from tunnels.models import TunnelSharing, TunnelPermission, TunnelPermissionManager


class TunnelPermissionService:
    """
    Service layer for tunnel permission business logic.
    Handles complex operations like sharing, unsharing, and permission management.
    """

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

            # Don't allow sharing with the tunnel owner
            if shared_with == tunnel.user:
                return {'success': False, 'error': 'Cannot share tunnel with its owner'}

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
