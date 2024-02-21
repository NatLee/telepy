from django.db import models

class AuthorizedKeys(models.Model):

    hostname = models.CharField(max_length=100, unique=True)
    key = models.TextField()

    description = models.TextField(blank=True, null=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


    def __str__(self):
        return f'[{self.hostname}] {self.key[:5]}...{self.key[-5:]}'

    class Meta:
        verbose_name = 'Authorized Key'
        verbose_name_plural = 'Authorized Keys'