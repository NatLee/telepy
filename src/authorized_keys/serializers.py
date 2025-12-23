from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames
from tunnels.models import TunnelSharing

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
    can_edit = serializers.SerializerMethodField()

    def get_can_edit(self, obj):
        """
        Check if the current user can edit this tunnel.
        """
        request = self.context.get('request')
        if not request or not request.user.is_authenticated:
            return False

        # If user owns the tunnel, they can always edit
        if obj.user == request.user:
            return True

        # Check if tunnel is shared with edit permission
        sharing = TunnelSharing.objects.filter(
            tunnel=obj,
            shared_with=request.user,
            can_edit=True
        ).first()

        return sharing is not None

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
