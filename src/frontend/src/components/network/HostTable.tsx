"use client";

/**
 * 「所有主機」：每台裝置的區網主機攤成一張表（樹的另一種看法）。上面的搜尋已經跨裝置篩過；這裡再依種類、裝置篩，
 * 可排序（主機、位址、裝置、最後看到），分頁。每列：點名稱開主機面板；右邊在這裡開 / 終端機頁 / 指令。
 * ↑↓ 在列之間移動，Enter 打開。寬的時候是表格，窄（手機、或旁邊開著面板）時每台兩行。
 * "All hosts": every device's LAN hosts as one table (the other way to look at the tree). The search above already
 * runs across devices; here you filter by kind and device, sort (host, address, device, last seen) and page. Each
 * row: the name opens the host panel; on the right open here / terminal page / commands. ↑↓ move between rows,
 * Enter opens. A table when wide, two lines per host when narrow (phones, or beside the panel).
 */
import React, { useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination } from "@/components/ui/pagination";
import { Segmented } from "@/components/ui/segmented";
import { usePagination } from "@/hooks/usePagination";
import { useStoredChoice } from "@/hooks/useStoredChoice";
import { HostQuickActions } from "@/components/network/HostOpen";
import { KIND_ICON, KIND_LABEL, KIND_TONE } from "@/components/network/TopologyTree";
import { pageSlice } from "@/lib/pagination";
import { countKinds, HOST_KINDS, HOST_SORTS, sortHosts, stepIndex, type HostKind, type HostRow, type HostSort } from "@/lib/lanHosts";
import { hasSsh, serviceName, shortVendor } from "@/lib/lanConnect";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

export type TableRow = HostRow<LanHost, TopologyTunnel>;

const SORT_LABEL: Record<HostSort, TranslationKey> = {
    name: "network.table.host",
    address: "network.table.address",
    device: "network.table.device",
    seen: "network.table.seen",
};

const COLS = "@3xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_auto]";

function SortHeader({ k, sort, desc, onSort }: { k: HostSort; sort: HostSort; desc: boolean; onSort: (k: HostSort) => void }) {
    const { t } = useI18n();
    const active = sort === k;
    return (
        <button
            type="button"
            onClick={() => onSort(k)}
            aria-pressed={active}
            className={cn("flex min-w-0 items-center gap-1 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm", active && "text-foreground")}
        >
            <span className="min-w-0 [overflow-wrap:anywhere]">{t(SORT_LABEL[k])}</span>
            {active && (desc ? <ArrowDown size={12} className="shrink-0" /> : <ArrowUp size={12} className="shrink-0" />)}
        </button>
    );
}

export function HostTable({ rows, pageKey, selectedHostId, isOnline, onOpenHost, onOpenHere, onNavigate, openShells }: {
    /** 已經依搜尋篩過的主機。/ Hosts already narrowed by the search. */
    rows: TableRow[];
    /** 搜尋一變就回第 1 頁。/ Back to page 1 when the search changes. */
    pageKey: string;
    selectedHostId: number | null;
    isOnline: (tn: TopologyTunnel) => boolean;
    onOpenHost: (h: LanHost, tab?: "terminal" | "commands") => void;
    onOpenHere: (h: LanHost) => void;
    onNavigate: (h: LanHost) => void;
    openShells: number;
}) {
    const { t, locale } = useI18n();
    const [kind, setKind] = useState<HostKind | "all">("all");
    const [device, setDevice] = useState<string>("all");
    const [sort, setSort] = useStoredChoice<HostSort>("telepy.networkHostSort", HOST_SORTS, "address");
    const [desc, setDesc] = useState(false);
    const listRef = useRef<HTMLUListElement>(null);

    // 裝置選單：有主機符合搜尋的裝置（依名稱）。/ The device menu: devices with matching hosts, by name.
    const devices = useMemo(() => {
        const m = new Map<number, { tn: TopologyTunnel; count: number }>();
        for (const r of rows) m.set(r.device.id, { tn: r.device, count: (m.get(r.device.id)?.count ?? 0) + 1 });
        return [...m.values()].sort((a, b) => a.tn.name.localeCompare(b.tn.name, undefined, { numeric: true }));
    }, [rows]);
    const deviceId = device !== "all" && devices.some((d) => String(d.tn.id) === device) ? Number(device) : null;
    const inDevice = deviceId === null ? rows : rows.filter((r) => r.device.id === deviceId);
    const counts = countKinds(inDevice);
    // 選的種類變空了就退回全部。/ An emptied kind falls back to all.
    const k = kind !== "all" && counts[kind] === 0 ? "all" : kind;
    const shown = useMemo(() => sortHosts(k === "all" ? inDevice : inDevice.filter((r) => r.kind === k), sort, desc), [inDevice, k, sort, desc]);
    const pager = usePagination(shown.length, { storageKey: "telepy.networkHostTablePageSize", resetKey: `${pageKey}|${k}|${deviceId}|${sort}|${desc}`, sizes: [25, 50, 100] });
    const page = pageSlice(shown, pager.page, pager.size);
    const fmt = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
    const time = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

    const onSort = (key: HostSort) => {
        if (key === sort) setDesc((d) => !d);
        else {
            setSort(key);
            setDesc(false);
        }
    };

    // ↑↓ 在列的名稱按鈕之間移動焦點。/ ↑↓ move focus between the rows' name buttons.
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-host-open]") ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const to = stepIndex(at, buttons.length, e.key === "ArrowDown" ? 1 : -1);
        if (to >= 0) {
            e.preventDefault();
            buttons[to].focus();
        }
    };

    const kindOptions = [
        { value: "all" as const, label: `${t("network.filter.all")} (${counts.all})` },
        ...HOST_KINDS.filter((x) => counts[x] > 0).map((x) => ({ value: x, label: `${t(KIND_LABEL[x])} (${counts[x]})` })),
    ];

    return (
        <div className="@container min-w-0 rounded-xl border border-border bg-card shadow-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                {/* 種類：寬的時候是分段鈕，窄的時候一個下拉。/ Kind: segments when wide, one select when narrow. */}
                <div className="hidden max-w-full overflow-x-auto @2xl:block">
                    <Segmented size="sm" value={k} onChange={setKind} options={kindOptions} aria-label={t("network.table.kindAria")} />
                </div>
                <NativeSelect value={k} onChange={(e) => setKind(e.target.value as HostKind | "all")} aria-label={t("network.table.kindAria")} className="h-8 w-auto min-w-0 max-w-full text-sm @2xl:hidden">
                    {kindOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </NativeSelect>
                <NativeSelect value={deviceId === null ? "all" : String(deviceId)} onChange={(e) => setDevice(e.target.value)} aria-label={t("network.table.deviceAria")} className="h-8 w-auto min-w-0 max-w-full text-sm">
                    <option value="all">{t("network.table.allDevices", { count: devices.length })}</option>
                    {devices.map((d) => <option key={d.tn.id} value={d.tn.id}>{`${d.tn.name} (${d.count})`}</option>)}
                </NativeSelect>
                {/* 窄的時候沒有表頭，排序用下拉。/ Narrow: no header row, so sorting is a select. */}
                <NativeSelect value={sort} onChange={(e) => onSort(e.target.value as HostSort)} aria-label={t("network.table.sortAria")} className="h-8 w-auto min-w-0 max-w-full text-sm @3xl:hidden">
                    {HOST_SORTS.map((s) => <option key={s} value={s}>{t("network.table.sortBy", { field: t(SORT_LABEL[s]) })}</option>)}
                </NativeSelect>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{t("network.table.count", { count: shown.length })}</span>
            </div>

            <div className={cn("hidden gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground @3xl:grid", COLS)}>
                <SortHeader k="name" sort={sort} desc={desc} onSort={onSort} />
                <SortHeader k="address" sort={sort} desc={desc} onSort={onSort} />
                <SortHeader k="device" sort={sort} desc={desc} onSort={onSort} />
                <span>{t("network.table.services")}</span>
                <SortHeader k="seen" sort={sort} desc={desc} onSort={onSort} />
                <span className="w-24 text-right">{t("network.table.open")}</span>
            </div>

            {shown.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("network.table.empty")}</p>
            ) : (
                <ul ref={listRef} onKeyDown={onKeyDown} className="divide-y divide-border">
                    {page.map((r) => {
                        const { host, device: tn } = r;
                        const online = isOnline(tn);
                        const selected = host.id === selectedHostId;
                        const ports = host.open_ports.slice(0, 5);
                        return (
                            <li
                                key={host.id}
                                className={cn(
                                    "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 transition-colors hover:bg-muted/40",
                                    COLS,
                                    selected && "bg-primary/[0.06] shadow-[inset_2px_0_0_var(--color-primary)]"
                                )}
                            >
                                {/* 主機：名稱 + 種類圖示（窄的時候第二行放位址與裝置）。/ Host: name + kind icon (narrow: address and device on a second line). */}
                                <button
                                    type="button"
                                    data-host-open
                                    onClick={() => onOpenHost(host)}
                                    aria-current={selected ? "true" : undefined}
                                    className="flex min-w-0 items-center gap-2.5 rounded-md py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <span className={cn("grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset [&_svg]:size-3.5", KIND_TONE[r.kind])} title={t(KIND_LABEL[r.kind])} aria-hidden>
                                        {KIND_ICON[r.kind]}
                                    </span>
                                    <span className="min-w-0">
                                        <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{r.name}</span>
                                        <span className="block text-xs text-muted-foreground @3xl:hidden [overflow-wrap:anywhere]">
                                            <span className="font-mono">{host.address}</span>
                                            {" · "}
                                            <span className={online ? "text-foreground/80" : undefined}>{tn.name}</span>
                                            {host.vendor && ` · ${shortVendor(host.vendor)}`}
                                        </span>
                                    </span>
                                </button>
                                <span className="hidden min-w-0 @3xl:block">
                                    <span className="block font-mono text-xs text-foreground/90 [overflow-wrap:anywhere]">{host.address}</span>
                                    {host.vendor && <span className="block text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]" title={host.vendor}>{shortVendor(host.vendor)}</span>}
                                </span>
                                <span className="hidden min-w-0 items-center gap-1.5 text-xs @3xl:flex">
                                    <span className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-success" : "bg-muted-foreground/45")} aria-hidden />
                                    <span className="min-w-0 [overflow-wrap:anywhere] text-foreground/90">{tn.name}</span>
                                    <span className="sr-only">{online ? t("network.online") : t("network.offline")}</span>
                                </span>
                                <span className="hidden min-w-0 flex-wrap items-center gap-1 @3xl:flex">
                                    {ports.map((p) => (
                                        <span key={p} title={serviceName(p) ?? undefined} className={cn("rounded px-1 font-mono text-[0.6875rem] leading-4", p === host.ssh_port && hasSsh(host) ? "bg-success/12 text-success" : "bg-muted text-muted-foreground")}>
                                            {p}
                                        </span>
                                    ))}
                                    {host.open_ports.length > ports.length && <span className="text-[0.6875rem] text-muted-foreground">+{host.open_ports.length - ports.length}</span>}
                                    {host.open_ports.length === 0 && <span className="text-[0.6875rem] text-muted-foreground">{t("network.noOpenPorts")}</span>}
                                </span>
                                <span className="hidden text-xs text-muted-foreground @3xl:block" title={host.last_seen ? time.format(new Date(host.last_seen)) : undefined}>
                                    {host.last_seen ? fmt.format(new Date(host.last_seen)) : host.source === "manual" ? t("network.manualTag") : "—"}
                                </span>
                                <HostQuickActions host={host} tunnel={tn} online={online} onOpenHere={onOpenHere} onOpenPanel={onOpenHost} onNavigate={onNavigate} openShells={openShells} className="justify-end @3xl:w-24" />
                            </li>
                        );
                    })}
                </ul>
            )}
            {shown.length > pager.sizes[0] && (
                <div className="border-t border-border px-3 py-2">
                    <Pagination pager={pager} anchor={listRef} />
                </div>
            )}
        </div>
    );
}
