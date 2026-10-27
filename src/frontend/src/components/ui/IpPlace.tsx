/**
 * 一個 IP 的「在哪裡」：國旗 + 國家 · 業者（滑過看 ASN 與資料出處）。非公網位址不當成地點：顯示「內部位址」
 * 警示小標，點開說明為什麼（多半是 Telepy 前面的代理 / Docker 換掉了真實來源），管理員多一個連到
 * 「Telepy 怎麼看你的位址」檢查的連結。沒有 GeoIP 資料庫時只會出現非公網的那種情況。登入紀錄、你的裝置、
 * 即時連線、誰在用共用。
 * Where an IP is: flag + country · network owner (hover for the ASN and data source). A non-public address is not
 * a place: it shows an "Internal address" warning chip that explains why (usually a proxy or Docker in front of
 * Telepy replaced the real source), with a link to the address check for admins. Shared by the sign-in history,
 * Your devices, live sessions and presence.
 */
"use client";

import React from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { flagEmoji, isNonPublic, placeLabel, type IpGeo } from "@/lib/geo";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 管理員看「Telepy 怎麼看你的位址」的地方。/ Where admins run the address check. */
export const CLIENT_IP_CHECK_HREF = "/tunnels/settings?tab=signin#client-ip";

function InternalAddress({ className }: { className?: string }) {
    const { t } = useI18n();
    const { user } = useAuth();
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    className={cn("inline-flex items-center gap-1 rounded-sm bg-warning/12 px-1.5 py-px text-xs leading-5 whitespace-nowrap text-warning hover:bg-warning/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
                >
                    <TriangleAlert size={12} aria-hidden />
                    {t("geo.internal")}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="space-y-2 p-3 text-xs leading-relaxed">
                <p className="text-foreground">{t("geo.internalHint")}</p>
                {user?.is_superuser && (
                    // 一般的整頁導覽：從偏好設定視窗裡點也會離開視窗。/ A full navigation, so it also leaves the preferences dialog.
                    <a href={CLIENT_IP_CHECK_HREF} className="inline-block text-primary underline-offset-2 hover:underline">
                        {t("geo.internalCheck")}
                    </a>
                )}
            </PopoverContent>
        </Popover>
    );
}

export function IpPlace({ geo, className }: { geo?: IpGeo | null; className?: string }) {
    const { t, locale } = useI18n();
    if (!geo) return null;
    if (isNonPublic(geo)) return <InternalAddress className={className} />;
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
