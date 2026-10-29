"use client";

/**
 * 網路拓撲頁（#20）：一眼看出每台裝置背後的區網有哪些機器、哪些能 SSH，並從這裡掃描、編輯、連線。
 * 兩種看法：拓撲樹（依裝置）與「所有主機」（跨裝置的一張表，可排序、篩選、分頁）；搜尋跨裝置找主機，最近用過的主機
 * 排在上面一列。點主機就地展開主機面板（寬螢幕在右邊、其他在上方）；終端機可以開在本頁的 dock（在這裡開），
 * 或明確選「終端機頁」跳過去——這是唯一離開本頁的動作；指令就地產生。
 * Network topology: which machines sit behind each device, which ones speak SSH, and how to reach them. Two
 * views: the tree (by device) and "All hosts" (one table across devices, sortable, filterable, paged); the search
 * finds hosts across devices and recently used hosts sit in a row on top. A host opens an inline panel (right on
 * wide screens, above otherwise); a terminal opens in this page's dock ("Open here") or, when chosen explicitly,
 * on the terminal page — the only action that leaves this page; commands are generated in place.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Waypoints, Search, Router, Server, Terminal, ChevronsDownUp, ChevronsUpDown, Network, List, History, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { KIND_ICON, KIND_TONE, TopologyTree, type HostActions } from "@/components/network/TopologyTree";
import { HostPanel, type HostPanelTab, type OpenTerminalRequest } from "@/components/network/HostPanel";
import { HostTable } from "@/components/network/HostTable";
import { defaultDeviceUser } from "@/components/network/HostOpen";
import { useRecentLanHosts } from "@/hooks/useRecentLanHosts";
import { flattenHosts, initialNetworkView, NETWORK_VIEWS, recentRows, type NetworkView } from "@/lib/lanHosts";
import { DOCK_BAR, DOCK_GAP, DOCK_HEIGHT, TerminalDock } from "@/components/network/TerminalDock";
import { ScanDialog } from "@/components/network/ScanDialog";
import { AddHostDialog } from "@/components/network/AddHostDialog";
import { useNetworkPage } from "@/hooks/useNetworkPage";
import { useLanTerminals } from "@/hooks/useLanTerminals";
import { useTopologyExpansion } from "@/hooks/useTopologyExpansion";
import { useTunnelGroups } from "@/hooks/useTunnelGroups";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { filterDevices, type TopologyFilter } from "@/lib/topology";
import { hasGroupedDevice, matrixSections } from "@/lib/deviceMatrix";
import { TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS } from "@/lib/groups";
import { hostName } from "@/lib/lanConnect";
import { TELEPY_AUTH } from "@/lib/lanAuth";
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

// "auto" = 沒選過（由主機數量決定）。/ "auto" = no choice yet (the host count decides).
const STORED_VIEWS = ["auto", ...NETWORK_VIEWS] as const;

function NetworkInner() {
    const { t } = useI18n();
    const { state, actions } = useNetworkPage();
    const { tunnels, allTunnels, loading, query, stats, focusTunnel } = state;
    const terms = useLanTerminals();
    // 開著的終端機（「終端機頁」此時開新分頁，dock 裡的不會斷）。/ Open terminals: "Terminal page" then opens a new tab so the dock keeps them.
    const openShells = terms.sessions.filter((s) => s.status !== "closed").length;
    const recent = useRecentLanHosts();
    const [storedView, storeView] = useStoredChoice<NetworkView | "auto">("telepy.networkView", STORED_VIEWS, "auto");
    // 這次造訪中自己切過就照選的（深層連結只決定一開始）。/ A switch during this visit wins (a deep link only sets the start).
    const [switched, setSwitched] = useState(false);
    const setView = (v: NetworkView) => {
        setSwitched(true);
        storeView(v);
    };
    // `n` 每次要求都 +1，讓同一台主機的面板也會切到要求的分頁。/ `n` bumps per request so an open panel switches tabs too.
    const [openHost, setOpenHost] = useState<{ tunnelId: number; hostId: number; tab: HostPanelTab; n: number } | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const [scanFor, setScanFor] = useState<number | null>(null);
    const [addFor, setAddFor] = useState<number | null>(null);
    const panelRef = useRef<HTMLElement>(null);
    // 浮動 dock 對齊的頁面欄。/ The page column the floating dock aligns with.
    const pageRef = useRef<HTMLDivElement>(null);

    // 面板拿最新的資料（掃描 / 編輯後會更新）。/ The panel reads the latest data.
    const hostTunnel = useMemo(() => (openHost ? allTunnels.find((x) => x.id === openHost.tunnelId) ?? null : null), [allTunnels, openHost]);
    const host = useMemo(() => hostTunnel?.hosts.find((h) => h.id === openHost?.hostId) ?? null, [hostTunnel, openHost]);
    const scanTunnel = allTunnels.find((x) => x.id === scanFor) ?? null;
    const addTunnel = allTunnels.find((x) => x.id === addFor) ?? null;

    // 主機被刪掉（或沒權限了）時 `host` 是 null，面板自然不顯示。/ A vanished host simply renders no panel.
    const { remember } = recent;
    const onOpenHost = useCallback((h: LanHost, tab: HostPanelTab = "terminal") => {
        setOpenHost((prev) => ({ tunnelId: h.tunnel_id, hostId: h.id, tab, n: (prev?.n ?? 0) + 1 }));
        remember(h.tunnel_id, h.id);
        // 窄螢幕面板在樹上方：捲過去。/ On narrow screens the panel sits above the tree: bring it into view.
        requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }, [remember]);
    const onOpenTerminal = (req: OpenTerminalRequest) => {
        remember(req.tunnel.id, req.host.id);
        return terms.open({ tunnelId: req.tunnel.id, tunnelName: req.tunnel.name, reversePort: req.tunnel.reverse_port, hostId: req.host.id, hostName: hostName(req.host), login: req.login, deviceUser: req.deviceUser, auth: req.auth });
    };
    // 列表 / 樹上的快速動作：用主機的預設帳號、裝置的預設帳號、Telepy 的金鑰。/ Row shortcuts: the host's default login, the device's default account, Telepy's key.
    const hostActions: HostActions = {
        onOpenHost,
        onOpenHere: (h) => {
            const tn = allTunnels.find((x) => x.id === h.tunnel_id);
            const deviceUser = tn ? defaultDeviceUser(tn) : null;
            if (!tn || !deviceUser) return onOpenHost(h);
            if (!onOpenTerminal({ tunnel: tn, host: h, login: h.username ?? "", deviceUser, auth: TELEPY_AUTH })) onOpenHost(h);
        },
        onNavigate: (h) => remember(h.tunnel_id, h.id),
        openShells,
    };

    // 「/」跳到搜尋（不在輸入框裡時）。/ "/" focuses the search (when not typing somewhere).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
            const el = e.target as HTMLElement | null;
            if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.closest(".xterm"))) return;
            e.preventDefault();
            searchRef.current?.focus();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const view = initialNetworkView(storedView === "auto" ? null : storedView, stats.hosts, focusTunnel !== null && !switched);
    const allRows = useMemo(() => flattenHosts(allTunnels), [allTunnels]);
    const tableRows = useMemo(() => flattenHosts(tunnels), [tunnels]);
    const recentList = useMemo(() => recentRows(recent.recent, allRows).slice(0, 6), [recent.recent, allRows]);
    // 開著終端機時，頁面底部與右側面板都要留出 dock 的高度（dock 浮在內容上方；放大時是整個視窗的覆蓋層，不用留）。
    // With terminals open the page bottom and the sticky panel leave room for the floating dock (not when maximised: that is an overlay).
    const dockOffset = terms.sessions.length && terms.size !== "max" ? `calc(${DOCK_BAR} + ${DOCK_HEIGHT[terms.size]} + ${DOCK_GAP} + 0.5rem)` : "0px";
    const onScan = (tn: TopologyTunnel) => setScanFor(tn.id);
    const onAdd = (tn: TopologyTunnel) => setAddFor(tn.id);

    // 機器多時：篩選（全部 / 有主機的 / 在線）、依我的通道群組分成資料夾（跟通道頁的「依群組 / 單一清單」同一個選擇）、
    // 裝置收成一行摘要（展開狀態記在 localStorage）。/ Many machines: a filter, folders by my tunnel groups (the tunnels
    // page's grouping choice) and devices folded into one-line summaries (expansion kept in localStorage).
    const [filter, setFilter] = useState<TopologyFilter>("all");
    const tunnelGroups = useTunnelGroups();
    const [grouping] = useStoredChoice(TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS, "groups");
    const expansion = useTopologyExpansion(allTunnels, focusTunnel);
    const filtered = filterDevices(tunnels, filter, actions.isOnline);
    const filtering = query.trim() !== "" || filter !== "all";
    const grouped = grouping === "groups" && hasGroupedDevice(allTunnels.map((x) => x.id), tunnelGroups.groups);
    const filterOptions: { value: TopologyFilter; label: string }[] = [
        { value: "all", label: `${t("network.filter.all")} (${filtered.counts.all})` },
        { value: "hosts", label: `${t("network.filter.hosts")} (${filtered.counts.hosts})` },
        { value: "online", label: `${t("network.filter.online")} (${filtered.counts.online})` },
    ];
    const sections = grouped ? matrixSections(filtered.shown, allTunnels, tunnelGroups.groups, (x) => x.id, filtering) : null;

    return (
        <div ref={pageRef} className="flex min-h-[calc(100vh-8rem)] flex-col animate-fade-in-up" style={{ "--dock-h": dockOffset, paddingBottom: dockOffset } as React.CSSProperties}>
            <PageHeader
                className="mb-6 shrink-0"
                icon={<Waypoints />}
                title={t("network.title")}
                description={t("network.subtitle")}
                actions={
                    <RefreshButton onRefresh={actions.refresh} ripple={pageRef} label={t("common.refresh")} />
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
                            initialTab={openHost?.tab}
                            tabRequest={openHost?.n}
                            onClose={() => setOpenHost(null)}
                            onNavigate={() => remember(hostTunnel.id, host.id)}
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
                    <div className="grid grid-cols-3 gap-3">
                        <Stat icon={<Router />} label={t("network.stat.devices")} value={`${stats.online}/${stats.devices}`} />
                        <Stat icon={<Server />} label={t("network.stat.hosts")} value={String(stats.hosts)} />
                        <Stat icon={<Terminal />} label={t("network.stat.ssh")} value={String(stats.ssh)} />
                        <div className="relative col-span-3 flex items-center">
                            <Search size={16} className="pointer-events-none absolute left-3 text-muted-foreground" aria-hidden />
                            <Input ref={searchRef} type="search" value={query} onChange={(e) => actions.setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); actions.setQuery(""); } }} placeholder={t("network.searchPlaceholder")} aria-label={t("network.searchPlaceholder")} title={t("network.searchHint")} className="h-full min-h-10 pl-9" />
                        </div>
                    </div>

                    {stats.hosts === 0 && <Callout tone="tip">{t("network.firstScanTip")}</Callout>}

                    {/* 最近用過的主機：一列，點一下打開面板。/ Recently used hosts: one row, a click opens the panel. */}
                    {recentList.length > 0 && (
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                                <History size={14} aria-hidden /> {t("network.recent.title")}
                            </span>
                            {recentList.map((r) => (
                                <button
                                    key={r.host.id}
                                    type="button"
                                    onClick={() => onOpenHost(r.host)}
                                    aria-current={host?.id === r.host.id ? "true" : undefined}
                                    title={`${r.name} · ${r.host.address} · ${r.device.name}`}
                                    className={cn(
                                        "flex min-w-0 max-w-full items-center gap-1.5 rounded-md border bg-card py-1 pl-1 pr-2 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        host?.id === r.host.id ? "border-primary/60" : "border-border"
                                    )}
                                >
                                    <span className={cn("grid size-5 shrink-0 place-items-center rounded-sm ring-1 ring-inset [&_svg]:size-3", KIND_TONE[r.kind])} aria-hidden>{KIND_ICON[r.kind]}</span>
                                    <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{r.name}</span>
                                    <span className="hidden shrink-0 text-muted-foreground @md:inline">{r.device.name}</span>
                                </button>
                            ))}
                            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" onClick={recent.clear} aria-label={t("network.recent.clear")} title={t("network.recent.clear")}>
                                <X size={14} />
                            </Button>
                        </div>
                    )}

                    {/* 窄的時候：看法切換撐滿一列（標籤可換行），裝置篩選改成一個下拉，不會把頁面撐寬。
                        Narrow: the view switch takes the row (labels may wrap) and the device filter becomes one select,
                        so neither widens the page. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <Segmented
                            size="sm"
                            fullWidth
                            className="w-full @lg:w-auto"
                            value={view}
                            onChange={setView}
                            aria-label={t("network.view.aria")}
                            options={[
                                { value: "tree", label: t("network.view.tree"), icon: <Network size={14} /> },
                                { value: "hosts", label: `${t("network.view.hosts")} (${tableRows.length})`, icon: <List size={14} /> },
                            ]}
                        />
                        {view === "tree" && (
                            <>
                                <Segmented
                                    size="sm"
                                    className="hidden @2xl:inline-flex"
                                    value={filter}
                                    onChange={setFilter}
                                    aria-label={t("network.filterAria")}
                                    options={filterOptions}
                                />
                                <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as TopologyFilter)} aria-label={t("network.filterAria")} className="h-8 w-auto min-w-0 max-w-full text-sm @2xl:hidden">
                                    {filterOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </NativeSelect>
                            </>
                        )}
                        {view === "tree" && !filtering && (
                            <span className="ml-auto flex items-center gap-1">
                                <Button variant="ghost" size="sm" onClick={() => expansion.expandAll(filtered.shown.filter((x) => x.hosts.length > 0).map((x) => x.id))}>
                                    <ChevronsUpDown /> {t("network.expandAll")}
                                </Button>
                                <Button variant="ghost" size="sm" onClick={expansion.collapseAll} disabled={!expansion.anyExpanded}>
                                    <ChevronsDownUp /> {t("network.collapseAll")}
                                </Button>
                            </span>
                        )}
                    </div>

                    {view === "hosts" ? (
                        <HostTable
                            rows={tableRows}
                            pageKey={query}
                            selectedHostId={host?.id ?? null}
                            isOnline={actions.isOnline}
                            onOpenHost={onOpenHost}
                            onOpenHere={hostActions.onOpenHere}
                            onNavigate={hostActions.onNavigate}
                            openShells={openShells}
                        />
                    ) : filtered.shown.length === 0 ? (
                        <p className="py-8 text-center text-sm text-muted-foreground">{t("network.noMatch", { query })}</p>
                    ) : (
                        <TopologyTree
                            tunnels={filtered.shown}
                            sections={sections}
                            filtering={filtering}
                            pageKey={`${query}|${filter}|${grouped}`}
                            expansion={expansion}
                            isOnline={actions.isOnline}
                            focusTunnel={focusTunnel}
                            selectedHostId={host?.id ?? null}
                            hostActions={hostActions}
                            onScan={onScan}
                            onAdd={onAdd}
                        />
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
                onDuplicate={terms.duplicate}
                onClose={terms.close}
                onCloseAll={terms.closeAll}
                onReconnect={terms.reconnect}
                onStatus={terms.setStatus}
                onShell={terms.setShell}
                setSize={terms.setSize}
                anchorRef={pageRef}
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
