from django.contrib import admin
from authorized_keys.models import AuthorizedKeys

@admin.register(AuthorizedKeys)
class AuthorizedKeysAdmin(admin.ModelAdmin):
    list_display = ('hostname', 'key', 'created_at', 'updated_at')
    search_fields = ('hostname', 'description')

