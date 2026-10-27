/**
 * 「我的金鑰 × 我能用的裝置」矩陣：勾選 = 放進那台裝置的金鑰清單；格子裡是每個 OS 帳號的安裝狀態（全部裝上時縮成
 * 一個「✓ N 個帳號」籤，只有等待中 / 失敗的才逐一列出）。有通道群組時依群組分段（跟通道頁的「依群組 / 單一清單」
 * 同一個選擇），每段可收合（localStorage `telepy.keyMatrixCollapsed`；沒選過而裝置很多時只展開第一段）。
 * 裝置多時分頁：分段時每段各自分頁（段標題永遠都在），沒分段時整份一起分頁；每頁筆數記在
 * `telepy.keyDevicesPageSize`。搜尋永遠對全部裝置。桌面是表格（金鑰多時可橫向捲動，裝置欄與操作欄固定），手機改成每台裝置一張卡。
 * My keys × the devices I can use: a tick puts the key on that device's list; each cell shows the per-account
 * install state (one "✓ N accounts" chip when all are installed; pending / failed ones stay listed). With tunnel
 * groups the rows are split into sections (following the tunnels page's "by group / one list" choice), each
 * collapsible (localStorage `telepy.keyMatrixCollapsed`; with many devices and no stored choice only the first is
 * open). Many devices are paged: each section on its own (every header stays visible), or the whole list without
 * sections; page size in `telepy.keyDevicesPageSize`. The search always covers every device. A table on desktop
 * (scrolls sideways with many keys, device and action columns stay put), cards on phones.
 */
import React, { useRef, useState } from "react";
import Link from "next/link";
import { HardDrive, Layers, Loader2, Plus, RefreshCw, Settings2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { KeyDevice, TunnelRole, UserKey } from "@/types/keys";
import type { TunnelGroup } from "@/types/groups";
import { TargetChips } from "./TargetChips";
import { DeviceFilterBar, DeviceFilterFooter, needsAttention, useDeviceFilter } from "./DeviceFilter";
import { Pagination } from "@/components/ui/pagination";
import { usePagination, useSectionPages } from "@/hooks/usePagination";
import { pageSlice, PAGE_SIZES } from "@/lib/pagination";
import { GroupHeader, GroupHeaderRow, type GroupHeaderProps } from "@/components/tunnels/TunnelGroupSection";
import { defaultCollapsed, hasGroupedDevice, matrixSections, type MatrixSection } from "@/lib/deviceMatrix";
import { groupOf, TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS } from "@/lib/groups";
import { useStoredChoice } from "@/hooks/useStoredChoice";

const COLLAPSED_KEY = "telepy.keyMatrixCollapsed";

/** 存過的收合段（null = 沒選過，用預設）。/ Stored collapsed sections (null = never chosen, use the default). */
function readCollapsed(): Set<string> | null {
    try {
        const v = localStorage.getItem(COLLAPSED_KEY);
        if (v === null) return null;
        const a = JSON.parse(v);
        return Array.isArray(a) ? new Set(a.map(String)) : null;
    } catch {
        return null;
    }
}

/** 固定欄（裝置、操作）的底色：跟著整列的 hover。/ Sticky cells' background, following the row hover. */
const STICKY_BG = "bg-card group-hover/row:bg-[color-mix(in_oklab,var(--color-muted)_30%,var(--color-card))]";

const ROLE_KEY: Record<TunnelRole, TranslationKey> = {
    owner: "keys.role.owner",
    admin: "keys.role.admin",
    edit: "keys.role.edit",
    view: "keys.role.view",
};

export function OnlineDot({ online }: { online: boolean }) {
    const { t } = useI18n();
    return (
        <span className="inline-flex items-center gap-1 text-[0.75rem] text-muted-foreground">
            <span className={cn("size-2 rounded-full", online ? "bg-success shadow-[0_0_0_3px] shadow-success/15" : "bg-muted-foreground/40")} aria-hidden />
            {online ? t("keys.online") : t("keys.offline")}
        </span>
    );
}

export function RoleBadge({ role }: { role: TunnelRole }) {
    const { t } = useI18n();
    return (
        <span className={cn("rounded-full px-1.5 py-px text-[0.6875rem] ring-1 ring-inset", role === "owner" ? "bg-primary/8 text-primary ring-primary/25" : "bg-info/10 text-info ring-info/30")}>
            {t(ROLE_KEY[role])}
        </span>
    );
}

function DeviceHeading({ device }: { device: KeyDevice }) {
    const { t } = useI18n();
    return (
        <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <HardDrive size={15} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 truncate text-sm text-foreground" title={device.host_friendly_name}>{device.host_friendly_name}</span>
                <RoleBadge role={device.role} />
                <OnlineDot online={device.online} />
            </div>
            {device.accounts.length > 0 ? (
                <p className="mt-0.5 truncate text-[0.75rem] text-muted-foreground" title={device.accounts.join(", ")}>
                    {t("keys.matrix.accounts")} <span className="font-mono text-foreground/80">{device.accounts.join(", ")}</span>
                </p>
            ) : (
                <p className="mt-0.5 flex items-start gap-1 text-[0.75rem] text-warning">
                    <ShieldAlert size={12} className="mt-0.5 shrink-0" aria-hidden />
                    {device.role === "owner" || device.role === "admin" ? t("keys.matrix.noAccountsOwner") : t("keys.matrix.noAccountsSharee")}
                </p>
            )}
        </div>
    );
}

/**
 * 一格：勾選框＋（經由的群組、各帳號狀態）。「在清單上 / 不在清單上」只在滑過勾選框時出現（勾選本身就說明了），
 * 手機上 `label` 是金鑰名稱。
 * One cell: the checkbox plus (groups it comes through, per-account state). "On / not on the list" only shows on
 * hover (the tick says it already); on phones `label` is the key's name.
 */
function Cell({ device, keyItem, busy, onToggle, label }: { device: KeyDevice; keyItem: UserKey; busy: boolean; onToggle: (on: boolean) => void; label?: string }) {
    const { t } = useI18n();
    const placed = device.keys.find((k) => k.user_key_id === keyItem.id);
    // 勾選 = 直接在清單上；經由金鑰群組來的另外標出來（取消勾選不會拿掉它）。
    // The tick = listed directly; keys that come through key groups are marked separately (unticking leaves them).
    const direct = !!placed && placed.direct !== false;
    const groups = placed?.groups ?? [];
    const id = `cell-${device.tunnel_id}-${keyItem.id}`;
    const state = direct ? t("keys.matrix.inList") : groups.length ? t("groups.matrix.viaGroup") : t("keys.matrix.notInList");
    return (
        <div className="flex min-w-0 items-start gap-2">
            <label htmlFor={id} title={state} className="-m-1 flex shrink-0 cursor-pointer items-center rounded-md p-1 has-[:disabled]:cursor-wait">
                {busy ? (
                    <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                ) : (
                    <input
                        id={id}
                        type="checkbox"
                        checked={direct}
                        disabled={busy}
                        onChange={(e) => onToggle(e.target.checked)}
                        className="size-4 cursor-pointer rounded accent-primary"
                    />
                )}
                <span className="sr-only">
                    {t("keys.matrix.toggleAria", { key: keyItem.host_friendly_name, device: device.host_friendly_name })} ({state})
                </span>
            </label>
            {(label || groups.length > 0 || placed) && (
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                    {label && (
                        <span className="mr-1 min-w-0 max-w-full truncate text-xs text-foreground" title={label}>
                            {label}
                        </span>
                    )}
                    {groups.map((g) => (
                        <span key={g.id} className="inline-flex max-w-full items-center gap-1 rounded-sm bg-muted px-1.5 py-px text-[0.75rem] text-muted-foreground" title={t("groups.viaGroup", { name: g.name })}>
                            <Layers size={11} className="shrink-0" aria-hidden /> <span className="truncate">{g.name}</span>
                        </span>
                    ))}
                    {placed && (
                        <TargetChips
                            compact
                            className="contents"
                            targets={placed.targets}
                            online={device.online}
                            unchosen={direct && groups.length === 0 ? unchosenAccounts(placed.accounts, device.account_list) : device.accounts.filter((a) => !placed.targets.some((x) => x.username === a))}
                        />
                    )}
                </div>
            )}
        </div>
    );
}

/** 金鑰只選了部分帳號：沒選的帳號名（矩陣上以灰籤標示）。/ Accounts the key was not chosen for (shown muted). */
export function unchosenAccounts(chosen: number[] | null, accounts: { id: number; username: string }[]): string[] {
    if (chosen === null) return [];
    return accounts.filter((a) => !chosen.includes(a.id)).map((a) => a.username);
}

const isProblem = (d: KeyDevice) => d.keys.some((k) => needsAttention(k.targets, d.online));

export function DeviceMatrix({
    devices,
    keys,
    toolbar,
    tunnelGroups = [],
    pending,
    syncing,
    onToggle,
    onSync,
    onManage,
}: {
    devices: KeyDevice[];
    /** 當欄位的金鑰（金鑰欄挑的）。/ The keys shown as columns (picked with the key-column picker). */
    keys: UserKey[];
    /** 篩選列右邊的控制項（金鑰欄）。/ Controls right of the filter bar (the key-column picker). */
    toolbar?: React.ReactNode;
    /** 我的通道群組（有的話依群組分段）。/ My tunnel groups (rows are split into sections by them). */
    tunnelGroups?: TunnelGroup[];
    pending: Set<string>;
    syncing: Set<number>;
    onToggle: (device: KeyDevice, key: UserKey, on: boolean) => void;
    onSync: (device: KeyDevice) => void;
    onManage: (device: KeyDevice) => void;
}) {
    const { t } = useI18n();
    // 有裝置在群組裡、而且通道頁選的是「依群組」時分段。/ Sections once a device is in a group (unless the tunnels page shows one list).
    const [grouping] = useStoredChoice(TUNNEL_GROUPING_KEY, TUNNEL_GROUPINGS, "groups");
    const grouped = grouping === "groups" && hasGroupedDevice(devices.map((d) => d.tunnel_id), tunnelGroups);
    // 裝置多時：搜尋、只看有我的金鑰的、只看需要處理的（對全部裝置），結果再分頁。
    // Many devices: search and buckets over every device, then pages.
    const filter = useDeviceFilter(devices, {
        device: (d) => d,
        isOn: (d) => d.keys.length > 0,
        isProblem,
        collapse: false,
    });
    const top = useRef<HTMLDivElement>(null);
    const filtering = filter.query.trim() !== "" || filter.mode !== "all";
    const sections = grouped ? matrixSections(filter.visible, devices, tunnelGroups, (d) => d.tunnel_id, filtering) : [];

    // 收合：存過就照存的；沒存過依裝置數量給預設。篩選中全部展開（收合只到清掉搜尋為止）。
    // Collapsing: the stored set, else a default by device count. While filtering everything starts open
    // (a section closed then stays closed only until the filter changes).
    const [stored, setStored] = useState<Set<string> | null>(readCollapsed);
    const sig = `${filter.query}|${filter.mode}`;
    const [whileFiltering, setWhileFiltering] = useState<{ sig: string; closed: Set<string> }>({ sig: "", closed: new Set() });
    const closedNow = filtering
        ? whileFiltering.sig === sig
            ? whileFiltering.closed
            : new Set<string>()
        : (stored ?? defaultCollapsed(matrixSections(devices, devices, tunnelGroups, (d) => d.tunnel_id, false).map((s) => s.key), devices.length));
    const toggleSection = (key: string) => {
        const next = new Set(closedNow);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        if (filtering) {
            setWhileFiltering({ sig, closed: next });
            return;
        }
        setStored(next);
        try {
            localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
            /* 這次就不記。/ Not remembered this time. */
        }
    };
    // 分頁：沒分段時整份一起；分段時每段各自（同一個每頁筆數）。/ Pages: the whole list, or each section on its own (one shared size).
    const pageKey = `${filter.query}|${filter.mode}|${grouped}`;
    const pager = usePagination(filter.filtered.length, { storageKey: "telepy.keyDevicesPageSize", resetKey: pageKey });
    const sectionPages = useSectionPages({ storageKey: "telepy.keyDevicesPageSize", resetKey: pageKey });
    const of = groupOf(tunnelGroups);
    const inSection = (d: KeyDevice, sec: MatrixSection<KeyDevice>) => (sec.group ? of.get(d.tunnel_id) === sec.group.id : !of.has(d.tunnel_id));
    const headerProps = (sec: MatrixSection<KeyDevice>, id: string): GroupHeaderProps => {
        const members = devices.filter((d) => inSection(d, sec));
        const problems = members.filter(isProblem).length;
        return {
            group: sec.group,
            shown: sec.items.length,
            total: sec.total,
            online: members.filter((d) => d.online).length,
            filtering,
            collapsed: closedNow.has(sec.key),
            onToggle: () => toggleSection(sec.key),
            id,
            extra:
                problems > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-warning">
                        <span className="size-1.5 rounded-full bg-warning" aria-hidden />
                        {t("keys.matrix.sectionProblems", { count: problems })}
                    </span>
                ) : null,
        };
    };
    /** 一段展開時這頁的列與分頁狀態。/ An open section's rows on its page and its pager. */
    const sectionPage = (sec: MatrixSection<KeyDevice>) => {
        const pg = sectionPages.pager(sec.key, sec.items.length);
        return { pg, open: !closedNow.has(sec.key), items: pageSlice(sec.items, pg.page, pg.size), paged: sec.items.length > PAGE_SIZES[0] };
    };

    if (devices.length === 0) {
        return (
            <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-border bg-card px-6 py-10 text-center">
                <HardDrive size={32} className="text-muted-foreground/60" aria-hidden />
                <div>
                    <p className="text-sm text-foreground">{t("keys.matrix.emptyTitle")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{t("keys.matrix.emptyBody")}</p>
                </div>
                <Button asChild size="sm" variant="outline">
                    <Link href="/tunnels/create"><Plus /> {t("keys.matrix.createTunnel")}</Link>
                </Button>
            </div>
        );
    }

    const actions = (d: KeyDevice) => (
        <div className="flex shrink-0 items-center gap-1">
            <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onSync(d)}
                disabled={syncing.has(d.tunnel_id) || d.keys.length === 0}
                title={t("keys.matrix.syncNow")}
                aria-label={t("keys.matrix.syncAria", { device: d.host_friendly_name })}
            >
                <RefreshCw className={cn(syncing.has(d.tunnel_id) && "animate-spin")} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => onManage(d)}>
                <Settings2 /> {t("keys.matrix.manage")}
            </Button>
        </div>
    );

    const row = (d: KeyDevice) => (
        <tr key={d.tunnel_id} className="group/row align-top transition-colors hover:bg-muted/30">
            <th scope="row" className={cn("sticky left-0 z-10 w-[16rem] min-w-[12rem] max-w-[18rem] px-4 py-2.5 font-normal", STICKY_BG)}>
                <DeviceHeading device={d} />
            </th>
            {keys.map((k) => (
                <td key={k.id} className="min-w-[8rem] max-w-[13rem] px-3 py-2.5">
                    <Cell device={d} keyItem={k} busy={pending.has(`${d.tunnel_id}:${k.id}`)} onToggle={(on) => onToggle(d, k, on)} />
                </td>
            ))}
            <td className={cn("sticky right-0 z-10 px-4 py-2", STICKY_BG)}>
                <div className="flex justify-end">{actions(d)}</div>
            </td>
        </tr>
    );

    const card = (d: KeyDevice) => (
        <div key={d.tunnel_id} className="rounded-xl border border-border/80 bg-card p-3 shadow-card">
            <div className="flex items-start justify-between gap-2">
                <DeviceHeading device={d} />
                {actions(d)}
            </div>
            <ul className="mt-2.5 space-y-2 border-t border-border/70 pt-2.5">
                {keys.map((k) => (
                    <li key={k.id}>
                        <Cell device={d} keyItem={k} label={k.host_friendly_name} busy={pending.has(`${d.tunnel_id}:${k.id}`)} onToggle={(on) => onToggle(d, k, on)} />
                    </li>
                ))}
            </ul>
        </div>
    );

    return (
        <div ref={top} className="scroll-mt-20 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                    <DeviceFilterBar filter={filter} onLabel={t("keys.filter.withMine")} modes={["all", "on", "problems"]} />
                </div>
                {toolbar}
            </div>
            {/* 桌面：表格。`relative` 讓 sr-only 的欄位名留在捲動框裡（否則整頁會被撐寬）。
                Desktop: table. `relative` keeps the sr-only column title inside the scroll box (it widened the page). */}
            {filter.filtered.length > 0 && (
                <div className="relative hidden overflow-x-auto rounded-xl border border-border/80 bg-card shadow-card md:block">
                    <table className="w-full min-w-max text-left">
                        <thead className="bg-surface text-xs text-muted-foreground">
                            <tr>
                                <th scope="col" className="sticky left-0 z-10 bg-surface px-4 py-2.5 font-normal">{t("keys.matrix.device")}</th>
                                {keys.map((k) => (
                                    <th key={k.id} scope="col" className="max-w-[13rem] px-3 py-2.5 font-normal normal-case tracking-normal">
                                        <span className="block truncate text-xs text-foreground" title={k.host_friendly_name}>{k.host_friendly_name}</span>
                                        <span className="font-mono text-[0.6875rem] text-muted-foreground">{k.key_type ?? "?"}</span>
                                    </th>
                                ))}
                                <th scope="col" className="sticky right-0 z-10 bg-surface px-4 py-2.5 text-right font-normal"><span className="sr-only">{t("keys.thActions")}</span></th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border/70">
                            {grouped
                                ? sections.map((sec) => {
                                      const { pg, open, items, paged } = sectionPage(sec);
                                      const id = `keys-sec-t-${sec.key}`;
                                      return (
                                          <React.Fragment key={sec.key}>
                                              <GroupHeaderRow colSpan={keys.length + 2} {...headerProps(sec, id)} />
                                              {open && items.map(row)}
                                              {open && paged && (
                                                  <tr>
                                                      <td colSpan={keys.length + 2} className="px-4 py-2">
                                                          <Pagination pager={pg} anchor={() => document.getElementById(id)} className="sticky left-4 w-fit justify-start" />
                                                      </td>
                                                  </tr>
                                              )}
                                          </React.Fragment>
                                      );
                                  })
                                : pageSlice(filter.filtered, pager.page, pager.size).map(row)}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 手機：卡片 / Phones: cards */}
            <div className="space-y-3 md:hidden">
                {grouped
                    ? sections.map((sec) => {
                          const { pg, open, items, paged } = sectionPage(sec);
                          const id = `keys-sec-c-${sec.key}`;
                          return (
                              <div key={sec.key} className="space-y-2">
                                  <GroupHeader {...headerProps(sec, id)} />
                                  {open && items.map(card)}
                                  {open && paged && <Pagination pager={pg} anchor={() => document.getElementById(id)} />}
                              </div>
                          );
                      })
                    : pageSlice(filter.filtered, pager.page, pager.size).map(card)}
            </div>
            <DeviceFilterFooter filter={filter} />
            {!grouped && <Pagination pager={pager} anchor={top} />}
        </div>
    );
}
