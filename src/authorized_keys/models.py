from django.db import models
from django.contrib.auth.models import User

class ReverseServerAuthorizedKeys(models.Model):
    # Reverse Server Authorized Keys for endpoint to connect with this SSH server
    # 反向通道機器的公鑰（用於連線到我們的SSH Server）
    user = models.ForeignKey(User, on_delete=models.CASCADE, verbose_name='User')
    host_friendly_name = models.CharField(max_length=128, unique=True, verbose_name='Host Friendly Name')
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False, verbose_name='SSH Key (public)')
    reverse_port = models.PositiveIntegerField(blank=False, null=False, unique=True, verbose_name='Reverse Port')
    description = models.TextField(blank=True, null=True, verbose_name='Description')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[R][{self.host_friendly_name}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'Reverse Server Key'
        verbose_name_plural = 'Reverse Server Keys'

class ReverseServerUsernames(models.Model):
    # Reverse Server Usernames for endpoint to connect with this SSH server
    # 反向通道機器上的使用者名稱（用於從web terminal連線到反向通道）
    user = models.ForeignKey(User, on_delete=models.CASCADE, verbose_name='User')
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
        # 一個使用者在端點上能有多個使用者名稱
        unique_together = ('user', 'reverse_server', 'username')

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
    # 使用者的公鑰（用於連線到我們的SSH Server）

    user = models.ForeignKey(User, on_delete=models.CASCADE, verbose_name='User')
    host_friendly_name = models.CharField(max_length=128, unique=True, verbose_name='Host Friendly Name')
    key = models.CharField(max_length=19200, unique=True, blank=False, null=False, verbose_name='SSH Key (public)')
    description = models.TextField(blank=True, null=True, verbose_name='Description')
    created_at = models.DateTimeField(auto_now_add=True, verbose_name='Created At')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='Updated At')

    def __str__(self):
        return f'[U][{self.host_friendly_name}] {self.key[:20]} ... {self.key[-20:]}'

    class Meta:
        verbose_name = 'User Keys'
        verbose_name_plural = 'User Keys'
