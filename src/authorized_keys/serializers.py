from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys
from authorized_keys.models import UserAuthorizedKeys

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReverseServerAuthorizedKeys
        fields = ['id', 'hostname', 'key', 'reverse_port', 'description', 'created_at', 'updated_at']

class UserAuthorizedKeysSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserAuthorizedKeys
        fields = ['id', 'hostname', 'key', 'description', 'created_at', 'updated_at']
