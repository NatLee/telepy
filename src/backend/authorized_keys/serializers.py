from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames
from tunnels.models import TunnelPermission, TunnelSharing

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
    can_edit = serializers.SerializerMethodField()
    can_share = serializers.SerializerMethodField()
    can_delete = serializers.SerializerMethodField()
    is_owner = serializers.SerializerMethodField()
    user_permission = serializers.SerializerMethodField()
    shared_with_count = serializers.SerializerMethodField()

    # 這 6 個欄位其實都可由「目前使用者對該通道的有效權限」推導出來：
    #   'owner'（擁有者，等同 admin）/ 'admin' / 'edit' / 'view' / None（無存取權）。
    # 舊版每個欄位各自呼叫 TunnelPermissionManager，導致「每列 tunnel 打 4~6 次 TunnelSharing 查詢」的
    # N+1（列表頁最常見的後端熱點）。改法：列表時由 ViewSet 一次算好兩張表放進 context —— my_shares
    # {tunnel_id: permission_type}（目前使用者的分享權限）與 share_counts {tunnel_id: 數量}——之後每列
    # 純查 dict、0 次 DB。單物件情境（retrieve / create，context 沒有 my_shares）則退回原本的單筆查詢，
    # 語意完全不變（單物件本來就沒有 N+1）。
    # These six fields all derive from the current user's *effective permission* for the tunnel. The old
    # code called TunnelPermissionManager per field → 4-6 TunnelSharing queries PER ROW (a classic N+1 on
    # the list endpoint). Now the ViewSet precomputes two maps into the serializer context for list(), so
    # each row is a dict lookup (0 queries); single-object contexts fall back to the original query.
    def _effective_permission(self, obj):
        """Return 'owner' | 'admin' | 'edit' | 'view' | None for the current user, without per-row N+1."""
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return None

        if obj.user_id == request.user.id:
            return 'owner'

        my_shares = self.context.get('my_shares')
        if my_shares is not None:
            # List path: resolved from the single prefetched map (no query).
            return my_shares.get(obj.id)

        # Single-object fallback (retrieve/create/update): one query, no N+1.
        sharing = TunnelSharing.objects.filter(tunnel=obj, shared_with=request.user).first()
        return sharing.permission_type if sharing else None

    def get_can_edit(self, obj):
        """Edit requires owner, ADMIN, or EDIT (mirrors check_access(EDIT))."""
        return self._effective_permission(obj) in ('owner', TunnelPermission.ADMIN, TunnelPermission.EDIT)

    def get_can_share(self, obj):
        """Share requires owner or ADMIN (mirrors check_share_access)."""
        return self._effective_permission(obj) in ('owner', TunnelPermission.ADMIN)

    def get_can_delete(self, obj):
        """Delete requires owner or ADMIN (mirrors check_delete_access)."""
        return self._effective_permission(obj) in ('owner', TunnelPermission.ADMIN)

    def get_is_owner(self, obj):
        """Whether the current user owns this tunnel."""
        return self._effective_permission(obj) == 'owner'

    def get_user_permission(self, obj):
        """Effective permission level: 'owner', 'admin', 'edit', 'view', or None."""
        return self._effective_permission(obj)

    def get_shared_with_count(self, obj):
        """Number of users this tunnel is shared with (for owner display)."""
        share_counts = self.context.get('share_counts')
        if share_counts is not None:
            # List path: read from the precomputed per-tunnel count map (no query).
            return share_counts.get(obj.id, 0)
        # Single-object fallback.
        return TunnelSharing.objects.filter(tunnel=obj).count()

    class Meta:
        model = ReverseServerAuthorizedKeys
        partial = True
        fields = '__all__'
        # Need to set user as read_only field because it is not in the fields list
        read_only_fields = ('user',)

class UserAuthorizedKeysSerializer(serializers.ModelSerializer):

    class Meta:
        model = UserAuthorizedKeys
        partial = True
        fields = '__all__'
        read_only_fields = ('user',)


class ReverseServerUsernamesSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReverseServerUsernames
        fields = '__all__'
        read_only_fields = ('user',)
