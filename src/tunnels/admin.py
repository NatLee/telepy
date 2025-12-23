from django.contrib import admin
from django.template.response import TemplateResponse
from django.urls import path
from .models import TunnelSharing, PermissionRegistry, TunnelPermission


class PermissionGroupFilter(admin.SimpleListFilter):
    """
    Custom filter to show sharing records by permission groups.
    """
    title = 'permission group'
    parameter_name = 'permission_group'

    def lookups(self, request, model_admin):
        """
        Return tuples of (value, display) for filter options.
        """
        groups = []
        for group in PermissionRegistry.get_all_groups():
            groups.append((group.name, f"{group.name} - {group.description}"))
        return groups

    def queryset(self, request, queryset):
        """
        Filter queryset based on selected permission group.
        """
        if self.value():
            group_permissions = PermissionRegistry.get_permissions_for_group(self.value())
            if group_permissions:
                return queryset.filter(permission_type__in=group_permissions)
        return queryset


@admin.register(TunnelSharing)
class TunnelSharingAdmin(admin.ModelAdmin):
    """
    Admin interface for TunnelSharing model.
    """
    list_display = (
        'tunnel',
        'shared_by',
        'shared_with',
        'permission_type_display',
        'permission_group_display',
        'shared_at',
        'updated_at'
    )
    list_filter = (
        'permission_type',
        'shared_at',
        'updated_at',
        'shared_by',
        'shared_with',
        PermissionGroupFilter,
    )
    search_fields = (
        'tunnel__host_friendly_name',
        'tunnel__hostname',
        'shared_by__username',
        'shared_by__email',
        'shared_with__username',
        'shared_with__email'
    )
    readonly_fields = ('shared_at', 'updated_at', 'permission_group_display')
    ordering = ('-shared_at',)

    fieldsets = (
        ('Sharing Details', {
            'fields': ('tunnel', 'shared_by', 'shared_with')
        }),
        ('Permissions', {
            'fields': ('permission_type', 'permission_group_display')
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

    def get_urls(self):
        """
        Add custom URL for permission groups view.
        """
        urls = super().get_urls()
        custom_urls = [
            path('permission-groups/', self.admin_site.admin_view(self.permission_groups_view),
                 name='tunnels_tunnelsharing_permission_groups'),
        ]
        return custom_urls + urls

    def permission_groups_view(self, request):
        """
        View to display all registered permission groups and their permissions.
        """
        context = {
            **self.admin_site.each_context(request),
            'title': 'Permission Groups',
            'groups': list(PermissionRegistry.get_all_groups()),
            'permission_choices': dict(TunnelPermission.PERMISSION_CHOICES),
        }
        return TemplateResponse(request, 'admin/tunnels/permission_groups.html', context)

    def permission_type_display(self, obj):
        """
        Display permission type with human-readable description.
        """
        permission_choices = dict(TunnelPermission.PERMISSION_CHOICES)
        return permission_choices.get(obj.permission_type, obj.permission_type)
    permission_type_display.short_description = 'Permission Level'
    permission_type_display.admin_order_field = 'permission_type'

    def permission_group_display(self, obj):
        """
        Display which permission groups this permission level belongs to.
        """
        groups = []
        for group in PermissionRegistry.get_all_groups():
            if obj.permission_type in group.permissions:
                groups.append(f"{group.name} ({group.description})")

        if not groups:
            return "No groups"
        return ", ".join(groups)
    permission_group_display.short_description = 'Permission Groups'

    def changelist_view(self, request, extra_context=None):
        """
        Add link to permission groups view in changelist.
        """
        extra_context = extra_context or {}
        extra_context['permission_groups_url'] = '../permission-groups/'
        return super().changelist_view(request, extra_context)
