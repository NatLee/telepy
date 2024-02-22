from rest_framework import serializers
from authorized_keys.models import ReverseServerAuthorizedKeys

class ReverseServerAuthorizedKeysSerializer(serializers.ModelSerializer):
    class Meta:
        model = ReverseServerAuthorizedKeys
        fields = ['hostname', 'key', 'reverse_port', 'description', 'created_at', 'updated_at']
