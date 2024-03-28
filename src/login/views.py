from django.shortcuts import render, redirect
from django.contrib.auth.models import User
from django.views.decorators.csrf import csrf_exempt

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg import openapi
from drf_yasg.utils import swagger_auto_schema

from django.conf import settings

# ======================================
# Page Views
# ======================================

class Login(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Login",
        operation_description="Login page",
        tags=['Page']
    )
    def get(self, request):
        login_settings = {
            "social_google_client_id": settings.SOCIAL_GOOGLE_CLIENT_ID
        }
        # Determine if there is no User in the database
        #if User.objects.count() == 0:
            # If there is no User, redirect to the registration page
        return render(request, "first-login.html", login_settings)
        return render(request, "login.html", login_settings)

# ======================================
# Other APIs
# ======================================

class Register(APIView):
    permission_classes = (AllowAny,)
    @swagger_auto_schema(
        operation_summary="Register",
        operation_description="Registration with username and password",
        request_body=openapi.Schema(
            type=openapi.TYPE_OBJECT,
            required=['username', 'password'],
            properties={
                'username': openapi.Schema(type=openapi.TYPE_STRING, description='Username'),
                'password': openapi.Schema(type=openapi.TYPE_STRING, description='Password'),
            },
        ),
        tags=['Login']
    )
    def post(self, request):
        # Get the username and password from the request
        username = request.data.get("username")
        password = request.data.get("password")

        try:
            # Create a new User
            user = User.objects.create_user(username, password=password)
        except Exception as e:
            # If there is an error, return the error message
            return Response({"error": str(e)}, status=status.HTTP_400_BAD_REQUEST)

        # Save the User
        user.save()
        return Response(
            {
                "status": "success",
                "data": {
                    "user": {
                        "id": user.id,
                        "username": user.username,
                    }
                },
                "details": "User created successfully"
            },
            status=status.HTTP_201_CREATED
        )
