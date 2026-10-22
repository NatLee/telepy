/**
 * 裝置的公網 IP（gateway 看到的連線來源）：連著時是現在的；離線時是最後一次的，淡色並附「多久以前」。點一下複製。
 * 後端只把它給能登入裝置的人（`endpoint` 為 null 時不顯示）。卡片與表格共用。
 * Device public IP chip: the live address while connected, the last known one (muted, with "last seen")
 * when offline; click to copy. The backend only sends it to people who can log in to the device.
 */
import React, { useState } from "react";
import { Check, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { TunnelEndpoint } from "@/types/tunnel";

export function TunnelEndpointChip({ endpoint, className }: { endpoint?: TunnelEndpoint | null; className?: string }) {
    const { t, locale } = useI18n();
    const [copied, setCopied] = useState(false);
    if (!endpoint) return null;

    const when = formatRelativeTime(endpoint.live ? endpoint.connected_at : endpoint.last_seen_at ?? endpoint.connected_at, locale);
    const label = endpoint.live
        ? t("tunnels.endpointLive", { ip: endpoint.ip, time: when })
        : t("tunnels.endpointLast", { ip: endpoint.ip, time: when });
    const copy = () =>
        navigator.clipboard
            .writeText(endpoint.ip)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});

    return (
        <button
            type="button"
            onClick={copy}
            title={`${label}\n${t("tunnels.endpointCopyHint")}`}
            aria-label={label}
            className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[0.75rem] whitespace-nowrap transition-colors [&>svg]:size-3 [&>svg]:shrink-0",
                endpoint.live
                    ? "border-border bg-muted text-foreground/80 hover:border-foreground/30 hover:text-foreground"
                    : "border-border/70 text-muted-foreground hover:text-foreground",
                className
            )}
        >
            {copied ? <Check className="text-success" /> : <Globe />}
            <span className="truncate">{endpoint.ip}</span>
            {!endpoint.live && <span className="font-sans text-muted-foreground/80">· {when}</span>}
        </button>
    );
}
