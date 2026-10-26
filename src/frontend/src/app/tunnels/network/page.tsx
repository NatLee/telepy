"use client";

/**
 * 網路拓撲頁（#20）：一眼看出每台裝置背後的區網有哪些機器、哪些能 SSH，並從這裡掃描、編輯、連線。
 * 點主機就地展開主機面板（寬螢幕在右邊、其他在上方）；終端機開在本頁底部的 dock、指令就地產生，不跳頁。
 * Network topology: which machines sit behind each device, which ones speak SSH, and how to reach them.
 * A host opens an inline panel (right on wide screens, above otherwise); terminals open in this page's
 * dock and commands are generated in place — nothing navigates away.
 */
import React, { Suspense, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Waypoints, RefreshCw, Search, Router, Server, Terminal } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { TopologyTree } from "@/components/network/TopologyTree";
import { HostPanel, type OpenTerminalRequest } from "@/components/network/HostPanel";
import { DOCK_BAR, DOCK_HEIGHT, TerminalDock } from "@/components/network/TerminalDock";
import { ScanDialog } from "@/components/network/ScanDialog";
import { AddHostDialog } from "@/components/network/AddHostDialog";
import { useNetworkPage } from "@/hooks/useNetworkPage";
import { useLanTerminals } from "@/hooks/useLanTerminals";
import { hostName } from "@/lib/lanConnect";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/**
 * 統計卡。欄窄（手機三欄）時圖示縮到數字旁邊、標籤可以換行，字不會被截成「…」。
 * A stat tile. In a narrow column (three across on a phone) the icon moves next to the value and the label wraps
 * instead of being cut to "…".
 */
function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card">
            <span className="hidden size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground @xl:grid [&_svg]:size-4" aria-hidden>{icon}</span>
            <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-lg leading-tight text-foreground">
                    <span className="text-muted-foreground @xl:hidden [&_svg]:size-3.5" aria-hidden>{icon}</span>
                    {value}
                </p>
                <p className="text-xs leading-snug text-muted-foreground">{label}</p>
            </div>
        </div>
    );
}

function NetworkInner() {
    const { t } = useI18n();
    const { state, actions } = useNetworkPage();
    const { tunnels, allTunnels, loading, query, stats, focusTunnel } = state;
    const terms = useLanTerminals();
    const [openHost, setOpenHost] = useState<{ tunnelId: number; hostId: number } | null>(null);
    const [scanFor, setScanFor] = useState<number | null>(null);
    const [addFor, setAddFor] = useState<number | null>(null);
    const panelRef = useRef<HTMLElement>(null);

    // 面板拿最新的資料（掃描 / 編輯後會更新）。/ The panel reads the latest data.
    const hostTunnel = useMemo(() => (openHost ? allTunnels.find((x) => x.id === openHost.tunnelId) ?? null : null), [allTunnels, openHost]);
    const host = useMemo(() => hostTunnel?.hosts.find((h) => h.id === openHost?.hostId) ?? null, [hostTunnel, openHost]);
    const scanTunnel = allTunnels.find((x) => x.id === scanFor) ?? null;
    const addTunnel = allTunnels.find((x) => x.id === addFor) ?? null;

    // 主機被刪掉（或沒權限了）時 `host` 是 null，面板自然不顯示。/ A vanished host simply renders no panel.
    const onOpenHost = (h: LanHost) => {
        setOpenHost({ tunnelId: h.tunnel_id, hostId: h.id });
        // 窄螢幕面板在樹上方：捲過去。/ On narrow screens the panel sits above the tree: bring it into view.
        requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    };
    const onOpenTerminal = (req: OpenTerminalRequest) =>
        terms.open({ tunnelId: req.tunnel.id, tunnelName: req.tunnel.name, hostId: req.host.id, hostName: hostName(req.host), login: req.login, deviceUser: req.deviceUser });
    // 開著終端機時，右側面板的高度要扣掉 dock。/ The sticky panel leaves room for the dock.
    const dockOffset = terms.sessions.length ? `calc(${DOCK_BAR} + ${DOCK_HEIGHT[terms.size]})` : "0px";
    const onScan = (tn: TopologyTunnel) => setScanFor(tn.id);
    const onAdd = (tn: TopologyTunnel) => setAddFor(tn.id);

    return (
        <div className="flex min-h-[calc(100vh-8rem)] flex-col animate-fade-in-up" style={{ "--dock-h": dockOffset } as React.CSSProperties}>
            <PageHeader
                className="mb-6 shrink-0"
                icon={<Waypoints />}
                title={t("network.title")}
                description={t("network.subtitle")}
                actions={
                    <Button onClick={() => void actions.refresh()} variant="outline">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            {loading ? (
                <div className="flex flex-1 items-center justify-center py-12">
                    <div className="flex flex-col items-center">
                        <div className="mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                        <p className="text-muted-foreground">{t("network.loading")}</p>
                    </div>
                </div>
            ) : allTunnels.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-10 text-center">
                    <p className="text-muted-foreground">{t("network.noDevices")}</p>
                    <Button asChild className="mt-4">
                        <Link href="/tunnels/create" prefetch={false}>{t("network.createTunnel")}</Link>
                    </Button>
                </div>
            ) : (
                // 欄寬一定要 minmax(0,…)，不然長指令會把欄撐寬（手機上整個面板超出畫面）。/ minmax(0,…) keeps long commands from widening the column.
                <div className={cn("grid grid-cols-[minmax(0,1fr)] items-start gap-5", host && hostTunnel && "xl:grid-cols-[minmax(0,1fr)_34rem]")}>
                {host && hostTunnel && (
                    <aside ref={panelRef} className="min-w-0 scroll-mt-20 xl:order-last xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem-var(--dock-h))] xl:overflow-y-auto">
                        <HostPanel
                            key={host.id}
                            host={host}
                            tunnel={hostTunnel}
                            online={actions.isOnline(hostTunnel)}
                            sessions={terms.sessions}
                            onClose={() => setOpenHost(null)}
                            onOpenTerminal={onOpenTerminal}
                            onShowSession={terms.select}
                            loadConnectTarget={actions.loadConnectTarget}
                            updateHost={actions.updateHost}
                            deleteHost={actions.deleteHost}
                        />
                    </aside>
                )}
                <div className="@container min-w-0 space-y-5">
                    {/* 統計列也依欄寬排（旁邊開著主機面板時會窄）。/ Stats follow the column's width too. */}
                    <div className="grid grid-cols-3 gap-3 @2xl:grid-cols-4">
                        <Stat icon={<Router />} label={t("network.stat.devices")} value={`${stats.online}/${stats.devices}`} />
                        <Stat icon={<Server />} label={t("network.stat.hosts")} value={String(stats.hosts)} />
                        <Stat icon={<Terminal />} label={t("network.stat.ssh")} value={String(stats.ssh)} />
                        <div className="relative col-span-3 flex items-center @2xl:col-span-1">
                            <Search size={16} className="pointer-events-none absolute left-3 text-muted-foreground" aria-hidden />
                            <Input value={query} onChange={(e) => actions.setQuery(e.target.value)} placeholder={t("network.searchPlaceholder")} aria-label={t("network.searchPlaceholder")} className="h-full min-h-10 pl-9" />
                        </div>
                    </div>

                    {stats.hosts === 0 && <Callout tone="tip">{t("network.firstScanTip")}</Callout>}

                    {tunnels.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">{t("network.noMatch", { query })}</p>
                    ) : (
                        <TopologyTree tunnels={tunnels} isOnline={actions.isOnline} focusTunnel={focusTunnel} selectedHostId={host?.id ?? null} onOpenHost={onOpenHost} onScan={onScan} onAdd={onAdd} />
                    )}

                    <p className="text-xs text-muted-foreground">{t("network.howItWorks")}</p>
                </div>
                </div>
            )}

            <TerminalDock
                sessions={terms.sessions}
                activeKey={terms.activeKey}
                size={terms.size}
                onSelect={terms.select}
                onClose={terms.close}
                onCloseAll={terms.closeAll}
                onReconnect={terms.reconnect}
                onStatus={terms.setStatus}
                setSize={terms.setSize}
            />
            <ScanDialog tunnel={scanTunnel} onClose={() => setScanFor(null)} startScan={actions.startScan} />
            <AddHostDialog tunnel={addTunnel} onClose={() => setAddFor(null)} addHost={actions.addHost} />
        </div>
    );
}

export default function NetworkPage() {
    return (
        <Suspense fallback={null}>
            <NetworkInner />
        </Suspense>
    );
}
