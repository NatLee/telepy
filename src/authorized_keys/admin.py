from django.contrib import admin
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ServiceAuthorizedKeys
@admin.register(ReverseServerAuthorizedKeys)
class ReverseServerAuthorizedKeysAdmin(admin.ModelAdmin):
    list_display = ('hostname', 'display_key', 'reverse_port', 'created_at', 'updated_at')
    search_fields = ('hostname', 'key', 'reverse_port', 'description')

    def display_key(self, obj):
        key = obj.key
        if len(key) > 10:
            return f"{key[:20]} ... {key[-20:]}"
        return key
    display_key.short_description = 'Key'

@admin.register(UserAuthorizedKeys)
class UserAuthorizedKeysAdmin(admin.ModelAdmin):
    list_display = ('hostname', 'display_key', 'created_at', 'updated_at')
    search_fields = ('hostname', 'key', 'description')

    def display_key(self, obj):
        key = obj.key
        if len(key) > 10:
            return f"{key[:20]} ... {key[-20:]}"
        return key
    display_key.short_description = 'Key'

@admin.register(ServiceAuthorizedKeys)
class ServiceAuthorizedKeysAdmin(admin.ModelAdmin):
    list_display = ('service', 'display_key', 'created_at', 'updated_at')
    search_fields = ('service', 'key', 'description')

    def display_key(self, obj):
        key = obj.key
        if len(key) > 10:
            return f"{key[:20]} ... {key[-20:]}"
        return key
    display_key.short_description = 'Key'
