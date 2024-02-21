from django.db import models

class ReverseServerAuthorizedKeys(models.Model):
    # Reverse Server Authorized Keys for endpoint to connect with this SSH server

    hostname = models.CharField(max_length=128, unique=True)
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False) # SSH Key (public)

    description = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'[{self.hostname}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'Reverse Server Authorized Key'
        verbose_name_plural = 'Reverse Server Authorized Keys'

class UserAuthorizedKeys(models.Model):
    # User Authorized Keys for reversed SSH tunnel

    hostname = models.CharField(max_length=128, unique=True)
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False) # SSH Key (public)

    description = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'[{self.hostname}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'User Authorized Key'
        verbose_name_plural = 'User Authorized Keys'
