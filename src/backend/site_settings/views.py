from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated

from drf_yasg.utils import swagger_auto_schema

from site_settings.models import SiteSettings
from site_settings.serializers import SiteSettingsSerializer


def _field_meta():
    """
    由 model 欄位產生每個設定的說明中繼資料(給前端設定頁顯示 label + 說明 + 決定用什麼編輯器)。
    順序沿用 serializer 的 fields。type: boolean | integer | string。
    Build per-setting metadata (label, description, editor type) from the model fields so the settings
    page can show what each setting does. Order follows the serializer's field list.
    """
    model_fields = {f.name: f for f in SiteSettings._meta.get_fields() if hasattr(f, "get_internal_type")}
    meta = {}
    for name in SiteSettingsSerializer.Meta.fields:
        f = model_fields.get(name)
        if f is None:
            continue
        internal = f.get_internal_type()
        if internal == "BooleanField":
            kind = "boolean"
        elif internal in ("IntegerField", "PositiveIntegerField", "SmallIntegerField"):
            kind = "integer"
        else:
            kind = "string"
        meta[name] = {
            "label": str(f.verbose_name),
            "description": str(f.help_text),
            "type": kind,
        }
    return meta


class SiteSettingsView(APIView):
    permission_classes = [IsAuthenticated]  # All authenticated users can access this view

    @swagger_auto_schema(
        operation_description="Retrieve Site Settings (values + per-field metadata: label/description/type)",
        tags=['Site Settings'],
    )
    def get(self, request, *args, **kwargs):
        # 只有管理員能看/改站台設定;非管理員回空(前端會顯示提示)。
        # Only admins may view/edit site settings; non-admins get empty payloads.
        if not request.user.is_superuser:
            return Response({"values": {}, "meta": {}})
        settings, _created = SiteSettings.objects.get_or_create(pk=1)
        return Response({
            "values": SiteSettingsSerializer(settings).data,
            "meta": _field_meta(),
        })

    @swagger_auto_schema(
        operation_description="Update Site Settings (admins only). Body: { field: value, ... }",
        request_body=SiteSettingsSerializer,
        tags=['Site Settings'],
    )
    def post(self, request, *args, **kwargs):
        # Only admin users can modify system settings
        if not request.user.is_superuser:
            return Response({'error': 'Permission denied. Only administrators can modify system settings.'}, status=403)

        settings, _created = SiteSettings.objects.get_or_create(pk=1)
        # partial=True:允許只送單一欄位更新(前端每次只改一項)。
        serializer = SiteSettingsSerializer(settings, data=request.data, partial=True)
        if serializer.is_valid():
            serializer.save()
            return Response({"values": serializer.data, "meta": _field_meta()})
        return Response(serializer.errors, status=400)
