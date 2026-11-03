/**
 * 通道表格列（≥1200px 的清單檢視）：每一欄都是「主要一行 + 安靜的一行」，一列固定兩行高。
 * 名稱 + 釘選 / 標籤 + 說明；狀態 + 延遲 / 連線方式（離線時先寫最後上線）；埠 + 作業系統 / 外網與內網 IP，後面接要注意
 * 的事（host key 變了是紅框；裝置警告、要改的服務名、舊名稱是警示色的字）；我的關係與分享 / 誰在用；帶標籤的開啟按鈕
 * 與「更多」選單。以前每一樣都是一個小框往下堆（一列堆到十個）：灰框像雜訊、一列高到一頁放不下幾條；現在小框只留給
 * 罕見又一定要看到的（host key）。整列點了就進通道頁面（按鈕那一欄除外）。
 * Tunnel table row (list view, ≥1200px): every column is a primary line plus a quiet one, so a row is two lines tall.
 * Name + pin / labels + description; status + latency / the way in (last seen first when offline); port + OS / public and
 * LAN IP, then what needs attention (a changed host key stays a red chip; device warnings, a service name to change and
 * an older name are warning-coloured words); my relation + sharing / who is using it; labelled open buttons and the
 * "More" menu. Each item used to be its own chip stacked downwards (ten per row): grey boxes read as noise and a page
 * held only a few rows. Chips are kept only for the rare, must-see flag. A click anywhere on the row (but the buttons
 * column) opens the tunnel's page.
 */
import React from "react";
import Link from "next/link";
import { tunnelPageUrl } from "@/lib/tunnelPage";
import { ChevronRight, Server } from "lucide-react";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";
import { TunnelActions } from "@/components/tunnels/TunnelActions";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { HEALTH_TILE, TunnelAccessBadges, TunnelLastSeen, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { liveHealth } from "@/lib/tunnelHealth";
import { PinButton, TunnelLabels } from "@/components/tunnels/TunnelTags";
import { TunnelEndpointChip, TunnelLanChip } from "@/components/tunnels/TunnelEndpoint";
import { HostKeyAlert } from "@/components/tunnels/HostKeyAlert";
import { DeviceWarningChip } from "@/components/tunnels/DeviceFacts";
import { DeviceNameChip } from "@/components/tunnels/DeviceInstall";
import { DeviceOsChip, TransportBadge } from "@/components/tunnels/DevicePlatform";
import { SshNameChip } from "@/components/tunnels/TunnelNameHelp";
import { TunnelPresenceButton } from "@/components/tunnels/TunnelPresence";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { useRowLink } from "@/hooks/useRowLink";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface TunnelTableRowProps extends TunnelActionHandlers {
    tunnel: Tunnel;
    isActive: boolean;
    latencyMs: number | null;
    sharedCount: number;
}

/** 每欄的第一行（固定一行高，各欄對齊）。/ A column's first line (one line tall, so columns line up). */
const LINE = "flex h-5 items-center";
/** 每欄的第二行：安靜的字，放不下就折行。/ A column's second line: quiet words, wrapping when they don't fit. */
const QUIET_LINE = "flex flex-wrap items-center leading-5";

export function TunnelTableRow({ tunnel, isActive, latencyMs, sharedCount, ...actions }: TunnelTableRowProps) {
    const { t } = useI18n();
    const health = liveHealth(tunnel, isActive);
    const openDevice = () => actions.onDetails(tunnel.id, "device");
    const href = tunnelPageUrl(tunnel.id);
    const open = useRowLink(href);
    return (
        <tr data-refresh-item {...open} className="group cursor-pointer transition-colors hover:bg-surface">
            {/* 名稱 + 釘選 / 標籤 + 說明 / Name + pin / labels + description */}
            <td className="px-3 py-2 align-top">
                <div className="flex min-w-0 items-start gap-2.5">
                    <div className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border", HEALTH_TILE[health])} aria-hidden>
                        <Server size={14} />
                    </div>
                    <div className="min-w-0 max-w-[18rem]">
                        <div className={cn(LINE, "gap-1")}>
                            <p className="flex min-w-0 items-center text-sm text-foreground" title={tunnel.host_friendly_name}>
                                <Link href={href} prefetch={false} className="min-w-0 truncate rounded-sm underline-offset-4 group-hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
                                    {tunnel.host_friendly_name}
                                </Link>
                                <ChevronRight size={14} className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-foreground" aria-hidden />
                            </p>
                            <PinButton pinned={!!tunnel.pinned} onToggle={actions.onTogglePin ? () => actions.onTogglePin!(tunnel.id, !tunnel.pinned) : undefined} className="size-5" />
                        </div>
                        {/* 標籤 + 說明在同一行，放不下就截斷（完整的說明在 title）。/ Labels + description on one truncating line (the full text in the title). */}
                        {(tunnel.description || (tunnel.labels?.length ?? 0) > 0) && (
                            <p className="truncate text-[0.75rem] leading-5 text-muted-foreground" title={tunnel.description}>
                                <TunnelLabels variant="text" labels={tunnel.labels} onLabel={actions.onLabel} className={tunnel.description ? "mr-2" : undefined} />
                                {tunnel.description}
                            </p>
                        )}
                    </div>
                </div>
            </td>
            {/* 狀態 + 延遲 / 最後上線 + 連線方式 / Status + latency / last seen + way in */}
            <td className="px-3 py-2 align-top">
                <div className={cn(LINE, "gap-2 whitespace-nowrap")}>
                    <TunnelStatusPill health={health} lastSeenAt={tunnel.last_seen_at} />
                    {isActive && <LatencyIndicator rttMs={latencyMs} online={isActive} size="xs" />}
                </div>
                <div className={cn(QUIET_LINE, "gap-x-2")}>
                    {health === "offline" && <TunnelLastSeen at={tunnel.last_seen_at} />}
                    <TransportBadge variant="text" tunnel={tunnel} canManage={!!tunnel.can_share} onOpen={() => actions.onDetails(tunnel.id, "connection")} />
                </div>
            </td>
            {/* 埠 + 作業系統 / 外網 + 內網 + 要注意的事 / Port + OS / public + LAN IP + what needs attention */}
            <td className="px-3 py-2 align-top">
                <div className={cn(LINE, "gap-x-2.5 whitespace-nowrap")}>
                    <span className="font-mono text-xs text-foreground/85" title={t("tunnels.portTitle")}>:{tunnel.reverse_port}</span>
                    <DeviceOsChip variant="text" endpoint={tunnel.endpoint} onOpen={openDevice} />
                </div>
                <div className={cn(QUIET_LINE, "max-w-[30rem] gap-x-2.5")}>
                    <TunnelEndpointChip variant="text" endpoint={tunnel.endpoint} />
                    <TunnelLanChip variant="text" endpoint={tunnel.endpoint} />
                    <HostKeyAlert changed={tunnel.host_key_changed} claimed={tunnel.device_claimed} onOpen={() => actions.onDetails(tunnel.id, "identity")} />
                    <DeviceWarningChip variant="text" endpoint={tunnel.endpoint} onOpen={openDevice} />
                    <DeviceNameChip variant="text" summary={tunnel.device_install} onOpen={() => actions.onDetails(tunnel.id, "connection")} />
                    <SshNameChip variant="text" name={tunnel.host_friendly_name} onOpen={() => actions.onDetails(tunnel.id, "settings")} />
                </div>
            </td>
            {/* 我的關係 + 分享 / 誰在用 / My relation + sharing / who is using it */}
            <td className="px-3 py-2 align-top">
                <div className={cn(QUIET_LINE, "max-w-[22rem]")}>
                    <TunnelAccessBadges variant="text" tunnel={tunnel} sharedCount={sharedCount} onRequests={() => actions.onShare(tunnel.id)} onShare={() => actions.onShare(tunnel.id)} />
                </div>
                {!!tunnel.presence?.count && (
                    <div className={LINE}>
                        <TunnelPresenceButton variant="text" presence={tunnel.presence} tunnelId={tunnel.id} />
                    </div>
                )}
            </td>
            {/* 按鈕欄：點空白處也不換頁。/ The buttons column: a click on its gaps never navigates. */}
            <td data-row-ignore className="cursor-auto px-3 py-2 align-middle whitespace-nowrap text-right">
                <div className="flex items-center justify-end gap-1.5">
                    <TunnelOpenButtons tunnel={tunnel} online={isActive} degraded={health === "degraded"} variant="compact" />
                    <TunnelActions tunnel={tunnel} variant="icon" {...actions} />
                </div>
            </td>
        </tr>
    );
}
