from django.apps import AppConfig


class AuthorizedKeysConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'authorized_keys'

    def ready(self):
        import authorized_keys.signals
        # Call the update_authorized_keys_on_startup function
        authorized_keys.signals.update_authorized_keys_on_startup()