/**
 * 群組很多時的單選清單（「移到群組」、授予給哪個通道群組）：7 組起有搜尋，清單和成員挑選一樣分頁
 * （每頁筆數記在 `telepy.groupListPageSize`）；目前選的那組不在這一頁時也接在後面，不會看不到。
 * Single-choice group lists with many groups ("Move to group", which tunnel group to grant to): a search from 7
 * groups and pages like the member picker (page size kept in `telepy.groupListPageSize`); the current choice is
 * appended when it is on another page, so it never disappears.
 */
import React, { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { useI18n } from "@/lib/i18n";
import { pageSlice } from "@/lib/pagination";
import { pickerTerms } from "@/lib/memberPicker";
import { groupMatches } from "@/lib/groups";

/** 這麼多組以上才有搜尋。/ Search from this many groups on (as in the member picker). */
const SEARCH_FROM = 7;

export function useGroupSearch<T extends { id: number; name: string; description?: string; labels?: string[] }>(groups: T[], current: number | null) {
    const [query, setQuery] = useState("");
    const terms = pickerTerms(query);
    // 名稱、說明、標籤都搜得到。/ Name, description and labels are all searched.
    const matching = terms.length ? groups.filter((g) => groupMatches(g, terms)) : groups;
    const pager = usePagination(matching.length, { storageKey: "telepy.groupListPageSize", resetKey: query });
    const page = pageSlice(matching, pager.page, pager.size);
    const chosen = current === null || page.some((g) => g.id === current) ? undefined : matching.find((g) => g.id === current);
    return {
        query,
        setQuery,
        visible: chosen ? [...page, chosen] : page,
        matching: matching.length,
        pager,
        showSearch: groups.length >= SEARCH_FROM,
    };
}

export type GroupSearchState = ReturnType<typeof useGroupSearch>;

export function GroupSearchBox({ s }: { s: GroupSearchState }) {
    const { t } = useI18n();
    if (!s.showSearch) return null;
    return (
        <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={s.query} onChange={(e) => s.setQuery(e.target.value)} placeholder={t("groups.searchGroups")} aria-label={t("groups.searchGroups")} className="h-8 pl-8" />
        </div>
    );
}

/** 分頁與「沒有符合的」。/ Pages and the no-match line. */
export function GroupSearchFooter({ s }: { s: GroupSearchState }) {
    const { t } = useI18n();
    if (s.matching === 0 && s.query) return <p className="py-2 text-center text-sm text-muted-foreground">{t("groups.noMatch")}</p>;
    return <Pagination pager={s.pager} />;
}
