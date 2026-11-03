"use client";

/**
 * 通道頁面的「總覽」：現在的狀況（健康、延遲、怎麼連、系統、位址、誰在用、存取關係、標籤）、開啟按鈕（終端機 / 檔案 /
 * 瀏覽器 / 桌面）、需要處理的事（每件一鍵到它的分頁），以及「快速前往」——常用功能一格一個。
 * A tunnel page's overview: the current state, the open buttons, what needs attention (each one click from its tab),
 * and "Quick access" — the frequent features as tiles.
 */
import React from "react";
import Link from "next/link";
import { Activity, ArrowLeftRight, ArrowRight, Clapperboard, FileCode2, KeyRound, ScrollText, ShieldCheck, TriangleAlert, Users, Waypoints, Wrench, Zap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { LatencyIndicator } from "@/components/ui/LatencyIndicator";
import { TunnelOpenButtons } from "@/components/tunnels/TunnelOpenButtons";
import { TunnelAccessBadges, TunnelLastSeen, TunnelStatusPill } from "@/components/tunnels/TunnelStatus";
import { TunnelEndpointChip, TunnelLanChip } from "@/components/tunnels/TunnelEndpoint";
import { DeviceOsChip, TransportBadge } from "@/components/tunnels/DevicePlatform";
import { TunnelPresenceButton } from "@/components/tunnels/TunnelPresence";
import { TunnelLabels } from "@/components/tunnels/TunnelTags";
import { useFeatures } from "@/hooks/useFeatures";
import { attentionItems, type TunnelTab } from "@/lib/tunnelPage";
import { needsAttention } from "@/lib/deviceInstall";
import { sshSafeName } from "@/lib/tunnelName";
import { getTerminalPageUrl } from "@/lib/tunnelUrls";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

interface Props {
    tunnel: Tunnel;
    health: TunnelHealth;
    online: boolean;
    latency: number | null;
    onTab: (tab: TunnelTab) => void;
    onConfig: () => void;
    onShare: () => void;
}

interface QuickLink {
    id: string;
    icon: LucideIcon;
    label: TranslationKey;
    hint: TranslationKey;
    href?: string;
    onClick?: () => void;
}

export function OverviewPanel({ tunnel, health, online, latency, onTab, onConfig, onShare }: Props) {
    const { t } = useI18n();
    const { has } = useFeatures();
    const install = needsAttention(tunnel.device_install);
    const items = attentionItems({
        hostKeyChanged: tunnel.host_key_changed,
        deviceClaimed: tunnel.device_claimed,
        degraded: health === "degraded",
        deviceWarnings: tunnel.endpoint?.facts?.warnings?.length ?? 0,
        extraInstall: tunnel.device_install?.extra?.length ?? 0,
        olderInstall: install.length - (tunnel.device_install?.extra?.length ?? 0),
        nameOk: sshSafeName(tunnel.host_friendly_name),
        accessRequests: tunnel.access_requests ?? 0,
    });

    const quick: QuickLink[] = [
        { id: "forward", icon: ArrowLeftRight, label: "tunnelActions.portForwarding", hint: "tunnelActions.portForwardingHint", href: `/tunnels/cheatsheet?tunnel=${tunnel.id}` },
        { id: "config", icon: FileCode2, label: "tunnelActions.sshConfig", hint: "tunnelActions.sshConfigHint", onClick: onConfig },
        ...(has("toolbox") && has("terminal") ? [{ id: "toolbox", icon: Wrench, label: "toolbox.menu", hint: "toolbox.menuHint", href: `${getTerminalPageUrl(tunnel)}&toolbox=1` } satisfies QuickLink] : []),
        { id: "keys", icon: KeyRound, label: "tunnelActions.deviceKeys", hint: "tunnelActions.deviceKeysHint", href: `/tunnels/keys/devices?device=${tunnel.id}` },
        ...(has("network") ? [{ id: "lan", icon: Waypoints, label: "tunnelActions.network", hint: "tunnelActions.networkHint", href: `/tunnels/network?tunnel=${tunnel.id}` } satisfies QuickLink] : []),
        { id: "sessions", icon: Users, label: "tunnelPage.quick.sessions", hint: "tunnelPage.quick.sessionsHint", href: `/tunnels/sessions?tunnel=${tunnel.id}` },
        { id: "logs", icon: ScrollText, label: "tunnelActions.logs", hint: "tunnelActions.logsHint", href: `/tunnels/logs?tunnel=${tunnel.id}` },
        ...(tunnel.record_sessions && has("recordings.manage") ? [{ id: "recordings", icon: Clapperboard, label: "recordings.menu", hint: "recordings.menuHint", href: `/tunnels/recordings?tunnel=${tunnel.id}` } satisfies QuickLink] : []),
        ...(has("command_rules.manage") ? [{ id: "rules", icon: ShieldCheck, label: "commands.menu", hint: "commands.menuHint", href: `/tunnels/commands?tunnel=${tunnel.id}` } satisfies QuickLink] : []),
    ];

    return (
        <div className="space-y-6">
            <Section icon={<Activity />} title={t("tunnelPage.now")}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <TunnelStatusPill health={health} lastSeenAt={tunnel.last_seen_at} />
                    {online && <LatencyIndicator rttMs={latency} online={online} size="xs" />}
                    {health === "offline" && <TunnelLastSeen at={tunnel.last_seen_at} />}
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-px font-mono text-[0.75rem] text-foreground/80" title={t("tunnels.portTitle")}>
                        :{tunnel.reverse_port}
                    </span>
                    <TransportBadge tunnel={tunnel} canManage={!!tunnel.can_share} onOpen={() => onTab("connection")} />
                    <DeviceOsChip endpoint={tunnel.endpoint} onOpen={() => onTab("device")} />
                    <TunnelEndpointChip endpoint={tunnel.endpoint} />
                    <TunnelLanChip endpoint={tunnel.endpoint} />
                    <TunnelAccessBadges tunnel={tunnel} sharedCount={tunnel.shared_with_count ?? 0} onRequests={() => onTab("access")} onShare={onShare} />
                    <TunnelPresenceButton presence={tunnel.presence} tunnelId={tunnel.id} />
                    <TunnelLabels labels={tunnel.labels} />
                </div>
                <TunnelOpenButtons tunnel={tunnel} online={online} degraded={health === "degraded"} />
            </Section>

            {items.length > 0 && (
                <Section icon={<TriangleAlert />} title={t("tunnelPage.attention")}>
                    <ul className="space-y-2">
                        {items.map((a) => (
                            <li key={a.kind}>
                                <Callout tone={a.tone}>
                                    <span className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="min-w-0">{t(a.key, { count: a.count ?? 0 })}</span>
                                        <Button type="button" size="sm" variant="outline" onClick={() => onTab(a.tab)}>
                                            {t(`tunnelPage.tab.${a.tab}` as TranslationKey)} <ArrowRight size={14} />
                                        </Button>
                                    </span>
                                </Callout>
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            {/* 快速前往：常用功能一格一個，連結可以 Ctrl / ⌘ 點開新分頁。/ Quick access: links open in a new tab with Ctrl / ⌘. */}
            <Section icon={<Zap />} title={t("tunnelPage.quick.title")} description={t("tunnelPage.quick.description")}>
                <div className="@container">
                    <ul className="grid grid-cols-1 gap-2 @sm:grid-cols-2 @3xl:grid-cols-3">
                        {quick.map((q) => {
                            const Icon = q.icon;
                            const body = (
                                <>
                                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground" aria-hidden>
                                        <Icon size={16} />
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block text-sm text-foreground">{t(q.label)}</span>
                                        <span className="block text-xs leading-snug text-muted-foreground">{t(q.hint)}</span>
                                    </span>
                                </>
                            );
                            const cls = cn("flex h-full min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60");
                            return (
                                <li key={q.id}>
                                    {q.href ? (
                                        <Link href={q.href} prefetch={false} className={cls}>
                                            {body}
                                        </Link>
                                    ) : (
                                        <button type="button" onClick={q.onClick} className={cn(cls, "w-full")}>
                                            {body}
                                        </button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </div>
            </Section>
        </div>
    );
}
