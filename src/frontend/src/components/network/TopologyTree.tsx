"use client";

/**
 * 拓撲樹：Telepy →（我的通道群組）→ 裝置 → 區網主機。群組是可收合的資料夾節點；裝置收起來時是一行摘要（狀態、
 * 各種主機幾台、掃描進度），展開才是裝置卡 + 主機；裝置與主機在樹裡分頁（「‹ 1–10 / 40 ›」掛在最後一個分支），
 * 機器再多樹也不會長到好幾個畫面。樹本身窄（手機、或旁邊開著主機面板）時主機縮排在裝置下方，夠寬（容器
 * ≥ 48rem）時排在裝置右邊；連線用細線畫，線上的裝置是實線、離線是虛線。選到的主機用 primary 框起來。
 * The topology tree: Telepy → (my tunnel groups) → devices → LAN hosts. Groups are collapsible folder nodes; a
 * collapsed device is a one-line summary (status, how many hosts of each kind, scan progress) and expands into the
 * device card + hosts; devices and hosts page inside the tree ("‹ 1–10 of 40 ›" on the last branch), so many
 * machines never make it screens long. Hosts sit under the device while the tree itself is narrow (phones, or
 * beside the host panel) and to its right once it is ≥ 48rem wide (container query); links are hairlines, solid
 * for online devices and dashed for offline ones. The selected host is outlined.
 */
import React, { useEffect, useRef } from "react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Router, Terminal, Monitor, HardDrive, Globe, CircleDot, Radar, Plus, Loader2, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { Pagination } from "@/components/ui/pagination";
import { useSectionPages, type PaginationState } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { kindCounts } from "@/lib/topology";
import type { MatrixSection } from "@/lib/deviceMatrix";
import { Badge } from "@/components/ui/badge";
import { TunnelEndpointChip, TunnelLanChip } from "@/components/tunnels/TunnelEndpoint";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { hasSsh, hostKind, hostName, shortVendor, scanPercent, scanRunning, type HostKind } from "@/lib/lanConnect";
import type { LanHost, TopologyTunnel } from "@/types/lan";

const KIND_ORDER: readonly HostKind[] = ["ssh", "desktop", "files", "web", "other"];

const KIND_LABEL: Record<HostKind, TranslationKey> = {
    ssh: "network.kind.ssh",
    desktop: "network.kind.desktop",
    files: "network.kind.files",
    web: "network.kind.web",
    other: "network.kind.other",
};

const KIND_ICON: Record<HostKind, React.ReactNode> = {
    ssh: <Terminal size={16} />,
    desktop: <Monitor size={16} />,
    files: <HardDrive size={16} />,
    web: <Globe size={16} />,
    other: <CircleDot size={16} />,
};

const KIND_TONE: Record<HostKind, string> = {
    ssh: "bg-success/12 text-success ring-success/20",
    desktop: "bg-primary/10 text-primary ring-primary/15",
    files: "bg-warning/12 text-warning ring-warning/20",
    web: "bg-primary/10 text-primary ring-primary/15",
    other: "bg-muted text-muted-foreground ring-border",
};

const PERMISSION_LABEL: Record<string, TranslationKey> = {
    owner: "network.permission.owner",
    admin: "network.permission.admin",
    edit: "network.permission.edit",
    view: "network.permission.view",
};

export const PHASE_LABEL: Record<string, TranslationKey> = {
    connecting: "network.phase.connecting",
    networks: "network.phase.networks",
    discovery: "network.phase.discovery",
    ports: "network.phase.ports",
    names: "network.phase.names",
    done: "network.phase.done",
    failed: "network.phase.failed",
};

/**
 * 樹的一個分支：左邊一條縱線（最後一個子節點只畫到橫線為止）+ 一條橫線接到內容。`tickTop` = 橫線離分支頂端的距離。
 * One branch: a vertical trunk (the last child stops at its tick) plus a tick into the content.
 */
function Branch({ last, first, tickTop, solid, hideFirstStubOnWide, children }: {
    last: boolean;
    first: boolean;
    tickTop: number;
    solid: boolean;
    /** 寬螢幕上第一個主機由裝置的橫線接進來，不畫上方那截。/ On wide screens the device's connector feeds the first host. */
    hideFirstStubOnWide?: boolean;
    children: React.ReactNode;
}) {
    return (
        <li className="relative pl-4 pt-2 @md:pl-7">
            <span aria-hidden className={cn("absolute left-0 top-0 w-px bg-border", first && hideFirstStubOnWide && "@3xl:hidden")} style={{ height: tickTop }} />
            {!last && <span aria-hidden className="absolute left-0 bottom-0 w-px bg-border" style={{ top: tickTop }} />}
            <span
                aria-hidden
                className={cn("absolute left-0 w-3 border-t @md:w-6", solid ? "border-success/60" : "border-dashed border-muted-foreground/40")}
                style={{ top: tickTop }}
            />
            {children}
        </li>
    );
}

function HostChip({ host, selected, onOpen }: { host: LanHost; selected: boolean; onOpen: (h: LanHost) => void }) {
    const { t } = useI18n();
    const kind = hostKind(host);
    const name = hostName(host);
    const shown = host.open_ports.slice(0, 4);
    const more = host.open_ports.length - shown.length;
    return (
        <button
            type="button"
            onClick={() => onOpen(host)}
            aria-current={selected ? "true" : undefined}
            title={name}
            className={cn(
                "group flex w-full items-start gap-3 rounded-xl border px-3 py-2 text-left transition-[background-color,box-shadow] hover:bg-card hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl:w-80",
                selected ? "border-primary/60 bg-card ring-1 ring-primary/30" : "border-border bg-surface"
            )}
        >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", KIND_TONE[kind])} aria-hidden>
                {KIND_ICON[kind]}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                    <span className="line-clamp-2 min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{name}</span>
                    {host.source === "manual" && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{t("network.manualTag")}</span>}
                </span>
                {/* 位址、廠牌、port 放不下就換行，不截斷；port 整組一起換到下一行。/ Address, vendor and ports wrap rather than being cut; the ports move as one group. */}
                <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                    {name !== host.address && <span className="font-mono [overflow-wrap:anywhere]">{host.address}</span>}
                    {host.vendor && <span className="text-[0.6875rem]" title={host.vendor}>{shortVendor(host.vendor)}</span>}
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                        {shown.map((p) => (
                            <span key={p} className={cn("rounded px-1 font-mono text-[0.6875rem] leading-4", p === host.ssh_port && hasSsh(host) ? "bg-success/12 text-success" : "bg-muted")}>
                                {p}
                            </span>
                        ))}
                        {more > 0 && <span className="text-[0.6875rem]">+{more}</span>}
                        {host.open_ports.length === 0 && <span className="text-[0.6875rem]">{t("network.noOpenPorts")}</span>}
                    </span>
                </span>
            </span>
        </button>
    );
}

function ScanProgress({ tn }: { tn: TopologyTunnel }) {
    const { t } = useI18n();
    const s = tn.scan;
    if (!s || !scanRunning(s)) return null;
    const pct = scanPercent(s);
    return (
        <div className="mt-3 rounded-lg bg-surface px-3 py-2" role="status" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 text-foreground">
                    <Loader2 size={12} className="animate-spin text-primary" />
                    {t(PHASE_LABEL[s.phase] ?? "network.phase.connecting")}
                </span>
                <span className="font-mono text-muted-foreground">{s.total ? `${s.probed}/${s.total}` : ""}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                    className={cn("h-full rounded-full bg-primary transition-[width] duration-500", pct === null && "w-1/3 animate-pulse")}
                    style={pct === null ? undefined : { width: `${pct}%` }}
                />
            </div>
            <p className="mt-1 text-[0.75rem] text-muted-foreground">{t("network.foundSoFar", { count: s.hosts_found, by: s.started_by })}</p>
        </div>
    );
}

function DeviceCard({ tn, online, onScan, onAdd, focused, onCollapse }: {
    tn: TopologyTunnel;
    online: boolean;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
    focused: boolean;
    onCollapse: () => void;
}) {
    const { t } = useI18n();
    const running = scanRunning(tn.scan);
    const permission = PERMISSION_LABEL[tn.permission];
    return (
        <div
            className={cn(
                "w-full rounded-xl border bg-card p-3 shadow-card @3xl:w-80",
                focused ? "border-primary ring-2 ring-primary/30" : "border-border"
            )}
        >
            <div className="flex items-start gap-3">
                <span className={cn("relative grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset", online ? "bg-success/10 text-success ring-success/20" : "bg-muted text-muted-foreground ring-border")} aria-hidden>
                    <Router size={18} />
                    <span className={cn("absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/50")} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[1rem] text-foreground [overflow-wrap:anywhere]" title={tn.name}>{tn.name}</p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{online ? (tn.rtt_ms !== null ? t("network.onlineRtt", { ms: tn.rtt_ms }) : t("network.online")) : t("network.offline")}</span>
                        <span>·</span>
                        <span>{t("network.hostCount", { count: tn.hosts.length })}</span>
                    </p>
                    {/* 裝置自己的位址：內網（網卡）與外網，點一下複製。/ The device's own addresses: LAN and public, click to copy. */}
                    {tn.endpoint && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <TunnelLanChip endpoint={tn.endpoint} />
                            <TunnelEndpointChip endpoint={tn.endpoint} />
                        </div>
                    )}
                </div>
                {permission && tn.permission !== "owner" && (
                    <Badge variant="outline" className="shrink-0 text-[0.6875rem]">{t(permission)}</Badge>
                )}
                <Button variant="ghost" size="icon-sm" className="-mr-1 -mt-1 shrink-0 text-muted-foreground" onClick={onCollapse} aria-expanded aria-label={t("network.collapseDevice", { name: tn.name })} title={t("network.collapseDevice", { name: tn.name })}>
                    <ChevronRight className="rotate-90" />
                </Button>
            </div>
            {(tn.can_scan || tn.can_edit) && (
                <div className="mt-3 flex flex-wrap gap-2">
                    {tn.can_scan && (
                        <Button size="sm" variant="outline" className="h-8 grow gap-1.5 text-xs" disabled={running || !online} onClick={() => onScan(tn)} title={!online ? t("network.scanNeedsOnline") : undefined}>
                            <Radar size={14} /> {running ? t("network.scanning") : t("network.scan")}
                        </Button>
                    )}
                    {tn.can_edit && (
                        <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-xs" onClick={() => onAdd(tn)}>
                            <Plus size={14} /> {t("network.addHost")}
                        </Button>
                    )}
                </div>
            )}
            <ScanProgress tn={tn} />
        </div>
    );
}

/** 收起來時的主機摘要：各種主機幾台（圖示 + 數字，滑過看種類）。/ The collapsed summary: hosts per kind (icon + count, hover for the kind). */
function KindSummary({ hosts }: { hosts: LanHost[] }) {
    const { t } = useI18n();
    if (hosts.length === 0) return <span className="text-xs text-muted-foreground">{t("network.noHostsShort")}</span>;
    return (
        <span className="flex flex-wrap items-center justify-end gap-1">
            {kindCounts(hosts, hostKind, KIND_ORDER).map(({ kind, count }) => (
                <span
                    key={kind}
                    title={t("network.kindCount", { count, kind: t(KIND_LABEL[kind]) })}
                    className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-px text-xs tabular-nums ring-1 ring-inset [&_svg]:size-3", KIND_TONE[kind])}
                >
                    {KIND_ICON[kind]}
                    {count}
                </span>
            ))}
        </span>
    );
}

/** 收起來的裝置：一行（展開箭頭、狀態、名稱、權限、主機摘要 / 掃描進度）。/ A collapsed device: one line. */
function DeviceRow({ tn, online, onExpand }: { tn: TopologyTunnel; online: boolean; onExpand: () => void }) {
    const { t } = useI18n();
    const permission = PERMISSION_LABEL[tn.permission];
    const running = scanRunning(tn.scan);
    const pct = running ? scanPercent(tn.scan!) : null;
    const lanIp = tn.endpoint?.lan?.[0]?.ip;
    return (
        <button
            type="button"
            onClick={onExpand}
            aria-expanded={false}
            className="flex w-full min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border border-border bg-card px-2.5 py-2 text-left shadow-card transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
            <ChevronRight size={16} className="shrink-0 text-muted-foreground" aria-hidden />
            <span className={cn("relative grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset", online ? "bg-success/10 text-success ring-success/20" : "bg-muted text-muted-foreground ring-border")} aria-hidden>
                <Router size={14} />
                <span className={cn("absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/50")} />
            </span>
            {/* 名稱至少留一段寬度；摘要放不下就換到下一行（手機）。/ The name keeps a minimum width; the summary wraps below when it doesn't fit (phones). */}
            <span className="min-w-[7rem] flex-1">
                <span className="block truncate text-sm text-foreground" title={tn.name}>{tn.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                    {online ? (tn.rtt_ms !== null ? t("network.onlineRtt", { ms: tn.rtt_ms }) : t("network.online")) : t("network.offline")}
                    {permission && tn.permission !== "owner" && ` · ${t(permission)}`}
                    {lanIp && (
                        <>
                            {" · "}
                            <span className="font-mono" title={`${t("tunnels.lanTag")} ${lanIp}`}>{lanIp}</span>
                        </>
                    )}
                </span>
            </span>
            {running ? (
                <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-primary">
                    <Loader2 size={12} className="animate-spin" />
                    {pct !== null ? `${pct}%` : t("network.scanning")}
                </span>
            ) : (
                <span className="ml-auto">
                    <KindSummary hosts={tn.hosts} />
                </span>
            )}
        </button>
    );
}

function DeviceBranch({ tn, online, last, first, expanded, onToggle, focused, selectedHostId, hostPager, onOpenHost, onScan, onAdd }: {
    tn: TopologyTunnel;
    online: boolean;
    last: boolean;
    first: boolean;
    expanded: boolean;
    onToggle: () => void;
    focused: boolean;
    selectedHostId: number | null;
    hostPager: PaginationState;
    onOpenHost: (h: LanHost) => void;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
}) {
    const { t } = useI18n();
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [focused]);
    // 選到的主機在別頁時，跳到那一頁。/ Jump to the page holding the selected host.
    const selectedAt = tn.hosts.findIndex((h) => h.id === selectedHostId);
    const { page, size, setPage } = hostPager;
    useEffect(() => {
        if (selectedAt >= 0 && Math.floor(selectedAt / size) + 1 !== page) setPage(Math.floor(selectedAt / size) + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedAt, size]);
    if (!expanded) {
        return (
            <Branch last={last} first={first} tickTop={26} solid={online}>
                <div ref={ref}>
                    <DeviceRow tn={tn} online={online} onExpand={onToggle} />
                </div>
            </Branch>
        );
    }
    const hosts = pageSlice(tn.hosts, hostPager.page, hostPager.size);
    const paged = tn.hosts.length > hostPager.size;
    return (
        <Branch last={last} first={first} tickTop={40} solid={online}>
            <div ref={ref} className="flex flex-col @3xl:flex-row @3xl:items-start">
                <DeviceCard tn={tn} online={online} onScan={onScan} onAdd={onAdd} focused={focused} onCollapse={onToggle} />
                {/* 裝置 → 主機的橫線（只在寬螢幕）。/ Device → hosts connector on wide screens. */}
                <span aria-hidden className={cn("mt-8 hidden w-6 shrink-0 border-t @3xl:block", online ? "border-success/60" : "border-dashed border-muted-foreground/40")} />
                {tn.hosts.length > 0 ? (
                    <ul className="ml-2.5 @md:ml-5 @3xl:ml-0">
                        {hosts.map((h, i) => (
                            <Branch key={h.id} last={i === hosts.length - 1 && !paged} first={i === 0} tickTop={32} solid={online} hideFirstStubOnWide>
                                <HostChip host={h} selected={h.id === selectedHostId} onOpen={onOpenHost} />
                            </Branch>
                        ))}
                        {paged && (
                            <Branch last first={false} tickTop={20} solid={false}>
                                <Pagination compact pager={hostPager} anchor={ref} />
                            </Branch>
                        )}
                    </ul>
                ) : (
                    <div className="ml-2.5 mt-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground @md:ml-5 @3xl:ml-0 @3xl:mt-3 @3xl:w-80">
                        {tn.can_scan ? t("network.noHostsScan") : tn.can_edit ? t("network.noHostsAdd") : t("network.noHostsView")}
                    </div>
                )}
            </div>
        </Branch>
    );
}

/** 資料夾節點（我的通道群組）。/ A folder node (one of my tunnel groups). */
function FolderNode({ sec, collapsed, onToggle, online, hosts, filtering }: {
    sec: MatrixSection<TopologyTunnel>;
    collapsed: boolean;
    onToggle: () => void;
    online: number;
    hosts: number;
    filtering: boolean;
}) {
    const { t } = useI18n();
    const name = sec.group?.name ?? t("groups.tunnel.ungrouped");
    const Icon = collapsed ? Folder : FolderOpen;
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("groups.tunnel.expand", { name }) : t("groups.tunnel.collapse", { name })}
            className="flex min-w-0 max-w-full items-start gap-2 rounded-lg py-1.5 pl-1 pr-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
            <ChevronRight size={16} className={cn("mt-0.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} aria-hidden />
            <Icon size={17} className={cn("mt-0.5 shrink-0", sec.group ? "text-foreground/70" : "text-muted-foreground")} aria-hidden />
            {/* 名稱優先；數量放不下就換到下一行。/ The name first; the counts wrap to the next line when they don't fit. */}
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className={cn("min-w-0 max-w-full truncate text-[0.9375rem]", sec.group ? "text-foreground" : "text-muted-foreground")} title={name}>{name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">
                {filtering ? t("groups.tunnel.matches", { shown: sec.items.length, total: sec.total }) : t("network.folderCount", { count: sec.total })}
                {" · "}
                {t("groups.tunnel.online", { count: online })}
                {" · "}
                {t("network.folderHosts", { count: hosts })}
            </span>
            </span>
        </button>
    );
}

export interface TopologyExpansion {
    isExpanded: (id: number) => boolean;
    toggle: (id: number) => void;
    isFolderCollapsed: (key: string) => boolean;
    toggleFolder: (key: string) => void;
}

export function TopologyTree({ tunnels, sections, filtering, pageKey, expansion, isOnline, focusTunnel, selectedHostId = null, onOpenHost, onScan, onAdd }: {
    /** 篩選後的裝置（沒分段時用）。/ The filtered devices (used without sections). */
    tunnels: TopologyTunnel[];
    /** 依群組分段（null = 不分段）。/ Group sections (null = no sections). */
    sections: MatrixSection<TopologyTunnel>[] | null;
    filtering: boolean;
    /** 搜尋 / 篩選一變就回第 1 頁。/ Back to page 1 when the search / filter changes. */
    pageKey: string;
    expansion: TopologyExpansion;
    isOnline: (tn: TopologyTunnel) => boolean;
    focusTunnel: string | null;
    selectedHostId?: number | null;
    onOpenHost: (h: LanHost) => void;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
}) {
    const { t } = useI18n();
    // 裝置在每個資料夾（或整棵樹）裡分頁；主機在每台裝置裡分頁。/ Devices page per folder (or the whole tree); hosts per device.
    const devicePages = useSectionPages({ storageKey: "telepy.networkPageSize", resetKey: pageKey });
    const hostPages = useSectionPages({ storageKey: "telepy.networkHostsPageSize", resetKey: pageKey });

    const deviceList = (list: TopologyTunnel[], key: string) => {
        const pager = devicePages.pager(key, list.length);
        const items = pageSlice(list, pager.page, pager.size);
        const paged = list.length > pager.size;
        return (
            <>
                {items.map((tn, i) => (
                    <DeviceBranch
                        key={tn.id}
                        tn={tn}
                        online={isOnline(tn)}
                        first={i === 0}
                        last={i === items.length - 1 && !paged}
                        expanded={filtering || expansion.isExpanded(tn.id)}
                        onToggle={() => expansion.toggle(tn.id)}
                        focused={focusTunnel === String(tn.id)}
                        selectedHostId={selectedHostId}
                        hostPager={hostPages.pager(String(tn.id), tn.hosts.length)}
                        onOpenHost={onOpenHost}
                        onScan={onScan}
                        onAdd={onAdd}
                    />
                ))}
                {paged && (
                    <Branch last first={false} tickTop={20} solid={false}>
                        <Pagination compact pager={pager} />
                    </Branch>
                )}
            </>
        );
    };

    return (
        // 版面依「樹自己的寬度」切換（旁邊開著主機面板時會窄）。/ Layout follows the tree's own width (narrower beside the host panel).
        <div className="@container overflow-x-auto rounded-xl border border-border bg-card p-4 shadow-card sm:p-6">
            <div className="flex items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-gradient text-white" aria-hidden>
                    <TelepyGlyph size={20} />
                </span>
                <div>
                    <p className="text-[1rem] text-foreground">Telepy</p>
                    <p className="text-xs text-muted-foreground">{t("network.serverNode")}</p>
                </div>
            </div>
            {/* 窄的時候每層縮排小一點（多了資料夾這層，手機上主機才放得下）。/ Narrow trees indent less per level (the folder level adds one). */}
            <ul className="ml-2.5 @md:ml-5">
                {sections
                    ? sections.map((sec, i) => {
                          const collapsed = !filtering && expansion.isFolderCollapsed(sec.key);
                          const members = sec.items;
                          return (
                              <Branch key={sec.key} first={i === 0} last={i === sections.length - 1} tickTop={22} solid={members.some(isOnline)}>
                                  <FolderNode
                                      sec={sec}
                                      collapsed={collapsed}
                                      onToggle={() => expansion.toggleFolder(sec.key)}
                                      online={members.filter(isOnline).length}
                                      hosts={members.reduce((n, tn) => n + tn.hosts.length, 0)}
                                      filtering={filtering}
                                  />
                                  {!collapsed && <ul className="ml-2.5 @md:ml-5">{deviceList(members, sec.key)}</ul>}
                              </Branch>
                          );
                      })
                    : deviceList(tunnels, "all")}
            </ul>
        </div>
    );
}
