from ast import literal_eval

from django.core.cache import cache
from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis

from tunnels.consumers import send_notification_to_group, send_tunnel_connection_update
class Command(BaseCommand):
    help = "Get and update the ssh server usage ports from the ss command output."

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
        send_notification_to_group(message={
            "action": "UPDATE-TUNNEL-STATUS-DATA",
            "data": list(activated_ports),
            "details": "Reverse server status have been updated",
        })

        new_activated_ports = set()
        new_inactive_ports = set()

        for port, now_status in now_ports.items():
            previous_status = previous_ports.get(port, False)
            # status changed: False -> True (connected)
            if now_status and not previous_status:
                new_activated_ports.add(port)
                send_notification_to_group(message={
                    "action": "UPDATE-TUNNEL-STATUS",
                    "details": f"Port [{port}] have been connected",
                })
                # Send tunnel-specific connection update
                self._send_tunnel_connection_updates(port, True)
                
            # status changed: True -> False (disconnected)
            elif not now_status and previous_status:
                new_inactive_ports.add(port)
                send_notification_to_group(message={
                    "action": "UPDATE-TUNNEL-STATUS",
                    "details": f"Port [{port}] have been disconnected",
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
