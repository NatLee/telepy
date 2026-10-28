"use client";

/**
 * 管理區的全站指令規則：每條隧道（或勾選的幾條）都套用的規則，加在每個人自己的規則之上，任何管理員都能改。只有管理員。
 * The admin section's site-wide command rules: rules every tunnel (or the picked ones) follows on top of everyone's own
 * rules, editable by any admin. Admins only.
 */
import React, { Suspense } from "react";
import { AdminGate } from "@/components/layout/AdminViews";
import { CommandRulesView } from "@/components/commands/CommandRulesView";
import { useI18n } from "@/lib/i18n";

export default function AdminCommandsPage() {
    const { t } = useI18n();
    return (
        <AdminGate mineHref="/tunnels/commands" mineLabel={t("nav.commands")}>
            <Suspense fallback={null}>
                <CommandRulesView view="site" />
            </Suspense>
        </AdminGate>
    );
}
