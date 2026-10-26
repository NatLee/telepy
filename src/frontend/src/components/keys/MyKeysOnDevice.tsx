/**
 * 裝置金鑰面板的「你在這台裝置上的金鑰」：勾選 = 放進這台裝置的清單。金鑰多時：已在清單上的排前面（打開時排一次，
 * 勾選不會讓金鑰跳位置）、搜尋、先顯示幾把再「再顯示」，上方一句「N 把中有 M 把在清單上」。
 * "Your keys on this device": a tick puts the key on this device's list. With many keys: keys on the list come
 * first (ordered once when the panel opens, so ticking never makes a chip jump), a search box, a collapsed
 * view with "show more", and a "M of N on the list" line.
 */
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, KeyRound, Loader2, Plus, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SectionHeading } from "@/components/ui/section";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { chosenCount, toggleChosen } from "@/lib/keyPlacement";
import { fieldsMatch, queryTerms } from "@/lib/keyRows";
import type { DeviceAccount, DeviceKeys } from "@/types/keys";

/** 這麼多把以上才有搜尋與收合。/ Search and collapsing from this many keys on. */
export const MY_KEYS_FILTER_FROM = 7;
/** 收合時顯示幾把。/ Keys shown while collapsed. */
export const MY_KEYS_COLLAPSED = 8;

type MyKey = DeviceKeys["my_keys"][number];

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

/** 已在清單上的排前面，其餘照原順序。/ Keys on the list first, otherwise in server order. */
export function initialOrder(keys: MyKey[]): number[] {
    return [...keys.filter((k) => k.in_list), ...keys.filter((k) => !k.in_list)].map((k) => k.id);
}

export function MyKeysOnDevice({
    d,
    busy,
    onToggle,
    onAddAll,
    onSetAccounts,
    onNavigate,
}: {
    d: DeviceKeys;
    busy: string | null;
    onToggle: (keyId: number, on: boolean) => void;
    onAddAll: (keyIds: number[]) => void;
    /** 這把金鑰只裝到這些帳號（null = 全部）。/ Limit a listed key to these accounts (null = all). */
    onSetAccounts: (keyId: number, accounts: number[] | null) => void;
    /** 點「新增金鑰」離開面板時。/ Called when the "add a key" link leaves the panel. */
    onNavigate: () => void;
}) {
    const { t } = useI18n();
    const keys = d.my_keys;
    const [query, setQuery] = useState("");
    const [expanded, setExpanded] = useState(false);
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

    const many = keys.length >= MY_KEYS_FILTER_FROM;
    const terms = queryTerms(query);
    const matching = terms.length ? ordered.filter((k) => fieldsMatch([k.name, k.fingerprint, k.key_type], terms)) : ordered;
    const collapsed = many && !expanded && terms.length === 0 && matching.length > MY_KEYS_COLLAPSED + 2;
    const visible = collapsed ? matching.slice(0, MY_KEYS_COLLAPSED) : matching;
    const onList = keys.filter((k) => k.in_list).length;
    const notOnList = keys.filter((k) => !k.in_list).map((k) => k.id);

    return (
        <section>
            <SectionHeading
                title={t("keys.device.myKeys")}
                description={
                    d.accounts.length > 0
                        ? t("keys.device.myKeysHint", { accounts: d.accounts.join(", ") })
                        : d.can_manage
                          ? t("keys.matrix.noAccountsOwner")
                          : t("keys.matrix.noAccountsSharee")
                }
                className="mb-2.5"
            />
            {keys.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    {t("keys.device.noMyKeys")}{" "}
                    <Link href="/tunnels/keys" onClick={onNavigate} className="text-primary hover:underline">{t("keys.addKey")}</Link>
                </p>
            ) : (
                <div className="space-y-2.5">
                    {many && (
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <div className="relative min-w-[12rem] max-w-xs flex-1">
                                <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                <Input
                                    type="search"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                    placeholder={t("keys.myKeys.search")}
                                    aria-label={t("keys.myKeys.search")}
                                    className="h-8 pl-8"
                                />
                            </div>
                            <span className="text-xs text-muted-foreground">{t("keys.myKeys.summary", { on: onList, total: keys.length })}</span>
                        </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                        {visible.map((k) => {
                            const keyBusy = busy === `key:${k.id}` || busy === "all" || busy === `accounts:${k.id}`;
                            // 有一個以上的帳號才需要選；勾選框與帳號選擇並排在同一顆籤裡。/ The picker only matters with 2+ accounts.
                            const picker = k.in_list && d.account_ids.length > 1;
                            return (
                                <span
                                    key={k.id}
                                    className={cn(
                                        "inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 ring-1 ring-inset ring-border transition-colors hover:bg-muted/50",
                                        k.in_list && "bg-primary/6 ring-primary/35"
                                    )}
                                >
                                    <label className="inline-flex cursor-pointer items-center gap-2" title={k.fingerprint ?? ""}>
                                        {keyBusy ? (
                                            <Loader2 size={16} className="animate-spin text-primary" aria-hidden />
                                        ) : (
                                            <input type="checkbox" checked={k.in_list} onChange={(e) => onToggle(k.id, e.target.checked)} className="size-4 accent-primary" />
                                        )}
                                        <KeyRound size={14} className="text-muted-foreground" aria-hidden />
                                        <span className="text-sm text-foreground">{k.name}</span>
                                        <span className="font-mono text-xs text-muted-foreground">{k.key_type ?? "?"}</span>
                                    </label>
                                    {picker && <AccountPicker k={k} accounts={d.account_ids} busy={keyBusy} onChange={(accounts) => onSetAccounts(k.id, accounts)} />}
                                </span>
                            );
                        })}
                        {collapsed && (
                            <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
                                <ChevronDown /> {t("keys.myKeys.showMore", { count: matching.length - visible.length })}
                            </Button>
                        )}
                        {notOnList.length > 0 && keys.length > 1 && (
                            <Button variant="ghost" size="sm" className="text-primary hover:text-primary" disabled={busy === "all"} onClick={() => onAddAll(notOnList)}>
                                <Plus /> {t("keys.device.addAllMine")}
                            </Button>
                        )}
                    </div>
                    {terms.length > 0 && matching.length === 0 && <p className="text-sm text-muted-foreground">{t("keys.rows.noMatch")}</p>}
                </div>
            )}
        </section>
    );
}
