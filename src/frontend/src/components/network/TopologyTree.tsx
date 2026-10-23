"use client";

/**
 * 拓撲樹：Telepy → 裝置 → 區網主機。樹本身窄（手機、或旁邊開著主機面板）時主機縮排在裝置下方，夠寬（容器
 * ≥ 48rem）時排在裝置右邊；連線用細線畫，線上的裝置是實線、離線是虛線。選到的主機用 primary 框起來。
 * The topology tree: Telepy → devices → LAN hosts. Hosts sit under the device while the tree itself is
 * narrow (phones, or beside the host panel) and to its right once it is ≥ 48rem wide (container query);
 * links are hairlines, solid for online devices and dashed for offline ones. The selected host is outlined.
 */
import React, { useEffect, useRef, useState } from "react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { Router, Terminal, Monitor, HardDrive, Globe, CircleDot, Radar, Plus, Loader2, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import { hasSsh, hostKind, hostName, scanPercent, scanRunning, type HostKind } from "@/lib/lanConnect";
import type { LanHost, TopologyTunnel } from "@/types/lan";

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

/** 一開始最多列出幾台主機（其餘收起來）。/ Hosts shown before "show more". */
const HOSTS_COLLAPSED = 8;

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
        <li className="relative pl-7 pt-2">
            <span aria-hidden className={cn("absolute left-0 top-0 w-px bg-border", first && hideFirstStubOnWide && "@3xl:hidden")} style={{ height: tickTop }} />
            {!last && <span aria-hidden className="absolute left-0 bottom-0 w-px bg-border" style={{ top: tickTop }} />}
            <span
                aria-hidden
                className={cn("absolute left-0 w-6 border-t", solid ? "border-success/60" : "border-dashed border-muted-foreground/40")}
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
            className={cn(
                "group flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-[background-color,box-shadow] hover:bg-card hover:shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl:w-80",
                selected ? "border-primary/60 bg-card ring-1 ring-primary/30" : "border-border bg-surface"
            )}
        >
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg ring-1 ring-inset", KIND_TONE[kind])} aria-hidden>
                {KIND_ICON[kind]}
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="truncate text-sm text-foreground">{name}</span>
                    {host.source === "manual" && <span className="shrink-0 text-[0.6875rem] text-muted-foreground">{t("network.manualTag")}</span>}
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {name !== host.address && <span className="truncate font-mono">{host.address}</span>}
                    {shown.map((p) => (
                        <span key={p} className={cn("rounded px-1 font-mono text-[0.6875rem] leading-4", p === host.ssh_port && hasSsh(host) ? "bg-success/12 text-success" : "bg-muted")}>
                            {p}
                        </span>
                    ))}
                    {more > 0 && <span className="text-[0.6875rem]">+{more}</span>}
                    {host.open_ports.length === 0 && <span className="text-[0.6875rem]">{t("network.noOpenPorts")}</span>}
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

function DeviceCard({ tn, online, onScan, onAdd, focused }: {
    tn: TopologyTunnel;
    online: boolean;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
    focused: boolean;
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
            <div className="flex items-center gap-3">
                <span className={cn("relative grid size-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset", online ? "bg-success/10 text-success ring-success/20" : "bg-muted text-muted-foreground ring-border")} aria-hidden>
                    <Router size={18} />
                    <span className={cn("absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-card", online ? "bg-success" : "bg-muted-foreground/50")} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[1rem] text-foreground">{tn.name}</p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span>{online ? (tn.rtt_ms !== null ? t("network.onlineRtt", { ms: tn.rtt_ms }) : t("network.online")) : t("network.offline")}</span>
                        <span>·</span>
                        <span>{t("network.hostCount", { count: tn.hosts.length })}</span>
                    </p>
                </div>
                {permission && tn.permission !== "owner" && (
                    <Badge variant="outline" className="shrink-0 text-[0.6875rem]">{t(permission)}</Badge>
                )}
            </div>
            {(tn.can_scan || tn.can_edit) && (
                <div className="mt-3 flex gap-2">
                    {tn.can_scan && (
                        <Button size="sm" variant="outline" className="h-8 flex-1 gap-1.5 text-xs" disabled={running || !online} onClick={() => onScan(tn)} title={!online ? t("network.scanNeedsOnline") : undefined}>
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

function DeviceBranch({ tn, online, last, first, focused, selectedHostId, onOpenHost, onScan, onAdd }: {
    tn: TopologyTunnel;
    online: boolean;
    last: boolean;
    first: boolean;
    focused: boolean;
    selectedHostId: number | null;
    onOpenHost: (h: LanHost) => void;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
}) {
    const { t } = useI18n();
    const [expanded, setExpanded] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, [focused]);
    // 選到的主機就算在收合範圍外也要看得到。/ Keep the selected host visible even when collapsed.
    const selectedHidden = tn.hosts.findIndex((h) => h.id === selectedHostId) >= HOSTS_COLLAPSED;
    const hosts = expanded || selectedHidden ? tn.hosts : tn.hosts.slice(0, HOSTS_COLLAPSED);
    const hidden = tn.hosts.length - hosts.length;
    return (
        <Branch last={last} first={first} tickTop={40} solid={online}>
            <div ref={ref} className="flex flex-col @3xl:flex-row @3xl:items-start">
                <DeviceCard tn={tn} online={online} onScan={onScan} onAdd={onAdd} focused={focused} />
                {/* 裝置 → 主機的橫線（只在寬螢幕）。/ Device → hosts connector on wide screens. */}
                <span aria-hidden className={cn("mt-8 hidden w-6 shrink-0 border-t @3xl:block", online ? "border-success/60" : "border-dashed border-muted-foreground/40")} />
                {tn.hosts.length > 0 ? (
                    <ul className="ml-5 @3xl:ml-0">
                        {hosts.map((h, i) => (
                            <Branch key={h.id} last={i === hosts.length - 1 && hidden === 0} first={i === 0} tickTop={32} solid={online} hideFirstStubOnWide>
                                <HostChip host={h} selected={h.id === selectedHostId} onOpen={onOpenHost} />
                            </Branch>
                        ))}
                        {hidden > 0 && (
                            <Branch last first={false} tickTop={24} solid={false}>
                                <button type="button" onClick={() => setExpanded(true)} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-primary hover:bg-muted">
                                    <ChevronDown size={14} /> {t("network.showMore", { count: hidden })}
                                </button>
                            </Branch>
                        )}
                    </ul>
                ) : (
                    <div className="ml-5 mt-2 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground @3xl:ml-0 @3xl:mt-3 @3xl:w-80">
                        {tn.can_scan ? t("network.noHostsScan") : tn.can_edit ? t("network.noHostsAdd") : t("network.noHostsView")}
                    </div>
                )}
            </div>
        </Branch>
    );
}

export function TopologyTree({ tunnels, isOnline, focusTunnel, selectedHostId = null, onOpenHost, onScan, onAdd }: {
    tunnels: TopologyTunnel[];
    isOnline: (tn: TopologyTunnel) => boolean;
    focusTunnel: string | null;
    selectedHostId?: number | null;
    onOpenHost: (h: LanHost) => void;
    onScan: (tn: TopologyTunnel) => void;
    onAdd: (tn: TopologyTunnel) => void;
}) {
    const { t } = useI18n();
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
            <ul className="ml-5">
                {tunnels.map((tn, i) => (
                    <DeviceBranch
                        key={tn.id}
                        tn={tn}
                        online={isOnline(tn)}
                        first={i === 0}
                        last={i === tunnels.length - 1}
                        focused={focusTunnel === String(tn.id)}
                        selectedHostId={selectedHostId}
                        onOpenHost={onOpenHost}
                        onScan={onScan}
                        onAdd={onAdd}
                    />
                ))}
            </ul>
        </div>
    );
}
