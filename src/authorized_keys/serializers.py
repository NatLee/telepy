from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames
from tunnels.models import TunnelPermissionManager, TunnelPermission

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
    can_edit = serializers.SerializerMethodField()
    can_share = serializers.SerializerMethodField()
    is_owner = serializers.SerializerMethodField()

    def get_can_edit(self, obj):
        """
        Check if the current user can edit this tunnel.
        """
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False

        # Use the new permission manager to check edit access
        return TunnelPermissionManager.check_access(
            request.user, obj, TunnelPermission.EDIT
        )

    def get_can_share(self, obj):
        """
        Check if the current user can share this tunnel with others.
        """
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False

        # Use the new permission manager to check share access
        return TunnelPermissionManager.check_share_access(
            request.user, obj
        )

    def get_is_owner(self, obj):
        """
        Check if the current user is the owner of this tunnel.
        """
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False

        return obj.user == request.user

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
