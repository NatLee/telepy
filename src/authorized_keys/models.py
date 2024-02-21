from django.db import models

class AuthorizedKeys(models.Model):
    username = models.CharField(max_length=100, unique=True)
    key = models.TextField()

    def __str__(self):
        return f'[{self.username}] {self.key[:5]}...{self.key[-5:]}'
