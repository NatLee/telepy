from django.contrib import admin

from user_management.models import UserSettings


@admin.register(UserSettings)
class UserSettingsAdmin(admin.ModelAdmin):
    list_display = ("user", "language")
    search_fields = ("user__username", "user__email")
