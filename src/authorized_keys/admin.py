from django import forms
from django.contrib import admin
from django.core.exceptions import ValidationError

from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ServiceAuthorizedKeys

from authorized_keys.models import ReverseServerUsernames

from authorized_keys.utils import is_valid_ssh_public_key

class ReverseServerAuthorizedKeysForm(forms.ModelForm):
    class Meta:
        model = ReverseServerAuthorizedKeys
        fields = '__all__'
    
    def clean_key(self):
        key = self.cleaned_data['key']
        if not is_valid_ssh_public_key(key):
            raise ValidationError("Invalid SSH public key format.")
        return key

class UserAuthorizedKeysForm(forms.ModelForm):
    class Meta:
        model = UserAuthorizedKeys
        fields = '__all__'
    
    def clean_key(self):
        key = self.cleaned_data['key']
        if not is_valid_ssh_public_key(key):
            raise ValidationError("Invalid SSH public key format.")
        return key

class ServiceAuthorizedKeysForm(forms.ModelForm):
    class Meta:
        model = ServiceAuthorizedKeys
        fields = '__all__'
    
    def clean_key(self):
        key = self.cleaned_data['key']
        if not is_valid_ssh_public_key(key):
            raise ValidationError("Invalid SSH public key format.")
        return key


@admin.register(ReverseServerAuthorizedKeys)
class ReverseServerAuthorizedKeysAdmin(admin.ModelAdmin):
    form = ReverseServerAuthorizedKeysForm
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
    form = UserAuthorizedKeysForm
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
    form = ServiceAuthorizedKeysForm
    list_display = ('service', 'display_key', 'created_at', 'updated_at')
    search_fields = ('service', 'key', 'description')

    def display_key(self, obj):
        key = obj.key
        if len(key) > 10:
            return f"{key[:20]} ... {key[-20:]}"
        return key
    display_key.short_description = 'Key'

@admin.register(ReverseServerUsernames)
class ReverseServerUsernamesAdmin(admin.ModelAdmin):
    list_display = ('reverse_server', 'username', 'created_at', 'updated_at')
    search_fields = ('reverse_server', 'username')
