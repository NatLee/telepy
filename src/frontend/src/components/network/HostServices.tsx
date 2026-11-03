"use client";

/**
 * 主機面板「詳細」裡的「認出來的東西」：它是什麼（產品 / 類型 / 系統）與憑哪條線索，再來每個 port 看到的服務一列：
 * 協定、網頁標題 / Server / 轉址 / realm / 那一行 banner、HTTPS 的憑證（主體、簽發者、自簽、還有幾天到期，快到期標黃、
 * 過期標紅）。沒有指紋（舊的掃描、手動加的）就說要重掃一次。
 * The host panel's "What Telepy saw": what it is (product / type / OS) and the clue, then one row per port: protocol,
 * page title / Server / redirect / realm / banner, and for HTTPS the certificate (subject, issuer, self-signed, days
 * left; amber when close, red when expired). Without fingerprints (an older scan, a manual host) it says to rescan.
 */
import React from "react";
import { Lock, ShieldAlert } from "lucide-react";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { cn } from "@/lib/utils";
import { DEVICE_ICON } from "@/components/network/deviceIcons";
import { certDaysLeft, type HostIdentity, type HostService } from "@/lib/lanIdentity";
import { serviceName } from "@/lib/lanConnect";
import type { TranslationKey } from "@/locales/en";

export function HostServices({ identity, services, scanned }: { identity: HostIdentity | null | undefined; services: HostService[] | null | undefined; scanned: boolean }) {
    const { t } = useI18n();
    // 憑證剩幾天：一小時更新一次就夠。/ Certificate days left: an hourly tick is plenty.
    const now = Math.floor(useNow(3_600_000) / 1000);
    const list = services ?? [];
    return (
        <Section wrapTitle title={t("network.svc.title")} className="border-t border-border pt-5">
            {identity ? (
                <div className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2">
                    <span className="mt-0.5 text-muted-foreground [&_svg]:size-4" aria-hidden>{DEVICE_ICON[identity.kind]}</span>
                    <span className="min-w-0 text-sm">
                        <span className="block text-foreground">
                            {identity.product ?? t(`network.type.${identity.kind}` as TranslationKey)}
                            {identity.os && <span className="text-muted-foreground"> · {identity.os}</span>}
                        </span>
                        <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                            {t(`network.svc.by.${identity.by.source}` as TranslationKey, { text: identity.by.text })}
                        </span>
                    </span>
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">{scanned ? t("network.svc.unknown") : t("network.svc.notScanned")}</p>
            )}
            {list.length > 0 && (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {list.map((s) => {
                        const days = certDaysLeft(s, now);
                        const main = s.title ?? s.banner ?? s.server ?? null;
                        return (
                            <li key={`${s.port}-${s.proto}`} className="space-y-0.5 px-3 py-2 text-sm">
                                <p className="flex flex-wrap items-baseline gap-x-2">
                                    <span className="font-mono text-foreground">{s.port}</span>
                                    <span className="text-xs uppercase text-muted-foreground">{s.proto}</span>
                                    {/* 常見服務名（跟協定一樣就不重複）。/ The usual service name, unless it repeats the protocol. */}
                                    {serviceName(s.port) && serviceName(s.port)!.toLowerCase() !== s.proto.toLowerCase() && <span className="text-xs text-muted-foreground">{serviceName(s.port)}</span>}
                                    {typeof s.status === "number" && <span className="font-mono text-xs text-muted-foreground">{s.status}</span>}
                                </p>
                                {main && <p className="text-foreground [overflow-wrap:anywhere]">{main}</p>}
                                {s.title && s.server && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{s.server}</p>}
                                {s.realm && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("network.svc.realm", { realm: s.realm })}</p>}
                                {s.location && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{t("network.svc.redirect", { url: s.location })}</p>}
                                {s.cert && (
                                    <p className={cn("flex items-start gap-1.5 text-xs [overflow-wrap:anywhere]", days !== null && days < 0 ? "text-destructive" : days !== null && days < 30 ? "text-warning" : "text-muted-foreground")}>
                                        {s.cert.self_signed ? <ShieldAlert size={13} className="mt-px shrink-0" aria-hidden /> : <Lock size={13} className="mt-px shrink-0" aria-hidden />}
                                        <span>
                                            {[
                                                s.cert.subject ? t("network.svc.certFor", { name: s.cert.subject }) : null,
                                                s.cert.self_signed ? t("network.svc.selfSigned") : s.cert.issuer ? t("network.svc.issuedBy", { issuer: s.cert.issuer }) : null,
                                                days === null ? null : days < 0 ? t("network.svc.expired", { days: -days }) : t("network.svc.expiresIn", { days }),
                                            ].filter(Boolean).join(" · ")}
                                        </span>
                                    </p>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </Section>
    );
}
