from django.contrib import admin

# Register your models here.
from custom_auth.models import SocialAccount


@admin.register(SocialAccount)
class SocialAccount_(admin.ModelAdmin):
    list_display = ("user", "provider", "unique_id")
