from django.urls import path

from user_management import views

urlpatterns = [
    # 自己的個人設定 / Own personal settings
    path("settings", views.UserSettingsView.as_view(), name="user-settings"),
    # 管理員使用者管理 / Admin user management
    path("users", views.ManagedUserListView.as_view(), name="user-list"),
    path("users/<int:user_id>", views.ManagedUserDetailView.as_view(), name="user-detail"),
]
