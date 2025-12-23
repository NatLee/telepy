from django.contrib import admin
from .models import TunnelSharing


@admin.register(TunnelSharing)
class TunnelSharingAdmin(admin.ModelAdmin):
    """
    Admin interface for TunnelSharing model.
    """
    list_display = (
        'tunnel',
        'shared_by',
        'shared_with',
        'can_edit',
        'shared_at',
        'updated_at'
    )
    list_filter = (
        'can_edit',
        'shared_at',
        'updated_at',
        'shared_by',
        'shared_with'
    )
    search_fields = (
        'tunnel__host_friendly_name',
        'tunnel__hostname',
        'shared_by__username',
        'shared_by__email',
        'shared_with__username',
        'shared_with__email'
    )
    readonly_fields = ('shared_at', 'updated_at')
    ordering = ('-shared_at',)

    fieldsets = (
        ('Sharing Details', {
            'fields': ('tunnel', 'shared_by', 'shared_with')
        }),
        ('Permissions', {
            'fields': ('can_edit',)
        }),
        ('Timestamps', {
            'fields': ('shared_at', 'updated_at'),
            'classes': ('collapse',)
        }),
    )

    def get_queryset(self, request):
        """
        Optimize queryset by selecting related fields to reduce database queries.
        """
        return super().get_queryset(request).select_related(
            'tunnel',
            'shared_by',
            'shared_with'
        )
