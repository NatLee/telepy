"use client";

/**
 * 管理區的全站 Webhook：整個站都該知道的重要事件（狀態、IP 變更、主機金鑰、登入失敗…），每個管理員都能編輯。只有管理員。
 * The admin section's site-wide webhooks: the events the whole site should know about (status, IP changes, host keys,
 * failed sign-ins…), editable by every admin. Admins only.
 */
import React from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { WebhooksView } from "@/components/webhooks/WebhooksView";
import { useI18n } from "@/lib/i18n";

export default function AdminWebhooksPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/webhooks" mineLabel={t("nav.webhooks")}>
            <WebhooksView scope="site" />
        </AdminGate>
    );
}
