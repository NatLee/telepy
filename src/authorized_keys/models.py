from django.db import models

class ReverseServerAuthorizedKeys(models.Model):
    # Reverse Server Authorized Keys for endpoint to connect with this SSH server

    hostname = models.CharField(max_length=128, unique=True, verbose_name='Host Name')
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False, verbose_name='SSH Key (public)')
    reverse_port = models.PositiveIntegerField(blank=False, null=False, unique=True, verbose_name='Reverse Port')
    description = models.TextField(blank=True, null=True, verbose_name='Description')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[R][{self.hostname}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'Reverse Server Key'
        verbose_name_plural = 'Reverse Server Keys'

class ReverseServerUsernames(models.Model):
    # Reverse Server Usernames for endpoint to connect with this SSH server

    reverse_server = models.ForeignKey(ReverseServerAuthorizedKeys, on_delete=models.CASCADE, verbose_name='Reverse Server')
    username = models.CharField(max_length=128, verbose_name='Username')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[R][{self.username}]'

    class Meta:
        verbose_name = 'Reverse Server Username'
        verbose_name_plural = 'Reverse Server Usernames'
        # Unique together
        unique_together = ('reverse_server', 'username')

class ServiceAuthorizedKeys(models.Model):
    # Service Authorized Keys used to check service on the SSH server

    service = models.CharField(max_length=128, unique=True, verbose_name='Service Name')
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False, verbose_name='SSH Key (public)')
    description = models.TextField(blank=True, null=True, verbose_name='Description')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[S][{self.service}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'Service Key'
        verbose_name_plural = 'Service Keys'

class UserAuthorizedKeys(models.Model):
    # User Authorized Keys for reversed SSH tunnel (user to connect with endpoints)
    # User also can access the SSH server using the private key

    hostname = models.CharField(max_length=128, unique=True, verbose_name='Host Name')
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False, verbose_name='SSH Key (public)')
    description = models.TextField(blank=True, null=True, verbose_name='Description')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[U][{self.hostname}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'User Keys'
        verbose_name_plural = 'User Keys'
