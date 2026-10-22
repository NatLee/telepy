"use client";

/**
 * 網路拓撲頁（#20）：一眼看出每台裝置背後的區網有哪些機器、哪些能 SSH，並從這裡掃描、編輯、連線。
 * Network topology: which machines sit behind each device, which ones speak SSH, and how to reach them.
 */
import React, { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { Waypoints, RefreshCw, Search, Router, Server, Terminal } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { TopologyTree } from "@/components/network/TopologyTree";
import { HostDialog } from "@/components/network/HostDialog";
import { ScanDialog } from "@/components/network/ScanDialog";
import { AddHostDialog } from "@/components/network/AddHostDialog";
import { useNetworkPage } from "@/hooks/useNetworkPage";
import { useI18n } from "@/lib/i18n";
import type { LanHost, TopologyTunnel } from "@/types/lan";

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
    return (
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 shadow-card">
            <span className="grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4" aria-hidden>{icon}</span>
            <div className="min-w-0">
                <p className="text-lg leading-tight text-foreground">{value}</p>
                <p className="truncate text-xs text-muted-foreground">{label}</p>
            </div>
        </div>
    );
}

function NetworkInner() {
    const { t } = useI18n();
    const { state, actions } = useNetworkPage();
    const { tunnels, allTunnels, loading, query, stats, focusTunnel } = state;
    const [openHost, setOpenHost] = useState<{ tunnelId: number; hostId: number } | null>(null);
    const [scanFor, setScanFor] = useState<number | null>(null);
    const [addFor, setAddFor] = useState<number | null>(null);

    // 視窗拿最新的資料（掃描 / 編輯後會更新）。/ Dialogs read the latest data.
    const hostTunnel = useMemo(() => (openHost ? allTunnels.find((x) => x.id === openHost.tunnelId) ?? null : null), [allTunnels, openHost]);
    const host = useMemo(() => hostTunnel?.hosts.find((h) => h.id === openHost?.hostId) ?? null, [hostTunnel, openHost]);
    const scanTunnel = allTunnels.find((x) => x.id === scanFor) ?? null;
    const addTunnel = allTunnels.find((x) => x.id === addFor) ?? null;

    const onOpenHost = (h: LanHost) => setOpenHost({ tunnelId: h.tunnel_id, hostId: h.id });
    const onScan = (tn: TopologyTunnel) => setScanFor(tn.id);
    const onAdd = (tn: TopologyTunnel) => setAddFor(tn.id);

    return (
        <div className="flex min-h-[calc(100vh-8rem)] flex-col animate-fade-in-up">
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
                <div className="rounded-2xl border border-dashed border-border p-10 text-center">
                    <p className="text-muted-foreground">{t("network.noDevices")}</p>
                    <Button asChild className="mt-4">
                        <Link href="/tunnels/create" prefetch={false}>{t("network.createTunnel")}</Link>
                    </Button>
                </div>
            ) : (
                <div className="space-y-5">
                    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                        <Stat icon={<Router />} label={t("network.stat.devices")} value={`${stats.online}/${stats.devices}`} />
                        <Stat icon={<Server />} label={t("network.stat.hosts")} value={String(stats.hosts)} />
                        <Stat icon={<Terminal />} label={t("network.stat.ssh")} value={String(stats.ssh)} />
                        <div className="relative col-span-2 flex items-center lg:col-span-1">
                            <Search size={16} className="pointer-events-none absolute left-3 text-muted-foreground" aria-hidden />
                            <Input value={query} onChange={(e) => actions.setQuery(e.target.value)} placeholder={t("network.searchPlaceholder")} aria-label={t("network.searchPlaceholder")} className="h-full min-h-10 pl-9" />
                        </div>
                    </div>

                    {stats.hosts === 0 && <Callout tone="tip">{t("network.firstScanTip")}</Callout>}

                    {tunnels.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">{t("network.noMatch", { query })}</p>
                    ) : (
                        <TopologyTree tunnels={tunnels} isOnline={actions.isOnline} focusTunnel={focusTunnel} onOpenHost={onOpenHost} onScan={onScan} onAdd={onAdd} />
                    )}

                    <p className="text-xs text-muted-foreground">{t("network.howItWorks")}</p>
                </div>
            )}

            <HostDialog
                host={host}
                tunnel={hostTunnel}
                online={hostTunnel ? actions.isOnline(hostTunnel) : false}
                onClose={() => setOpenHost(null)}
                loadConnectTarget={actions.loadConnectTarget}
                updateHost={actions.updateHost}
                deleteHost={actions.deleteHost}
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
