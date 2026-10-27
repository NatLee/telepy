/**
 * 裝置金鑰面板的「你的金鑰」分頁：金鑰與金鑰群組在同一張清單裡一覽。每個金鑰群組是一段（標題列的勾選 = 把整組
 * 交給這台），組裡的金鑰列在它下面，沒分組的放最後；每把金鑰一列：勾選 = 直接放進這台的清單，旁邊寫它怎麼到這台
 * （直接 / 經由群組 / 兩者）、裝到哪些帳號（可選），以及每個帳號上的實際狀態。金鑰多時有搜尋、每段先顯示幾把。
 * The device panel's "Your keys" tab: keys and key groups in one list. Each key group is a section (its header's
 * tick grants the whole group to this device) with its keys under it, ungrouped keys last; each key is one row —
 * the tick puts it on this device's list directly — saying how it gets here (directly / through a group / both),
 * which accounts it goes into (adjustable) and its real state per account. Many keys get a search and short
 * sections with "show more".
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, FolderTree, KeyRound, Layers, Loader2, Plus, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { shortFingerprint } from "@/lib/sshKeys";
import { chosenCount, toggleChosen } from "@/lib/keyPlacement";
import { groupHere, initialOrder, keySections, reachOf, reachSummary, type Reach } from "@/lib/myKeysHere";
import type { TranslationKey } from "@/locales/en";
import type { DeviceAccount, DeviceKeys, KeyTarget } from "@/types/keys";
import type { MyKeyGroupHere } from "@/types/groups";
import { TargetChips } from "./TargetChips";

/** 這麼多把以上才有搜尋。/ Search from this many keys on. */
export const MY_KEYS_FILTER_FROM = 7;
/** 每段先顯示幾把。/ Keys shown per section before "show more". */
export const MY_KEYS_COLLAPSED = 8;

type MyKey = DeviceKeys["my_keys"][number];

const REACH: Record<Exclude<Reach, "none">, { label: TranslationKey; tip: TranslationKey }> = {
    direct: { label: "keys.here.reachDirect", tip: "keys.here.reachDirectTip" },
    group: { label: "keys.here.reachGroup", tip: "keys.here.reachGroupTip" },
    both: { label: "keys.here.reachBoth", tip: "keys.here.reachBothTip" },
};

/**
 * 清單上的金鑰要裝到哪些帳號：預設「我的每個帳號」，浮層裡每個帳號一個勾選框；取消勾選的帳號下次同步就移除。
 * Which accounts a listed key goes into: "all my accounts" by default, one checkbox per account in a popover.
 */
function AccountPicker({ k, accounts, busy, onChange }: { k: MyKey; accounts: DeviceAccount[]; busy: boolean; onChange: (accounts: number[] | null) => void }) {
    const { t } = useI18n();
    const c = chosenCount(k.accounts, accounts);
    const current = k.accounts === null ? accounts.map((a) => a.id) : k.accounts;
    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={busy}
                    aria-label={t("keys.accounts.aria", { key: k.name })}
                    className={cn(
                        "inline-flex items-center gap-1 rounded-sm px-1.5 py-px text-[0.75rem] leading-5 ring-1 ring-inset transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                        c.all ? "text-muted-foreground ring-border" : "bg-warning/10 text-warning ring-warning/30"
                    )}
                >
                    <Users size={12} aria-hidden />
                    {c.all ? t("keys.accounts.all") : t("keys.accounts.some", { chosen: c.chosen, total: c.total })}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-3">
                <p className="text-sm text-foreground">{t("keys.accounts.pickTitle")}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t("keys.accounts.pickHint")}</p>
                <ul className="mt-2 flex flex-col gap-1">
                    <li>
                        <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-muted/50">
                            <input type="checkbox" className="size-4 accent-primary" checked={c.all} disabled={busy || c.all} onChange={() => onChange(null)} />
                            {t("keys.accounts.all")}
                        </label>
                    </li>
                    {accounts.map((a) => {
                        const on = current.includes(a.id);
                        const last = on && current.length === 1;
                        return (
                            <li key={a.id}>
                                <label className={cn("flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 font-mono text-sm hover:bg-muted/50", last && "cursor-not-allowed")} title={last ? t("keys.accounts.onlyOne") : undefined}>
                                    <input type="checkbox" className="size-4 accent-primary" checked={on} disabled={busy || last} onChange={(e) => onChange(toggleChosen(k.accounts, accounts, a.id, e.target.checked))} />
                                    {a.username}
                                </label>
                            </li>
                        );
                    })}
                </ul>
            </PopoverContent>
        </Popover>
    );
}

interface Handlers {
    busy: string | null;
    onToggle: (keyId: number, on: boolean) => void;
    onSetAccounts: (keyId: number, accounts: number[] | null) => void;
    onToggleGroup: (groupId: number, on: boolean, grantId?: number) => void;
}

/** 一把金鑰一列。/ One row per key. */
function KeyRow({ k, d, targets, busy, onToggle, onSetAccounts, indent }: { k: MyKey; d: DeviceKeys; targets: KeyTarget[] | null; indent: boolean } & Omit<Handlers, "onToggleGroup">) {
    const { t } = useI18n();
    const keyBusy = busy === `key:${k.id}` || busy === "all" || busy === `accounts:${k.id}`;
    const reach = reachOf(k);
    const id = `here-key-${k.id}`;
    // 帳號只在直接放上、而且有兩個以上帳號時能選。/ Accounts are chosen only for a direct entry with 2+ accounts.
    const picker = k.in_list && d.account_ids.length > 1;
    return (
        <li className={cn("flex flex-col gap-1.5 py-2.5 pr-3.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-3", indent ? "pl-9" : "pl-3.5", reach !== "none" && "bg-primary/[0.03]")}>
            <label htmlFor={id} className="flex min-w-0 cursor-pointer items-start gap-2.5" title={k.fingerprint ?? ""}>
                {keyBusy ? (
                    <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" aria-hidden />
                ) : (
                    <input id={id} type="checkbox" checked={k.in_list} onChange={(e) => onToggle(k.id, e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-primary" aria-label={t("keys.here.toggleAria", { key: k.name })} />
                )}
                <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                        <span className="break-all text-sm text-foreground">{k.name}</span>
                        {k.expired && <Chip tone="danger">{t("keys.here.expired")}</Chip>}
                    </span>
                    <span className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-xs text-muted-foreground">
                        <span>{k.key_type ?? "?"}</span>
                        {k.fingerprint && <span>{shortFingerprint(k.fingerprint)}</span>}
                    </span>
                </span>
            </label>
            <span className="flex min-w-0 flex-wrap items-center gap-1.5 pl-[1.625rem] @xl:shrink-0 @xl:justify-end @xl:pl-0">
                {reach === "none" ? (
                    <span className="text-xs text-muted-foreground">{t("keys.here.notHere")}</span>
                ) : (
                    <>
                        <Chip tone={reach === "group" ? "neutral" : "primary"} title={t(REACH[reach].tip)}>
                            {reach === "group" ? <Layers aria-hidden /> : null}
                            {t(REACH[reach].label)}
                        </Chip>
                        {picker && <AccountPicker k={k} accounts={d.account_ids} busy={keyBusy} onChange={(accounts) => onSetAccounts(k.id, accounts)} />}
                        {targets && <TargetChips targets={targets} online={d.tunnel.online} compact />}
                    </>
                )}
            </span>
        </li>
    );
}

/** 金鑰群組的標題列：勾選 = 整組交給這台。/ A key group's header row; the tick grants the whole group here. */
function GroupHeader({ g, count, open, onOpen, busy, onToggle }: { g: MyKeyGroupHere; count: number; open: boolean; onOpen: () => void; busy: boolean; onToggle: (on: boolean) => void }) {
    const { t } = useI18n();
    const here = groupHere(g);
    return (
        <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 bg-surface px-3.5 py-2", here && "bg-primary/[0.06]")}>
            <span className="flex min-w-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onOpen}
                    aria-expanded={open}
                    aria-label={t(open ? "keys.here.collapse" : "keys.here.expand", { name: g.name })}
                    className="-ml-1 grid size-6 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                    {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                </button>
                <label className="flex min-w-0 cursor-pointer items-center gap-2">
                    {busy ? (
                        <Loader2 size={16} className="shrink-0 animate-spin text-primary" aria-hidden />
                    ) : (
                        <input type="checkbox" checked={!!g.grant} onChange={(e) => onToggle(e.target.checked)} aria-label={t("groups.device.toggleAria", { name: g.name })} className="size-4 shrink-0 accent-primary" />
                    )}
                    <Layers size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                    <span className="break-all text-sm text-foreground">{g.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t("groups.device.keyCount", { count })}</span>
                </label>
            </span>
            <span className="flex flex-wrap items-center gap-1.5 pl-8">
                {g.grant?.accounts && <Chip tone="warning" mono className="whitespace-normal break-all">{t("groups.grant.only", { accounts: g.grant.accounts.join(", ") })}</Chip>}
                {g.via_tunnel_group && (
                    <Chip title={t("groups.device.viaTunnelGroupTip", { name: g.via_tunnel_group.name })}>
                        <FolderTree aria-hidden /> {t("groups.device.viaTunnelGroup", { name: g.via_tunnel_group.name })}
                    </Chip>
                )}
                {here ? <Chip tone="primary">{t("keys.here.groupHere")}</Chip> : <span className="text-xs text-muted-foreground">{t("keys.here.groupNotHere")}</span>}
            </span>
        </div>
    );
}

export function MyKeysOnDevice({
    d,
    busy,
    onToggle,
    onAddAll,
    onSetAccounts,
    onToggleGroup,
    onNavigate,
}: Handlers & {
    d: DeviceKeys;
    onAddAll: (keyIds: number[]) => void;
    /** 點「新增金鑰」離開面板時。/ Called when the "add a key" link leaves the panel. */
    onNavigate: () => void;
}) {
    const { t } = useI18n();
    const keys = d.my_keys;
    const groups = useMemo(() => d.my_key_groups ?? [], [d.my_key_groups]);
    const [query, setQuery] = useState("");
    const [closed, setClosed] = useState<Set<string>>(() => new Set());
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    // 順序在打開（換裝置）時排一次；之後新出現的金鑰接在後面。/ Ordered once per device; new keys go last.
    const [order, setOrder] = useState<{ tunnel: number; ids: number[] }>(() => ({ tunnel: d.tunnel.id, ids: initialOrder(keys) }));
    let ids = order.ids;
    if (order.tunnel !== d.tunnel.id) {
        ids = initialOrder(keys);
        setOrder({ tunnel: d.tunnel.id, ids });
    }
    const ordered = useMemo(() => {
        const byId = new Map(keys.map((k) => [k.id, k]));
        const known = new Set(ids);
        return [...ids.flatMap((id) => byId.get(id) ?? []), ...keys.filter((k) => !known.has(k.id))];
    }, [keys, ids]);
    const sections = useMemo(() => keySections(ordered, groups, query), [ordered, groups, query]);
    const targetsOf = useMemo(() => new Map(d.entries.filter((e) => e.mine).map((e) => [e.user_key_id, e.targets])), [d.entries]);
    const sum = reachSummary(keys);
    const notHere = keys.filter((k) => !k.in_list).map((k) => k.id);
    const searching = query.trim().length > 0;

    if (keys.length === 0 && groups.length === 0) {
        return (
            <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
                {t("keys.device.noMyKeys")}{" "}
                <Link href="/tunnels/keys" onClick={onNavigate} className="text-primary hover:underline">{t("keys.addKey")}</Link>
            </p>
        );
    }

    const toggleSet = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
        const next = new Set(set);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setter(next);
    };

    return (
        <div className="@container space-y-3">
            {d.accounts.length === 0 && <Callout tone="warning">{d.can_manage ? t("keys.matrix.noAccountsOwner") : t("keys.matrix.noAccountsSharee")}</Callout>}
            <div className="space-y-1">
                <p className="text-sm text-foreground">{t("keys.here.summary", { here: sum.here, total: sum.total })}</p>
                <p className="text-sm text-muted-foreground">
                    {d.accounts.length > 0 ? t("keys.here.hint", { accounts: d.accounts.join(", ") }) : t("keys.here.hintNoAccounts")}
                </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {keys.length >= MY_KEYS_FILTER_FROM && (
                    <div className="relative min-w-[12rem] max-w-xs flex-1">
                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("keys.myKeys.search")} aria-label={t("keys.myKeys.search")} className="h-8 pl-8" />
                    </div>
                )}
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {sum.direct > 0 && <Chip tone="primary">{t("keys.here.countDirect", { count: sum.direct })}</Chip>}
                    {sum.viaGroup > 0 && <Chip><Layers aria-hidden /> {t("keys.here.countGroup", { count: sum.viaGroup })}</Chip>}
                </span>
                {notHere.length > 0 && keys.length > 1 && (
                    <Button variant="ghost" size="sm" className="ml-auto text-primary hover:text-primary" disabled={busy === "all"} onClick={() => onAddAll(notHere)}>
                        <Plus /> {t("keys.device.addAllMine")}
                    </Button>
                )}
            </div>

            {sections.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-3 text-center text-sm text-muted-foreground">{t("keys.rows.noMatch")}</p>
            ) : (
                <div className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-border">
                    {sections.map((s) => {
                        const sid = s.group ? `g${s.group.id}` : "loose";
                        const open = searching || !closed.has(sid);
                        const long = !searching && !expanded.has(sid) && s.keys.length > MY_KEYS_COLLAPSED + 2;
                        const shown = long ? s.keys.slice(0, MY_KEYS_COLLAPSED) : s.keys;
                        return (
                            <section key={sid}>
                                {s.group ? (
                                    <GroupHeader
                                        g={s.group}
                                        count={s.total}
                                        open={open}
                                        onOpen={() => toggleSet(closed, setClosed, sid)}
                                        busy={busy === `group:${s.group.id}`}
                                        onToggle={(on) => onToggleGroup(s.group!.id, on, s.group!.grant?.id)}
                                    />
                                ) : (
                                    groups.length > 0 && (
                                        <div className="flex items-center gap-2 bg-surface px-3.5 py-2 text-sm text-muted-foreground">
                                            <KeyRound size={14} aria-hidden /> {t("keys.here.ungrouped")}
                                            <span className="text-xs">{t("groups.device.keyCount", { count: s.total })}</span>
                                        </div>
                                    )
                                )}
                                {open && (
                                    <>
                                        {s.keys.length === 0 ? (
                                            <p className="py-2.5 pl-9 pr-3.5 text-sm text-muted-foreground">{t("keys.here.emptyGroup")}</p>
                                        ) : (
                                            <ul className="divide-y divide-border/50">
                                                {shown.map((k) => (
                                                    <KeyRow key={k.id} k={k} d={d} targets={targetsOf.get(k.id) ?? null} busy={busy} onToggle={onToggle} onSetAccounts={onSetAccounts} indent={!!s.group} />
                                                ))}
                                            </ul>
                                        )}
                                        {long && (
                                            <div className="border-t border-border/50 px-3.5 py-1.5">
                                                <Button variant="ghost" size="xs" onClick={() => toggleSet(expanded, setExpanded, sid)}>
                                                    <ChevronDown /> {t("keys.myKeys.showMore", { count: s.keys.length - shown.length })}
                                                </Button>
                                            </div>
                                        )}
                                    </>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
