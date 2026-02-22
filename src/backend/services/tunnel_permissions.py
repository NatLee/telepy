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
    def get_allowed_usernames(user: User, tunnel: ReverseServerAuthorizedKeys):
        """
        Returns a QuerySet of all ReverseServerUsernames the given user is allowed
        to access on the given tunnel.
        """
        from django.db.models import Q
        
        all_usernames = ReverseServerUsernames.objects.filter(reverse_server=tunnel)

        # 1. Owner or Admin check -> Full access
        if tunnel.user == user or TunnelPermissionManager.check_access(user, tunnel, TunnelPermission.ADMIN):
            return all_usernames

        # 2. Check sharing for non-owners/non-admins
        sharing = TunnelSharing.objects.filter(tunnel=tunnel, shared_with=user).first()
        if not sharing:
            # Not shared -> no access
            return all_usernames.none()

        # 3. If shared, check restricted allowed usernames
        from tunnels.models import TunnelSharingAllowedUsername
        allowed = TunnelSharingAllowedUsername.objects.filter(
            tunnel_sharing=sharing
        ).values_list('reverse_server_username_id', flat=True)

        if allowed.exists():
            # explicitly allowed OR self-created
            return all_usernames.filter(Q(id__in=allowed) | Q(user=user))
        else:
            # explicitly allowed list is empty -> ONLY self-created
            return all_usernames.filter(user=user)

    @staticmethod
    def _transfer_usernames_to_owner(tunnel, user):
        """
        Transfer all Target Server Usernames created by `user` for `tunnel` to the tunnel owner.
        If the owner already has a username with the same name, delete the duplicate instead.
        """
        owner = tunnel.user
        if owner == user:
            return  # Owner's usernames stay as-is

        user_usernames = ReverseServerUsernames.objects.filter(
            reverse_server=tunnel,
            user=user
        )
        for uname in user_usernames:
            # Check if the owner already has one with the same name
            owner_has_same = ReverseServerUsernames.objects.filter(
                reverse_server=tunnel,
                user=owner,
                username=uname.username
            ).exists()
            if owner_has_same:
                # Delete the duplicate
                uname.delete()
            else:
                # Transfer to owner
                uname.user = owner
                uname.save(update_fields=['user'])

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

            # Send notification to the owner as well (if the owner didn't share it)
            if tunnel.user.id != shared_by.id:
                print(f"Sending TUNNEL-SHARED notification to owner {tunnel.user.id} for tunnel {tunnel_id}")
                send_notification_to_user(tunnel.user.id, {
                    'action': 'TUNNEL-SHARED',
                    'details': f'{shared_by.username} shared your tunnel "{tunnel.host_friendly_name}" with {shared_with.username}',
                    'tunnel_id': tunnel_id,
                    'shared_with': shared_with.username,
                    'permission_type': permission_type
                })

            # Silently notify the user who performed the action so their UI updates
            send_notification_to_user(shared_by.id, {
                'action': 'TUNNEL-SHARED',
                'tunnel_id': tunnel_id
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

            # Allow the shared_with user to remove themselves (self-unshare / leave)
            is_self_unshare = (shared_by.id == shared_with_user_id)

            # Check if shared_by has permission to manage sharing for this tunnel
            # OR if the user is removing themselves
            if not is_self_unshare and not TunnelPermissionManager.check_share_access(shared_by, tunnel):
                return {'success': False, 'error': 'You do not have permission to manage sharing for this tunnel'}

            # Get and delete the sharing record
            sharing = TunnelSharing.objects.get(
                tunnel=tunnel,
                shared_with_id=shared_with_user_id
            )

            # Store sharing info before deletion for notification
            shared_with = sharing.shared_with
            tunnel_name = sharing.tunnel.host_friendly_name

            # Transfer Target Server Usernames created by this user to the owner
            TunnelPermissionService._transfer_usernames_to_owner(tunnel, shared_with)

            sharing.delete()

            # Send notification to the user whose access was revoked
            if not is_self_unshare:
                print(f"Sending TUNNEL-UNSHARED notification to user {shared_with.id} for tunnel {tunnel_id}")
                send_notification_to_user(shared_with.id, {
                    'action': 'TUNNEL-UNSHARED',
                    'details': f'Access to tunnel "{tunnel_name}" has been revoked by {shared_by.username}',
                    'tunnel_id': tunnel_id,
                    'revoked_by': shared_by.username
                })

            # Send notification to the owner as well
            if tunnel.user.id != shared_by.id:
                print(f"Sending TUNNEL-UNSHARED notification to owner {tunnel.user.id} for tunnel {tunnel_id}")
                action_str = "left" if is_self_unshare else f"revoked access from {shared_with.username} for"
                send_notification_to_user(tunnel.user.id, {
                    'action': 'TUNNEL-UNSHARED',
                    'details': f'{shared_by.username} {action_str} your tunnel "{tunnel_name}"',
                    'tunnel_id': tunnel_id,
                    'revoked_from': shared_with.username
                })

            # Silently notify the user who performed the action to update their UI
            send_notification_to_user(shared_by.id, {
                'action': 'TUNNEL-UNSHARED',
                'tunnel_id': tunnel_id
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

            # If downgraded to view-only, transfer their Target Server Usernames to owner
            if permission_type == TunnelPermission.VIEW and old_permission in [TunnelPermission.EDIT, TunnelPermission.ADMIN]:
                TunnelPermissionService._transfer_usernames_to_owner(tunnel, sharing.shared_with)

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

            # Send notification to the owner as well
            if tunnel.user.id != shared_by.id:
                print(f"Sending TUNNEL-PERMISSION-UPDATED notification to owner {tunnel.user.id} for tunnel {tunnel_id}")
                send_notification_to_user(tunnel.user.id, {
                    'action': 'TUNNEL-PERMISSION-UPDATED',
                    'details': f'{shared_by.username} updated permission for your tunnel "{sharing.tunnel.host_friendly_name}" to "{permission_display}" for {sharing.shared_with.username}',
                    'tunnel_id': tunnel_id,
                    'updated_for': sharing.shared_with.username,
                    'old_permission': old_permission,
                    'new_permission': permission_type
                })

            # Silently notify the user who performed the action to update their UI
            send_notification_to_user(shared_by.id, {
                'action': 'TUNNEL-PERMISSION-UPDATED',
                'tunnel_id': tunnel_id
            })

            return {'success': True, 'message': 'Sharing permission updated successfully'}

        except ReverseServerAuthorizedKeys.DoesNotExist:
            return {'success': False, 'error': 'Tunnel not found or access denied'}
        except TunnelSharing.DoesNotExist:
            return {'success': False, 'error': 'Sharing not found'}
        except Exception as e:
            return {'success': False, 'error': str(e)}
