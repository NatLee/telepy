from ast import literal_eval

from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis

from tunnels.consumers import send_notification_to_group
class Command(BaseCommand):
    help = "Get and update the ssh server usage ports from the ss command output."

    def add_arguments(self, parser):
        parser.add_argument('ports', type=str, help="The list of ports to compare with the activated ports.")

    def handle(self, *args, **options):
        activated_ports = get_ss_output_from_redis()
        previous_activated_ports = literal_eval(options['ports'])

        # Compare the activated ports with the previous activated ports
        ports_new_activated = list(set(activated_ports) - set(previous_activated_ports))
        ports_new_deactivated = list(set(previous_activated_ports) - set(activated_ports))

        if set(activated_ports) == set(previous_activated_ports):
            self.stdout.write(self.style.SUCCESS(f"Activated ports: {activated_ports}"))
            self.stdout.write(self.style.SUCCESS(f"Previous activated ports: {previous_activated_ports}"))
            self.stdout.write(self.style.SUCCESS("No new activated or deactivated ports"))
            return

        # Send notification for the updated reverse server status
        send_notification_to_group(message={
            "action": "UPDATE-TUNNEL-STATUS-DATA",
            "data": activated_ports,
            "details": "Reverse server status have been updated",
        })

        # Send notification for each port that have been connected or disconnected
        for port in ports_new_deactivated:
            send_notification_to_group(message={
                "action": "UPDATE-TUNNEL-STATUS",
                "details": f"Port [{port}] have been disconnected",
            })
        for port in ports_new_activated:
            send_notification_to_group(message={
                "action": "UPDATE-TUNNEL-STATUS",
                "details": f"Port [{port}] have been connected",
            })

        self.stdout.write(self.style.SUCCESS(f"Activated ports: {activated_ports}"))
        self.stdout.write(self.style.SUCCESS(f"Previous activated ports: {previous_activated_ports}"))
        self.stdout.write(self.style.WARNING(f"New activated ports: {ports_new_activated}"))
        self.stdout.write(self.style.NOTICE(f"New deactivated ports: {ports_new_deactivated}"))

