"use client";

/**
 * 管理區「使用者與權限 → 使用者」：每個帳號（停用、管理員角色、語言、重設兩步驟、登入、token、AI 活動）。以前是網站
 * 設定頁的一個分頁；舊的 `/tunnels/settings?tab=users` 會轉到這裡。只有管理員。
 * The admin section's Users & access → Users: every account (disable, admin role, language, 2FA reset, sign-ins,
 * tokens, AI activity). Formerly a tab of the site settings page; the old `/tunnels/settings?tab=users` redirects
 * here. Admins only.
 */
import React from "react";
import { UsersRound } from "lucide-react";
import { AdminChip, AdminGate } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { UsersList } from "@/components/users/UsersList";
import { useI18n } from "@/lib/i18n";

export default function AdminUsersPage() {
    const { t } = useI18n();
    return (
        <AdminGate>
            <div className="animate-fade-in-up">
                <PageHeader className="mb-6" icon={<UsersRound />} title={t("settings.tabUsers")} titleAddon={<AdminChip />} description={t("settings.usersBanner")} />
                <UsersList />
            </div>
        </AdminGate>
    );
}
