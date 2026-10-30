"use client";

/**
 * 主機總覽：每個名稱一列，ssh 實際用的 HostName / User / Port / 跳板 / 金鑰（`lib/sshConfigEdit.hostTable`）；值旁邊標出是
 * 自己的區塊、共用的區塊還是萬用字元給的（游標停留看第幾行）。最後一列是「檔案沒寫到的其他名稱」。搜尋先篩全部、再分頁；
 * 寬的時候是表格，窄的時候每台兩行。點一列打開表單。
 * The host overview: one row per name with what ssh actually uses — HostName / User / Port / jump / keys
 * (`lib/sshConfigEdit.hostTable`); each value says whether it comes from the host's own block, a shared block or a
 * wildcard (hover for the line). The last row is "any other name". Search filters everything, then pages; a table
 * when wide, two lines per host when narrow. A click opens the form.
 */
import React, { useMemo, useState } from "react";
import { Layers, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { OTHER, type Cell, type HostRow } from "@/lib/sshConfigEdit";

const COLUMNS: { slot: string; label: string }[] = [
    { slot: "hostname", label: "HostName" },
    { slot: "user", label: "User" },
    { slot: "port", label: "Port" },
    { slot: "proxyjump", label: "ProxyJump" },
    { slot: "identityfile", label: "IdentityFile" },
];

function cellsOf(row: HostRow, slot: string): Cell[] {
    if (slot === "identityfile") return row.stacks.identityfile ?? [];
    if (slot === "proxyjump") return row.cells.proxycommand ? [row.cells.proxycommand] : row.cells.proxyjump ? [row.cells.proxyjump] : [];
    return row.cells[slot] ? [row.cells[slot]] : [];
}

function Value({ cells, t }: { cells: Cell[]; t: ReturnType<typeof useI18n>["t"] }) {
    if (cells.length === 0) return <span className="text-muted-foreground/70">—</span>;
    return (
        <span className="flex min-w-0 flex-col">
            {cells.map((c) => (
                <span
                    key={c.n}
                    className={cn("flex min-w-0 items-center gap-1 font-mono text-[0.8125rem]", c.own ? "text-foreground" : "text-muted-foreground")}
                    title={c.header ? t("tidy.edit.fromShared", { line: c.n, header: c.header }) : t("tidy.edit.fromGlobal", { line: c.n })}
                >
                    {!c.own && <Layers size={11} className="shrink-0" aria-label={t("tidy.hosts.inherited")} />}
                    <span className="truncate">{c.key.toLowerCase() === "proxycommand" ? `ProxyCommand ${c.value}` : c.value}</span>
                </span>
            ))}
        </span>
    );
}

/** 窄的時候一台兩行：`user@host:port`（22 不寫），再一行跳板與金鑰；繼承的部分灰字。
 * Narrow: two lines per host — `user@host:port` (22 left out), then jump and keys; inherited parts in grey. */
function Destination({ row }: { row: HostRow }) {
    const { t } = useI18n();
    const part = (c: Cell | undefined, fallback: string) => (
        <span className={c?.own ? "text-foreground" : "text-muted-foreground"} title={c ? (c.header ? t("tidy.edit.fromShared", { line: c.n, header: c.header }) : t("tidy.edit.fromGlobal", { line: c.n })) : undefined}>
            {c ? c.value : fallback}
        </span>
    );
    const port = row.cells.port && row.cells.port.value !== "22" ? row.cells.port : undefined;
    const jump = cellsOf(row, "proxyjump")[0];
    const keys = row.stacks.identityfile ?? [];
    return (
        <span className="mt-0.5 block font-mono text-[0.8125rem] [overflow-wrap:anywhere]">
            <span className="block">
                {row.cells.user && <>{part(row.cells.user, "")}@</>}
                {part(row.cells.hostname, row.name === OTHER ? "…" : row.name)}
                {port && <>:{part(port, "")}</>}
            </span>
            {(jump || keys.length > 0) && (
                <span className="block text-xs text-muted-foreground">
                    {jump && <>{t("tidy.hosts.via", { jump: jump.value })}{keys.length > 0 && " · "}</>}
                    {keys.map((k, i) => (
                        <React.Fragment key={k.n}>
                            {i > 0 && ", "}
                            {part(k, "")}
                        </React.Fragment>
                    ))}
                </span>
            )}
        </span>
    );
}

interface Props {
    rows: HostRow[];
    other: HostRow;
    hasMatch: boolean;
    onOpen: (name: string) => void;
    onAdd: () => void;
}

export function HostsPanel({ rows, other, hasMatch, onOpen, onAdd }: Props) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const filtered = useMemo(
        () => (q ? rows.filter((r) => r.name.toLowerCase().includes(q) || COLUMNS.some((c) => cellsOf(r, c.slot).some((x) => x.value.toLowerCase().includes(q)))) : rows),
        [rows, q],
    );
    const pager = usePagination(filtered.length, { storageKey: "telepy.sshEditorHostsPageSize", resetKey: q, sizes: [25, 50, 100] });
    const shown = filtered.slice(pager.from - 1, pager.to);

    const row = (r: HostRow, isOther = false) => (
        <tr
            key={r.name}
            className={cn("border-t border-border/70", !isOther && "cursor-pointer hover:bg-muted/40")}
            onClick={isOther ? undefined : () => onOpen(r.name)}
        >
            <td className="px-3 py-2 align-top">
                {isOther ? (
                    <span className="text-sm italic text-muted-foreground">{t("tidy.hosts.other")}</span>
                ) : (
                    <button type="button" className="flex items-center gap-1.5 text-left font-mono text-sm text-primary hover:underline focus-visible:outline-none focus-visible:underline" onClick={(e) => { e.stopPropagation(); onOpen(r.name); }}>
                        {r.name}
                        {r.telepy && <Chip tone="neutral">Telepy</Chip>}
                    </button>
                )}
            </td>
            {COLUMNS.map((c) => (
                <td key={c.slot} className="max-w-[14rem] px-3 py-2 align-top"><Value cells={cellsOf(r, c.slot)} t={t} /></td>
            ))}
        </tr>
    );

    return (
        <div className="@container space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("tidy.hosts.search")} aria-label={t("tidy.hosts.search")} className="h-9 pl-8" />
                </div>
                <Button size="sm" onClick={onAdd}>
                    <Plus size={15} /> {t("tidy.hosts.add")}
                </Button>
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Layers size={12} aria-hidden /> {t("tidy.hosts.legend")}
            </p>
            {hasMatch && <Callout tone="info">{t("tidy.hosts.match")}</Callout>}

            {/* 寬：表格 / Wide: a table */}
            <div className="hidden overflow-x-auto rounded-lg ring-1 ring-inset ring-border/70 @3xl:block">
                <table className="w-full text-left">
                    <thead className="bg-surface text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-normal">{t("tidy.hosts.name")}</th>
                            {COLUMNS.map((c) => (
                                <th key={c.slot} className="px-3 py-2 font-mono font-normal">{c.label}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((r) => row(r))}
                        {pager.to === filtered.length && !q && row(other, true)}
                    </tbody>
                </table>
            </div>

            {/* 窄：每台兩行 / Narrow: two lines per host */}
            <ul className="divide-y divide-border/70 rounded-lg ring-1 ring-inset ring-border/70 @3xl:hidden">
                {[...shown, ...(pager.to === filtered.length && !q ? [other] : [])].map((r) => {
                    const isOther = r === other;
                    return (
                        <li key={r.name}>
                            <button type="button" disabled={isOther} onClick={() => onOpen(r.name)} className="w-full px-3 py-2.5 text-left enabled:hover:bg-muted/40">
                                <span className={cn("flex items-center gap-1.5", isOther ? "text-sm italic text-muted-foreground" : "font-mono text-sm text-primary")}>
                                    {isOther ? t("tidy.hosts.other") : r.name}
                                    {r.telepy && <Chip tone="neutral">Telepy</Chip>}
                                </span>
                                <Destination row={r} />
                            </button>
                        </li>
                    );
                })}
            </ul>
            {filtered.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">{q ? t("tidy.hosts.noMatch") : t("tidy.hosts.none")}</p>}
            <Pagination pager={pager} />
        </div>
    );
}
