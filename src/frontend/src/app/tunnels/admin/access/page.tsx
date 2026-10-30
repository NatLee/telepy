"use client";

/**
 * 管理區「使用者與權限 → 功能權限」：每個人可以用哪些 Telepy 功能（所有人 / 群組 / 個人；跟通道分享無關）。以前是
 * 網站設定頁的「存取」分頁；舊的 `/tunnels/settings?tab=access[&user=]` 會轉到這裡，`?user=` 照樣先選那個人。
 * The admin section's Users & access → Feature access: which Telepy features each person may use (everyone /
 * groups / one person; not tunnel sharing). Formerly the site settings page's Access tab; the old
 * `/tunnels/settings?tab=access[&user=]` redirects here and `?user=` still picks that person first.
 */
import React, { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Info, KeySquare } from "lucide-react";
import { AdminChip, AdminGate } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { AccessTab } from "@/components/access/AccessTab";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";

export default function AdminAccessPage() {
    return (
        <AdminGate>
            {/* useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary. */}
            <Suspense fallback={null}>
                <AccessPage />
            </Suspense>
        </AdminGate>
    );
}

function AccessPage() {
    const { t } = useI18n();
    const user = Number(useSearchParams().get("user")) || null;
    return (
        <div className="animate-fade-in-up">
            <AccessTab
                key={user ?? 0}
                initialUser={user}
                header={(openInfo) => (
                    <PageHeader
                        icon={<KeySquare />}
                        title={t("access.manageTitle")}
                        titleAddon={<AdminChip />}
                        description={t("access.banner")}
                        actions={
                            <Button variant="outline" onClick={openInfo}>
                                <Info size={16} /> {t("access.howItWorks")}
                            </Button>
                        }
                    />
                )}
            />
        </div>
    );
}
