from ast import literal_eval

from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis

from tunnels.consumers import send_tunnel_connection_update, send_notification_to_users

class Command(BaseCommand):
    help = "Get and update the SSH server usage ports from the ss command output."

    def handle(self, *args, **options):
        now_ports = get_ss_output_from_redis()
        previous_ports = cache.get("ports_status", {})

        activated_ports = set()
        inactive_ports = set()
        for port, status in now_ports.items():
            if status:
                activated_ports.add(port)
            else:
                inactive_ports.add(port)

        # Compare the activated ports with the previous activated ports
        if now_ports == previous_ports:
            self.stdout.write(self.style.SUCCESS(f"Activated ports: {list(activated_ports)}"))
            self.stdout.write(self.style.SUCCESS(f"Inactivated ports: {list(inactive_ports)}"))
            self.stdout.write(self.style.SUCCESS("No new activated or deactivated ports"))
            return

        # Send notification for the updated reverse server status
        # Send personalized notifications to users based on their tunnel access permissions
        self._send_personalized_status_notifications(activated_ports)

        new_activated_ports = set()
        new_inactive_ports = set()

        for port, now_status in now_ports.items():
            previous_status = previous_ports.get(port, False)
            # status changed: False -> True (connected)
            if now_status and not previous_status:
                new_activated_ports.add(port)
                # Find users who have access to tunnels using this port
                authorized_users = self._get_port_authorized_users(port)
                if authorized_users:
                    send_notification_to_users(authorized_users, {
                        "action": "UPDATE-TUNNEL-STATUS",
                        "details": f"Tunnel on port [{port}] has been connected",
                        "port": port,
                        "status": "connected"
                    })
                # Send tunnel-specific connection update
                self._send_tunnel_connection_updates(port, True)

            # status changed: True -> False (disconnected)
            elif not now_status and previous_status:
                new_inactive_ports.add(port)
                # Find users who have access to tunnels using this port
                authorized_users = self._get_port_authorized_users(port)
                if authorized_users:
                    send_notification_to_users(authorized_users, {
                        "action": "UPDATE-TUNNEL-STATUS",
                        "details": f"Tunnel on port [{port}] has been disconnected",
                        "port": port,
                        "status": "disconnected"
                    })
                # Send tunnel-specific connection update
                self._send_tunnel_connection_updates(port, False)

        # Update the cache with the new activated ports
        cache.set("ports_status", now_ports, None)

        self.stdout.write(self.style.SUCCESS(f"Activated ports: {list(activated_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"Inactivated ports: {list(inactive_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"New activated ports: {list(new_activated_ports)}"))
        self.stdout.write(self.style.SUCCESS(f"New inactivated ports: {list(new_inactive_ports)}"))
        self.stdout.write(self.style.SUCCESS("Successfully updated the ports status"))
    
    def _send_tunnel_connection_updates(self, port, is_connected):
        """Send tunnel connection status updates for a specific port"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            
            # Find tunnels that use this port
            tunnels = ReverseServerAuthorizedKeys.objects.filter(reverse_port=port)
            
            for tunnel in tunnels:
                send_tunnel_connection_update(tunnel.id, {
                    'type': 'connection_status',
                    'tunnel_id': tunnel.id,
                    'reverse_port': port,
                    'is_connected': is_connected,
                    'host_friendly_name': tunnel.host_friendly_name
                })
                
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error sending tunnel connection updates for port {port}: {e}"))

    def _get_port_authorized_users(self, port):
        """Get list of user IDs who have access to tunnels using the specified port"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing

            authorized_users = set()

            # Find tunnels that use this port
            tunnels = ReverseServerAuthorizedKeys.objects.filter(reverse_port=port)

            for tunnel in tunnels:
                # Owner always has access
                authorized_users.add(tunnel.user.id)

                # Find users who have been granted access via sharing
                sharings = TunnelSharing.objects.filter(tunnel=tunnel).select_related('shared_with')
                for sharing in sharings:
                    authorized_users.add(sharing.shared_with.id)

            return list(authorized_users)

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error getting authorized users for port {port}: {e}"))
            return []

    def _get_all_tunnel_authorized_users(self):
        """Get list of user IDs who have access to any tunnels"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing
            from django.contrib.auth.models import User

            authorized_users = set()

            # Get all tunnels
            tunnels = ReverseServerAuthorizedKeys.objects.all()

            for tunnel in tunnels:
                # Owner always has access
                authorized_users.add(tunnel.user.id)

                # Find users who have been granted access via sharing
                sharings = TunnelSharing.objects.filter(tunnel=tunnel).select_related('shared_with')
                for sharing in sharings:
                    authorized_users.add(sharing.shared_with.id)

            return list(authorized_users)

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error getting all authorized users: {e}"))
            return []

    def _send_personalized_status_notifications(self, activated_ports):
        """Send personalized status notifications to users based on their tunnel access"""
        try:
            from authorized_keys.models import ReverseServerAuthorizedKeys
            from tunnels.models import TunnelSharing

            # Group users by their accessible ports
            user_ports_map = {}

            # Get all tunnels and their authorized users
            tunnels = ReverseServerAuthorizedKeys.objects.all().prefetch_related('shared_with')

            for tunnel in tunnels:
                port = tunnel.reverse_port
                if port in activated_ports:
                    # Add owner
                    if tunnel.user.id not in user_ports_map:
                        user_ports_map[tunnel.user.id] = set()
                    user_ports_map[tunnel.user.id].add(port)

                    # Add shared users
                    sharings = TunnelSharing.objects.filter(tunnel=tunnel).select_related('shared_with')
                    for sharing in sharings:
                        user_id = sharing.shared_with.id
                        if user_id not in user_ports_map:
                            user_ports_map[user_id] = set()
                        user_ports_map[user_id].add(port)

            # Send personalized notifications
            from tunnels.consumers import send_notification_to_user
            for user_id, ports in user_ports_map.items():
                send_notification_to_user(user_id, {
                    "action": "UPDATE-TUNNEL-STATUS-DATA",
                    "data": list(ports),  # Only ports they can access
                    "details": "Reverse server status have been updated",
                })

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Error sending personalized status notifications: {e}"))
