from django.core.management.base import BaseCommand, CommandError
from authorized_keys.utils import get_ss_output_from_redis

class Command(BaseCommand):
    help = "Update the ssh server usage ports from the ss command output."

    def handle(self, *args, **options):
        get_ss_output_from_redis()
