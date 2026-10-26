/**
 * 裝置的 IP，兩個標籤（前面各有「外網」/「內網」字樣，一眼分得出來）：
 * - 外網 IP：裝置真正的對外位址（gateway 看到的公網來源；不然是裝置經 Telepy 的 /api/whoami、或站台設定的查詢網址回報的），
 *   國旗 + IP；24 小時內換過 IP 加一個點。都不知道、gateway 又只看到代理 / Docker 的內部位址時顯示「不明」＋原因，
 *   不拿那個內部位址充當裝置的 IP。
 * - 內網 IP：裝置自己網卡上的位址（每次連上問一次），滑過看 hostname 與全部網卡。
 * 都能點一下複製。後端只把它們給能登入裝置的人（`endpoint` 為 null 時不顯示）。卡片與表格共用。
 * The device's addresses as two tagged chips: its public IP (flag + IP; "unknown" plus the reason when Telepy only
 * sees a proxy's or Docker's internal address — never that address dressed up as the device's) and its LAN IP
 * (hover for the hostname and every interface). Click to copy.
 */
import React, { useState } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import { flagEmoji, isNonPublic, placeLabel } from "@/lib/geo";
import { TunnelEndpoint } from "@/types/tunnel";

const chipClass = (live: boolean) =>
    cn(
        "inline-flex max-w-full items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[0.75rem] whitespace-nowrap transition-colors [&>svg]:size-3 [&>svg]:shrink-0",
        live ? "border-border bg-muted text-foreground/80 hover:border-foreground/30 hover:text-foreground" : "border-border/70 text-muted-foreground hover:text-foreground"
    );

function useCopy() {
    const [copied, setCopied] = useState(false);
    const copy = (text: string) =>
        navigator.clipboard
            .writeText(text)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {});
    return { copied, copy };
}

/** 標籤前面的「外網」/「內網」字樣。/ The chip's "Public" / "LAN" tag. */
function Tag({ children }: { children: React.ReactNode }) {
    return <span className="font-sans text-muted-foreground">{children}</span>;
}

export function TunnelEndpointChip({ endpoint, className }: { endpoint?: TunnelEndpoint | null; className?: string }) {
    const { t, locale } = useI18n();
    const { copied, copy } = useCopy();
    if (!endpoint) return null;

    // 知道真正的公網 IP 就顯示它；gateway 看到的是公網位址也行；都不是就是「不明」。
    // The real public IP when known, else the gateway's peer when that is public, else unknown.
    const publicIp = endpoint.public_ip ?? null;
    const when = formatRelativeTime(endpoint.live ? endpoint.connected_at : endpoint.last_seen_at ?? endpoint.connected_at, locale);

    if (!publicIp && isNonPublic(endpoint.geo)) {
        const label = endpoint.live ? t("tunnels.endpointUnknownLive", { time: when }) : t("tunnels.endpointUnknownLast", { time: when });
        const why = endpoint.probe_error
            ? t("tunnels.endpointProbeFailed", { error: endpoint.probe_error })
            : endpoint.probed_at
              ? t("tunnels.endpointNotFound")
              : t("tunnels.endpointNotAsked");
        const details = [label, t("tunnels.endpointGatewaySaw", { ip: endpoint.ip }), why].join("\n");
        return (
            <span title={details} aria-label={label} className={cn(chipClass(endpoint.live), "cursor-help", className)}>
                <Tag>{t("tunnels.endpointTag")}</Tag>
                <TriangleAlert className="text-warning" />
                <span className="truncate font-sans">{t("tunnels.endpointUnknown")}</span>
            </span>
        );
    }

    const ip = publicIp ?? endpoint.ip;
    const geo = publicIp ? endpoint.public_geo : endpoint.geo;
    const label = endpoint.live ? t("tunnels.endpointLive", { ip, time: when }) : t("tunnels.endpointLast", { ip, time: when });
    const place = placeLabel(geo, locale);
    const changedAt = endpoint.changed_at ? Date.parse(endpoint.changed_at) : NaN;
    // eslint-disable-next-line react-hooks/purity
    const recentChange = !!endpoint.previous_ip && Date.now() - changedAt < 24 * 3600 * 1000;
    const source =
        endpoint.public_source === "lookup"
            ? t("tunnels.endpointViaLookup")
            : endpoint.public_source === "device"
              ? t("tunnels.endpointViaDevice")
              : t("tunnels.endpointViaGateway");
    const details = [
        label,
        place,
        publicIp ? source : null,
        publicIp && publicIp !== endpoint.ip ? t("tunnels.endpointGatewaySaw", { ip: endpoint.ip }) : null,
        recentChange ? t("tunnels.endpointChanged", { previous: endpoint.previous_ip!, time: formatRelativeTime(endpoint.changed_at!, locale) }) : null,
        geo?.source && place ? t("geo.attribution", { source: geo.source }) : null,
        t("tunnels.endpointCopyHint"),
    ]
        .filter(Boolean)
        .join("\n");

    return (
        <button type="button" onClick={() => copy(ip)} title={details} aria-label={label} className={cn(chipClass(endpoint.live), className)}>
            <Tag>{t("tunnels.endpointTag")}</Tag>
            {copied ? <Check className="text-success" /> : geo?.country ? <span aria-hidden className="font-sans">{flagEmoji(geo.country)}</span> : null}
            <span className="truncate">{ip}</span>
            {recentChange && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden />}
        </button>
    );
}

/** 裝置的內網 IP（自己網卡上的）。/ The device's LAN address (its own interfaces). */
export function TunnelLanChip({ endpoint, className }: { endpoint?: TunnelEndpoint | null; className?: string }) {
    const { t, locale } = useI18n();
    const { copied, copy } = useCopy();
    const lan = endpoint?.lan ?? [];
    if (!endpoint || lan.length === 0) return null;

    const first = lan[0].ip;
    const details = [
        endpoint.hostname ? t("tunnels.lanTitle", { host: endpoint.hostname }) : t("tunnels.lanTitleNoHost"),
        ...lan.map((a) => `${a.iface}  ${a.ip}/${a.prefix}`),
        endpoint.probed_at ? t("tunnels.lanChecked", { time: formatRelativeTime(endpoint.probed_at, locale) }) : null,
        t("tunnels.endpointCopyHint"),
    ]
        .filter(Boolean)
        .join("\n");

    return (
        <button type="button" onClick={() => copy(first)} title={details} aria-label={t("tunnels.lanAria", { ip: first })} className={cn(chipClass(endpoint.live), className)}>
            <Tag>{t("tunnels.lanTag")}</Tag>
            {copied && <Check className="text-success" />}
            <span className="truncate">{first}</span>
            {lan.length > 1 && <span className="font-sans text-muted-foreground">+{lan.length - 1}</span>}
        </button>
    );
}
