/**
 * 裝置矩陣的「金鑰欄」：選哪幾把金鑰當欄位（記在 localStorage `telepy.keyMatrixColumns`）。沒選過時是最近用過的
 * 4 把；選的金鑰被刪光了也退回這個預設。金鑰多時有搜尋；至少留一欄。
 * The device matrix's "key columns": which keys are columns (kept in localStorage `telepy.keyMatrixColumns`).
 * Without a choice it is the four most recently used; a choice whose keys were all deleted falls back to that.
 * A search appears with many keys; at least one column stays.
 */
import React, { useMemo, useState } from "react";
import { Columns3, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoreBelow } from "@/components/ui/Modal";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/lib/i18n";
import { fieldsMatch, queryTerms } from "@/lib/keyRows";
import { KEY_LIST_FILTER_FROM, matrixColumns, sortKeys } from "@/lib/userKeyList";
import type { UserKey } from "@/types/keys";

const COLUMNS_KEY = "telepy.keyMatrixColumns";

function readChosen(): number[] | null {
    try {
        const v = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null");
        return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : null;
    } catch {
        return null;
    }
}

/** 選了哪些欄（null = 預設）與算出來的欄位。/ The stored choice (null = default) and the resulting columns. */
export function useKeyColumns(keys: UserKey[]) {
    const { locale } = useI18n();
    // 金鑰區只在瀏覽器端算繪，直接讀 localStorage。/ The keys area renders client-side only.
    const [chosen, setChosenState] = useState<number[] | null>(readChosen);
    const columns = useMemo(() => matrixColumns(keys, chosen, undefined, locale), [keys, chosen, locale]);
    const setChosen = (ids: number[] | null) => {
        setChosenState(ids);
        try {
            if (ids === null) localStorage.removeItem(COLUMNS_KEY);
            else localStorage.setItem(COLUMNS_KEY, JSON.stringify(ids));
        } catch {
            /* 這次就不記。/ Not remembered this time. */
        }
    };
    return { columns, chosen, setChosen };
}

export function KeyColumnsPicker({ keys, columns, onChange }: { keys: UserKey[]; columns: UserKey[]; onChange: (ids: number[] | null) => void }) {
    const { t, locale } = useI18n();
    const [query, setQuery] = useState("");
    const sorted = useMemo(() => sortKeys(keys, "recent", locale), [keys, locale]);
    const terms = queryTerms(query);
    const shown = sorted.filter((k) => fieldsMatch([k.host_friendly_name, k.comment, k.fingerprint], terms));
    const on = new Set(columns.map((k) => k.id));
    const toggle = (id: number) => {
        const next = new Set(on);
        if (next.has(id)) {
            if (next.size === 1) return; // 至少留一欄。/ Keep at least one column.
            next.delete(id);
        } else next.add(id);
        onChange([...next]);
    };
    if (keys.length < 2) return null;
    return (
        <Popover onOpenChange={(open) => !open && setQuery("")}>
            <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="shrink-0">
                    <Columns3 /> {t("keys.columns.button", { shown: columns.length, total: keys.length })}
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-80 flex-col overflow-hidden p-0">
                <div className="shrink-0 space-y-2 border-b border-border px-3 py-2.5">
                    <p className="text-sm text-foreground">{t("keys.columns.title")}</p>
                    <p className="text-xs text-muted-foreground">{t("keys.columns.hint")}</p>
                    {keys.length >= KEY_LIST_FILTER_FROM && (
                        <div className="relative">
                            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("keys.list.search")} aria-label={t("keys.list.search")} className="h-8 pl-8" />
                        </div>
                    )}
                </div>
                <div className="relative flex min-h-0 max-h-72 flex-col overflow-y-auto overscroll-contain">
                    <ul className="py-1">
                        {shown.map((k) => (
                            <li key={k.id}>
                                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-muted">
                                    <input type="checkbox" checked={on.has(k.id)} onChange={() => toggle(k.id)} className="size-4 shrink-0 cursor-pointer rounded accent-primary" />
                                    <span className="min-w-0 flex-1 truncate text-foreground" title={k.host_friendly_name}>{k.host_friendly_name}</span>
                                    <span className="shrink-0 font-mono text-[0.6875rem] text-muted-foreground">{k.key_type ?? "?"}</span>
                                </label>
                            </li>
                        ))}
                        {shown.length === 0 && <li className="px-3 py-3 text-center text-xs text-muted-foreground">{t("keys.rows.noMatch")}</li>}
                    </ul>
                    <MoreBelow className="bottom-0 -mt-12 h-12 from-popover via-popover/85" />
                </div>
                <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-2">
                    <Button variant="ghost" size="xs" onClick={() => onChange(null)}>
                        {t("keys.columns.recent")}
                    </Button>
                    <Button variant="ghost" size="xs" className="text-primary hover:text-primary" onClick={() => onChange(keys.map((k) => k.id))}>
                        {t("keys.columns.all", { count: keys.length })}
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
