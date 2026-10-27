"use client";

/**
 * 這一頁屬於管理員替你關掉的功能：說明代替頁面（API 也會拒絕，這裡只是不讓人對著一堆錯誤猜）。
 * A page of a feature an admin turned off for you: an explanation instead of the page (the API refuses anyway).
 */
import Link from "next/link";
import { Lock } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { featureKey, type FeatureId } from "@/lib/features";
import type { TranslationKey } from "@/locales/en";

export function FeatureOffNotice({ feature }: { feature: FeatureId }) {
    const { t } = useI18n();
    const name = t(`access.f.${featureKey(feature)}` as TranslationKey);
    return (
        <div className="mx-auto max-w-xl space-y-4 py-6">
            <Callout tone="warning" icon={<Lock size={17} className="mt-0.5 shrink-0" aria-hidden />} title={t("access.pageOffTitle", { feature: name })}>
                {t("access.pageOffBody")}
            </Callout>
            <Button asChild variant="outline" size="sm">
                <Link href="/tunnels">{t("access.backToTunnels")}</Link>
            </Button>
        </div>
    );
}
