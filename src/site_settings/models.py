from django.db import models

class SiteSettings(models.Model):
    """
    Site settings model

    This model is used to store site settings.
    """
    allow_registration = models.BooleanField(default=False, verbose_name="Allow registration")

    @classmethod
    def get_solo(cls):
        # `get_or_create` will create a new object if it doesn't exist
        # Here is keeping only one object of this type
        obj, created = cls.objects.get_or_create(pk=1)
        return obj

