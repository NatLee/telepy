from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys
from authorized_keys.models import ReverseServerUsernames

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
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
