from django.db import models

class AuthorizedKeys(models.Model):

    hostname = models.CharField(max_length=128, unique=True)
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False) # SSH Key (public)

    description = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


    def __str__(self):
        return f'[{self.hostname}] {self.key[:5]}...{self.key[-5:]}'

    class Meta:
        verbose_name = 'Authorized Key'
        verbose_name_plural = 'Authorized Keys'