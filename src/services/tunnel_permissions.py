"""
Tunnel Permissions Service Layer

This module provides high-level business logic for tunnel permission management,
including sharing, unsharing, and permission updates.
"""

from django.contrib.auth.models import User
from django.db import transaction
from authorized_keys.models import ReverseServerAuthorizedKeys, ReverseServerUsernames
from tunnels.models import TunnelSharing, TunnelPermission, TunnelPermissionManager
from tunnels.consumers import send_notification_to_user


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

            # Send notification to the shared user
            print(f"Sending TUNNEL-SHARED notification to user {shared_with.id} for tunnel {tunnel_id}")
            send_notification_to_user(shared_with.id, {
                'action': 'TUNNEL-SHARED',
                'details': f'Tunnel "{tunnel.host_friendly_name}" has been shared with you by {shared_by.username}',
                'tunnel_id': tunnel_id,
                'shared_by': shared_by.username,
                'permission_type': permission_type
            })

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

            # Store sharing info before deletion for notification
            shared_with = sharing.shared_with
            tunnel_name = sharing.tunnel.host_friendly_name

            sharing.delete()

            # Send notification to the user whose access was revoked
            print(f"Sending TUNNEL-UNSHARED notification to user {shared_with.id} for tunnel {tunnel_id}")
            send_notification_to_user(shared_with.id, {
                'action': 'TUNNEL-UNSHARED',
                'details': f'Access to tunnel "{tunnel_name}" has been revoked by {shared_by.username}',
                'tunnel_id': tunnel_id,
                'revoked_by': shared_by.username
            })

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
            old_permission = sharing.permission_type
            sharing.permission_type = permission_type
            sharing.save()

            # Send notification to the user whose permission was updated
            permission_display = dict(TunnelPermission.PERMISSION_CHOICES).get(permission_type, permission_type)
            print(f"Sending TUNNEL-PERMISSION-UPDATED notification to user {sharing.shared_with.id} for tunnel {tunnel_id}")
            send_notification_to_user(sharing.shared_with.id, {
                'action': 'TUNNEL-PERMISSION-UPDATED',
                'details': f'Your permission for tunnel "{sharing.tunnel.host_friendly_name}" has been updated to "{permission_display}" by {shared_by.username}',
                'tunnel_id': tunnel_id,
                'updated_by': shared_by.username,
                'old_permission': old_permission,
                'new_permission': permission_type
            })

            return {'success': True, 'message': 'Sharing permission updated successfully'}

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return {'success': False, 'error': 'Tunnel not found or access denied'}
        except TunnelSharing.DoesNotExist:
            return {'success': False, 'error': 'Sharing not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
