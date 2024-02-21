from django.contrib import admin
from authorized_keys.models import AuthorizedKeys

@admin.register(AuthorizedKeys)
class AuthorizedKeysAdmin(admin.ModelAdmin):
    list_display = ('hostname', 'display_key', 'created_at', 'updated_at')
    search_fields = ('hostname', 'key', 'description')

    def display_key(self, obj):
        key = obj.key
        if len(key) > 10:
            return f"{key[:20]} ... {key[-20:]}"
        return key
    display_key.short_description = 'Key'
