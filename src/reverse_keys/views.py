import datetime

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.parsers import MultiPartParser, FormParser
from rest_framework.permissions import IsAuthenticated, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

from authorized_keys.models import ReverseServerAuthorizedKeys
from reverse_keys.utils import issue_token, verify_token

class IssueToken(APIView):
    permission_classes = (IsAuthenticated,)

    @swagger_auto_schema(
        operation_summary="Issue Token",
        operation_description="Issues a token with a 10-minute expiration",
        responses={
            200: openapi.Response(
                description="A token is issued",
                examples={
                    "application/json": {
                        "token": "your-issued-token",
                        "created_at": "2021-01-01T00:00:00.000000"
                    }
                }
            )
        },
        tags=['Reverse Server Keys']
    )
    def get(self, request, *args, **kwargs):
        token = issue_token()
        return Response({
            'token': token,
            'created_at': datetime.datetime.now().isoformat(),
        })

class CreateReverseServerKey(APIView):
    permission_classes = (AllowAny,)
    parser_classes = (FormParser,)

    @swagger_auto_schema(
        operation_summary="Create Reverse Server Key",
        operation_description="Creates a Reverse Server Authorized Key using a valid token",
        responses={
            200: openapi.Response(
                description="Reverse Server Key created successfully"
            ),
            400: "Invalid or expired token"
        },
        manual_parameters=[
            openapi.Parameter(
                name="hostname",
                in_=openapi.IN_FORM,
                description="Host Name",
                type=openapi.TYPE_STRING,
                required=True,
            ),
            openapi.Parameter(
                name="key",
                in_=openapi.IN_FORM,
                description="SSH Public Key",
                type=openapi.TYPE_STRING,
                required=True,
            ),
            openapi.Parameter(
                name="reverse_port",
                in_=openapi.IN_FORM,
                description="Reverse Port",
                type=openapi.TYPE_INTEGER,
                required=True,
            ),
            openapi.Parameter(
                name="description",
                in_=openapi.IN_FORM,
                description="Description of the key",
                type=openapi.TYPE_STRING,
                required=False,
            ),
        ],
        tags=['Reverse Server Keys']
    )
    def post(self, request, token, *args, **kwargs):

        if token == '':
            return Response({"error": "Token is required"}, status=status.HTTP_400_BAD_REQUEST)

        if not verify_token(token):
            return Response({"error": "Invalid or expired token"}, status=status.HTTP_400_BAD_REQUEST)

        # =====================================

        hostname = request.data.get('hostname')
        key = request.data.get('key')

        reverse_port = request.data.get('reverse_port')        
        try:
            reverse_port = int(reverse_port)
        except ValueError:
            return Response({"error": "Invalid reverse port"}, status=status.HTTP_400_BAD_REQUEST)
    
        description = request.data.get('description', '')

        try:
            reverse_key = ReverseServerAuthorizedKeys.objects.create(
                hostname=hostname,
                key=key,
                reverse_port=reverse_port,
                description=description
            )
            return Response({"message": "Reverse Server Key created successfully"})
        except Exception as e:
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)