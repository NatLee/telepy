import json

from django.shortcuts import render, redirect
from django.http import JsonResponse

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated, IsAdminUser, AllowAny

from drf_yasg.utils import swagger_auto_schema
from drf_yasg import openapi

class Login(APIView):
    permission_classes = (AllowAny,)
    def get(self, request):
        return render(request, 'login.html')
