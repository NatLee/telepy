/**
 * 一個 IP 的「在哪裡」：國旗 + 國家 · 業者（滑過看 ASN 與資料出處），非公網位址顯示「私有網路」。
 * 沒有 GeoIP 資料庫時只會出現非公網的那種情況。登入紀錄、誰在用、裝置 IP 共用。
 * Where an IP is: flag + country · network owner (hover for the ASN and data source), or "private network"
 * for non-public addresses. Shared by the sign-in history, presence and the device IP.
 */
import React from "react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { flagEmoji, isNonPublic, placeLabel, type IpGeo } from "@/lib/geo";

export function IpPlace({ geo, className }: { geo?: IpGeo | null; className?: string }) {
    const { t, locale } = useI18n();
    if (!geo) return null;
    if (isNonPublic(geo)) {
        return <span className={cn("text-muted-foreground", className)}>{t("geo.private")}</span>;
    }
    const label = placeLabel(geo, locale);
    if (!label) return null;
    const title = [geo.asn ? `AS${geo.asn}` : null, geo.org, geo.source ? t("geo.attribution", { source: geo.source }) : null].filter(Boolean).join(" · ");
    return (
        <span className={cn("inline-flex min-w-0 items-center gap-1 text-muted-foreground", className)} title={title}>
            {geo.country && <span aria-hidden>{flagEmoji(geo.country)}</span>}
            <span className="truncate">{label}</span>
        </span>
    );
}
