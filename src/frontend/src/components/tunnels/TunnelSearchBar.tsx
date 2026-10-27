/**
 * 隧道列表的搜尋列：輸入框（支援 `status:` `lastseen:` 這類篩選，見 lib/tunnelQuery）、篩選範例選單（點了就加進搜尋）、
 * 看不懂的詞提示、排序與檢視切換。
 * Tunnel list search bar: the input (with `status:` / `lastseen:` filters, see lib/tunnelQuery), a menu of filter
 * examples that append to the query, a hint for terms it could not understand, sort and the view toggle.
 */
import React from "react";
import { ListFilter, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { TUNNEL_SORTS, type TunnelSort } from "@/lib/tunnelQuery";
import type { TranslationKey } from "@/locales/en";

const EXAMPLES: { term: string; key: TranslationKey }[] = [
    { term: "status:degraded", key: "tunnels.q.degraded" },
    { term: "status:down", key: "tunnels.q.down" },
    { term: "lastseen:>1d", key: "tunnels.q.lastseen" },
    { term: "shared:in", key: "tunnels.q.sharedIn" },
    { term: "shared:out", key: "tunnels.q.sharedOut" },
    { term: "port:2000-3000", key: "tunnels.q.port" },
    { term: "ip:203.0.113", key: "tunnels.q.ip" },
    { term: "user:alice", key: "tunnels.q.user" },
    { term: "label:prod", key: "tunnels.q.label" },
    { term: "pinned:yes", key: "tunnels.q.pinned" },
    { term: "group:prod", key: "tunnels.q.group" },
    { term: "warn:any", key: "tunnels.q.warn" },
    { term: "-status:never", key: "tunnels.q.negate" },
];

const SORT_LABEL: Record<TunnelSort, TranslationKey> = {
    name: "tunnels.sort.name",
    status: "tunnels.sort.status",
    lastseen: "tunnels.sort.lastseen",
    port: "tunnels.sort.port",
};

interface TunnelSearchBarProps {
    query: string;
    onQueryChange: (q: string) => void;
    invalid: string[];
    sort: TunnelSort;
    onSortChange: (s: TunnelSort) => void;
    shown: number;
    total: number;
    /** 檢視切換（只在寬螢幕顯示）。/ The view toggle (wide screens only). */
    viewToggle?: React.ReactNode;
    /** 群組按鈕與「依群組 / 一個列表」切換。/ The groups button and the grouping toggle. */
    groupControls?: React.ReactNode;
}

export function TunnelSearchBar({ query, onQueryChange, invalid, sort, onSortChange, shown, total, viewToggle, groupControls }: TunnelSearchBarProps) {
    const { t } = useI18n();
    const add = (term: string) => {
        const base = query.trim();
        onQueryChange(base ? `${base} ${term}` : term);
    };

    return (
        <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1 basis-64 max-w-xl">
                    <Search size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input
                        value={query}
                        onChange={(e) => onQueryChange(e.target.value)}
                        placeholder={t("tunnels.searchPlaceholder")}
                        aria-label={t("tunnels.searchAria")}
                        spellCheck={false}
                        autoCapitalize="none"
                        className="h-9 pl-9 pr-9"
                    />
                    {query && (
                        <button
                            type="button"
                            onClick={() => onQueryChange("")}
                            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={t("tunnels.clearSearch")}
                        >
                            <X size={14} />
                        </button>
                    )}
                </div>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-9">
                            <ListFilter size={15} />
                            {t("tunnels.filterHelp")}
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-80">
                        <DropdownMenuLabel className="text-xs text-muted-foreground">{t("tunnels.filterHelpTitle")}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {EXAMPLES.map(({ term, key }) => (
                            <DropdownMenuItem key={term} onSelect={() => add(term)} className="flex-col items-start gap-0.5">
                                <code className="font-mono text-xs text-foreground">{term}</code>
                                <span className="text-xs text-muted-foreground">{t(key)}</span>
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
                {groupControls}
                <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{t("tunnels.showingCount", { shown, total })}</span>
                <div className="ml-auto flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="hidden sm:inline">{t("tunnels.sortLabel")}</span>
                        <NativeSelect value={sort} onChange={(e) => onSortChange(e.target.value as TunnelSort)} aria-label={t("tunnels.sortLabel")} className="w-52">
                            {TUNNEL_SORTS.map((s) => (
                                <option key={s} value={s}>
                                    {t(SORT_LABEL[s])}
                                </option>
                            ))}
                        </NativeSelect>
                    </label>
                    {viewToggle}
                </div>
            </div>
            {invalid.length > 0 && (
                <p className="text-xs text-warning" role="status">
                    {t("tunnels.invalidFilter", { terms: invalid.join(" ") })}
                </p>
            )}
        </div>
    );
}
