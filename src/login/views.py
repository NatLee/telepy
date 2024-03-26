import json

from django.shortcuts import render, redirect
from django.http import JsonResponse

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

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
        return render(request, "login.html", {"social_google_client_id": settings.SOCIAL_GOOGLE_CLIENT_ID})

# ======================================
# Other APIs
# ======================================

