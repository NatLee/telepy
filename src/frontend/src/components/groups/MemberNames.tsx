"use client";

/**
 * 群組成員名稱：浮層裡有人數、8 個起有搜尋、一次 20 個分頁；`FoldedNames` = 列表裡只列前幾個，其餘「+N」打開同一個浮層。
 * A group's member names: the popover shows the count, a search from 8 names and pages of 20; `FoldedNames` = a row
 * lists the first few and "+N more" opens the same popover.
 */
import React, { useState } from "react";
import { Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePagination } from "@/hooks/usePagination";
import { filterNames, foldList } from "@/lib/peopleGroups";
import { pageSlice } from "@/lib/pagination";
import { useI18n } from "@/lib/i18n";

const SEARCH_FROM = 8;
const PAGE = [20] as const;

function NameList({ title, names }: { title: string; names: string[] }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const shown = filterNames(names, query);
    const pager = usePagination(shown.length, { storageKey: "telepy.groupMembersPageSize", resetKey: query, sizes: PAGE });
    return (
        <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
                {title} · <span className="tabular-nums">{names.length}</span>
            </p>
            {names.length >= SEARCH_FROM && (
                <div className="relative">
                    <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("peopleGroups.searchMembers")} aria-label={t("peopleGroups.searchMembers")} className="h-8 pl-8 text-sm" />
                </div>
            )}
            {names.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("share.group.empty")}</p>
            ) : shown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("groups.noMatch")}</p>
            ) : (
                <ul className="space-y-1 text-sm">
                    {pageSlice(shown, pager.page, pager.size).map((n) => (
                        <li key={n} className="truncate" title={n}>{n}</li>
                    ))}
                </ul>
            )}
            <Pagination pager={pager} compact className="justify-center" />
        </div>
    );
}

/** 「成員」按鈕 + 浮層。/ The "Members" button and its popover. */
export function MemberNamesPopover({ title, names, trigger }: { title: string; names: string[]; trigger?: React.ReactNode }) {
    const { t } = useI18n();
    return (
        <Popover>
            <PopoverTrigger asChild>
                {trigger ?? (
                    <Button type="button" size="sm" variant="ghost" className="text-xs">
                        <Users size={14} /> {t("share.group.members")} <span className="tabular-nums text-muted-foreground">{names.length}</span>
                    </Button>
                )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3">
                <NameList title={title} names={names} />
            </PopoverContent>
        </Popover>
    );
}

/** 列表裡的成員名稱：前 `max` 個，其餘「+N」打開浮層。/ Member names in a row: the first `max`, "+N more" opens the popover. */
export function FoldedNames({ title, names, max = 5 }: { title: string; names: string[]; max?: number }) {
    const { t } = useI18n();
    const { shown, more } = foldList(names, max);
    if (names.length === 0) return null;
    return (
        <span className="text-xs leading-snug text-muted-foreground">
            {t("personalGroups.membersList", { names: shown.join(", ") })}
            {more > 0 && (
                <>
                    {" "}
                    <MemberNamesPopover
                        title={title}
                        names={names}
                        trigger={
                            <button type="button" className="text-foreground underline-offset-2 hover:underline">
                                {t("peopleGroups.moreCount", { count: more })}
                            </button>
                        }
                    />
                </>
            )}
        </span>
    );
}
