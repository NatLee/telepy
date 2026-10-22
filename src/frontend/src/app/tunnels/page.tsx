"use client";

/**
 * 通道列表頁：統計兼篩選方塊、搜尋、卡片 / 清單檢視、WebSocket 即時狀態、動作選單與彈窗。
 * Tunnels list page: stat/filter tiles, search, card / list views, live WebSocket status, actions menu and modals.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TunnelModals } from "@/components/tunnels/TunnelModals";
import { Plus, Network, Info, RefreshCw, Search, X, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { TunnelCard } from "@/components/tunnels/TunnelCard";
import { TunnelTableRow } from "@/components/tunnels/TunnelTableRow";
import { TunnelFilterTiles, type TunnelFilter } from "@/components/tunnels/TunnelFilterTiles";
import { ViewToggle } from "@/components/ui/ViewToggle";

import { useTunnelsPage } from "@/hooks/useTunnelsPage";
import { useViewMode } from "@/hooks/useViewMode";
import { useI18n } from "@/lib/i18n";
import { Tunnel, TunnelActionHandlers } from "@/types/tunnel";

const TH = "px-4 py-3 text-left text-[11px] font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap";

export default function TunnelsPage() {
    const { t } = useI18n();
    const router = useRouter();
    const {
        tunnels,
        portsMap,
        latencyMap,
        loading,
        fetchData,
        handleDelete,
        handleLeaveTunnel,
        modals: {
            configModal, setConfigModal,
            scriptModal, setScriptModal,
            usersModal, setUsersModal,
            detailsModal, setDetailsModal,
            shareModal, setShareModal,
            deleteConfirm, setDeleteConfirm,
            leaveConfirm, setLeaveConfirm
        }
    } = useTunnelsPage();

    const [viewMode, setViewMode] = useViewMode("tunnels-view");
    const [filter, setFilter] = useState<TunnelFilter>("all");
    const [query, setQuery] = useState("");

    const isOnline = (tunnel: Tunnel) => portsMap[String(tunnel.reverse_port)] === true;

    const counts = useMemo(() => {
        const online = tunnels.filter(tn => portsMap[String(tn.reverse_port)] === true).length;
        return {
            all: tunnels.length,
            online,
            offline: tunnels.length - online,
            shared: tunnels.filter(tn => !tn.is_owner).length,
        };
    }, [tunnels, portsMap]);

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return tunnels.filter((tn) => {
            const online = portsMap[String(tn.reverse_port)] === true;
            if (filter === "online" && !online) return false;
            if (filter === "offline" && online) return false;
            if (filter === "shared" && tn.is_owner) return false;
            if (!q) return true;
            return (
                tn.host_friendly_name.toLowerCase().includes(q) ||
                String(tn.reverse_port).includes(q) ||
                (tn.description ?? "").toLowerCase().includes(q)
            );
        });
    }, [tunnels, portsMap, filter, query]);

    const actions: TunnelActionHandlers = {
        onDetails: (tunnelId) => setDetailsModal({ isOpen: true, tunnelId }),
        onConfig: (tunnelId) => setConfigModal({ isOpen: true, tunnelId }),
        onScript: (tunnelId) => setScriptModal({ isOpen: true, tunnelId, sshPort: 22 }),
        onLogs: (tunnelId) => router.push(`/tunnels/logs?tunnel=${tunnelId}`),
        onCommands: (tunnelId) => router.push(`/tunnels/cheatsheet?tunnel=${tunnelId}`),
        onUsers: (tunnelId, readOnly) => setUsersModal({ isOpen: true, tunnelId, readOnly }),
        onShare: (tunnelId) => setShareModal({ isOpen: true, tunnelId }),
        onLeave: (tunnelId, name) => setLeaveConfirm({ isOpen: true, tunnelId, name }),
        onDelete: (tunnelId, name) => setDeleteConfirm({ isOpen: true, tunnelId, name }),
    };

    const clearFilters = () => {
        setFilter("all");
        setQuery("");
    };

    return (
        <div className="space-y-6 animate-fade-in-up">
            {/* 標題列 / Page header */}
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                <div className="flex items-start gap-4">
                    <div className="hidden sm:grid place-items-center w-12 h-12 rounded-2xl bg-brand-gradient shadow-glow shrink-0" aria-hidden>
                        <Network className="text-white" size={22} />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-foreground flex items-center gap-2 tracking-tight">
                            {t("tunnels.title")}
                            <TooltipProvider delayDuration={100}>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <button className="text-muted-foreground hover:text-primary transition-colors focus:outline-none" aria-label={t("tunnels.aboutAria")}>
                                            <Info size={18} />
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-xs text-sm" sideOffset={8}>
                                        <p>{t("tunnels.aboutTooltip")}</p>
                                    </TooltipContent>
                                </Tooltip>
                            </TooltipProvider>
                        </h1>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t("tunnels.subtitle")}
                        </p>
                    </div>
                </div>
                <div className="flex gap-2 items-center">
                    <Button variant="outline" onClick={fetchData} disabled={loading} aria-label={t("tunnels.refreshAria")}>
                        <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
                        {t("common.refresh")}
                    </Button>
                    <Button asChild className="shadow-glow">
                        <Link href="/tunnels/create" prefetch={false}>
                            <Plus size={16} />
                            {t("tunnels.create")}
                        </Link>
                    </Button>
                </div>
            </div>

            {loading && tunnels.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                    {t("tunnels.loading")}
                </div>
            ) : tunnels.length === 0 ? (
                <div className="relative overflow-hidden flex flex-col items-center justify-center p-16 border border-dashed border-border rounded-3xl bg-card/70 backdrop-blur-sm text-center">
                    <div className="grid place-items-center w-16 h-16 rounded-2xl bg-brand-gradient shadow-glow mb-5 animate-float" aria-hidden>
                        <Network size={28} className="text-white" />
                    </div>
                    <h3 className="text-xl font-semibold text-foreground tracking-tight">{t("tunnels.emptyTitle")}</h3>
                    <p className="mt-2 text-sm text-muted-foreground max-w-sm">{t("tunnels.emptyBody")}</p>
                    <div className="mt-6">
                        <Button asChild className="shadow-glow">
                            <Link href="/tunnels/create" prefetch={false}>
                                <Plus size={16} />
                                {t("tunnels.new")}
                            </Link>
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <TunnelFilterTiles counts={counts} value={filter} onChange={setFilter} />

                    {/* 搜尋 + 檢視切換 / Search + view toggle */}
                    <div className="flex items-center gap-2">
                        <div className="relative flex-1 max-w-md">
                            <Search size={16} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground pointer-events-none" aria-hidden />
                            <Input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={t("tunnels.searchPlaceholder")}
                                aria-label={t("tunnels.searchPlaceholder")}
                                className="pl-9 pr-9 h-10 bg-card/80 backdrop-blur-sm"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    className="absolute right-2 top-1/2 z-10 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                                    aria-label={t("tunnels.clearSearch")}
                                >
                                    <X size={14} />
                                </button>
                            )}
                        </div>
                        <span className="hidden sm:inline text-xs text-muted-foreground tabular-nums">
                            {t("tunnels.showingCount", { shown: visible.length, total: tunnels.length })}
                        </span>
                        <div className="ml-auto hidden min-[1200px]:flex items-center">
                            <ViewToggle value={viewMode} onChange={setViewMode} storageKey="tunnels-view" />
                        </div>
                    </div>

                    {visible.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 p-12 rounded-2xl border border-dashed border-border bg-card/60 text-center">
                            <SearchX size={32} className="text-muted-foreground/60" aria-hidden />
                            <p className="text-sm text-muted-foreground">{t("tunnels.noMatch")}</p>
                            <Button variant="outline" size="sm" onClick={clearFilters}>{t("tunnels.clearFilters")}</Button>
                        </div>
                    ) : viewMode === "card" ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-5">
                            {visible.map((tunnel) => (
                                <TunnelCard
                                    key={tunnel.id}
                                    tunnel={tunnel}
                                    isActive={isOnline(tunnel)}
                                    latencyMs={latencyMap[String(tunnel.reverse_port)] ?? null}
                                    sharedCount={tunnel.shared_with_count ?? 0}
                                    {...actions}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="border border-border rounded-2xl overflow-x-auto bg-card/85 backdrop-blur-sm shadow-card">
                            <table className="min-w-full divide-y divide-border">
                                <thead className="bg-muted/40">
                                    <tr>
                                        <th scope="col" className={TH}>{t("tunnels.thName")}</th>
                                        <th scope="col" className={TH}>{t("tunnels.thStatus")}</th>
                                        <th scope="col" className={TH}>{t("tunnels.thPort")}</th>
                                        <th scope="col" className={TH}>{t("tunnels.thAccess")}</th>
                                        <th scope="col" className={`${TH} text-right`}>{t("tunnels.thActions")}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-border">
                                    {visible.map((tunnel) => (
                                        <TunnelTableRow
                                            key={tunnel.id}
                                            tunnel={tunnel}
                                            isActive={isOnline(tunnel)}
                                            latencyMs={latencyMap[String(tunnel.reverse_port)] ?? null}
                                            sharedCount={tunnel.shared_with_count ?? 0}
                                            {...actions}
                                        />
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}

            <TunnelModals
                modals={{
                    configModal, setConfigModal,
                    scriptModal, setScriptModal,
                    usersModal, setUsersModal,
                    detailsModal, setDetailsModal,
                    shareModal, setShareModal,
                    deleteConfirm, setDeleteConfirm,
                    leaveConfirm, setLeaveConfirm
                }}
                tunnels={tunnels}
                fetchData={fetchData}
                handleDelete={handleDelete}
                handleLeaveTunnel={handleLeaveTunnel}
            />
        </div>
    );
}
