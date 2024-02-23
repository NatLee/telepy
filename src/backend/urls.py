"""
URL configuration for backend project.

The `urlpatterns` list routes URLs to views. For more information please see:
    https://docs.djangoproject.com/en/4.2/topics/http/urls/
Examples:
Function views
    1. Add an import:  from my_app import views
    2. Add a URL to urlpatterns:  path('', views.home, name='home')
Class-based views
    1. Add an import:  from other_app.views import Home
    2. Add a URL to urlpatterns:  path('', Home.as_view(), name='home')
Including another URLconf
    1. Import the include() function: from django.urls import include, path
    2. Add a URL to urlpatterns:  path('blog/', include('blog.urls'))
"""

from django.contrib import admin
from django.urls import path, include, re_path

from drf_yasg.views import get_schema_view
from drf_yasg import openapi
from drf_yasg.generators import OpenAPISchemaGenerator

from rest_framework.permissions import AllowAny, IsAdminUser

from rest_framework.routers import DefaultRouter

from django.conf import settings

URL_PREFIX = 'api'

urlpatterns = []

# pages
urlpatterns += [
    # admin
    path(f"{URL_PREFIX}/__hidden_admin/", admin.site.urls),
    # django-rq
    path(f'{URL_PREFIX}/__django-rq/', include('django_rq.urls'))
]


urlpatterns += [
    # google login
    path(f"{URL_PREFIX}/auth/google/", include("custom_auth.urls")),
    # auth
    path(f"{URL_PREFIX}/auth/", include("custom_jwt.urls")),
    # login
    path("login", include("login.urls"), name="login"),
    # reverse_keys
    path(f"{URL_PREFIX}/reverse/", include("reverse_keys.urls")),
    # tunnels
    path(f"tunnels/", include("tunnels.urls")),
    # authorized_keys
    path(f"{URL_PREFIX}/reverse/", include("authorized_keys.urls")),
]

# -------------- START - Swagger View --------------

# Http & Https
class BothHttpAndHttpsSchemaGenerator(OpenAPISchemaGenerator):
    def get_schema(self, request=None, public=False):
        schema = super().get_schema(request, public)
        schema.schemes = ["http", "https"]
        return schema

schema_view = get_schema_view(
    openapi.Info(
        title="Backend service API",
        default_version="v1",
        description="API of backend services.",
    ),
    public=True,
    # permission_classes=(AllowAny,),
    permission_classes = (IsAdminUser,), #is_staff才可使用
    generator_class=BothHttpAndHttpsSchemaGenerator,
)
# --------------- END - Swagger View ----------------


urlpatterns += [
    re_path(
        r"^api/__hidden_swagger(?P<format>\.json|\.yaml)$",
        schema_view.without_ui(cache_timeout=0),
        name="schema-json",
    ),
    re_path(
        r"^api/__hidden_swagger",
        schema_view.with_ui("swagger", cache_timeout=0),
        name="schema-swagger-ui",
    ),
    re_path(
        r"^api/__hidden_redoc",
        schema_view.with_ui("redoc", cache_timeout=0),
        name="schema-redoc",
    ),
]


from django.conf.urls.static import static
urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
