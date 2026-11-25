"use client";

/**
 * 遠端瀏覽器面板的「這台裝置上」：裝置現在在聽的 port。左邊一欄是種類（網頁 / 通常是 / 可能是 / 不是網頁，各帶數量；
 * 窄的時候變成上面一列），右邊是那一類的精簡列表，一個 port 一行、點了就開（還沒開瀏覽器 = 用它開始，開著 = 新分頁）；
 * 搜尋先對全部做、再分頁，所以 port 再多高度也固定。上面一條小路徑說明為什麼網址是 localhost：瀏覽器 ─SSH─ 裝置。
 * 開始畫面上它是「從這台裝置上的網頁開始」（和「直接開始」二選一）。
 * The remote browser panel's "On this device" (on the start screen: "Start from a page on this device", the other way
 * to start besides "Start right away"): the ports the device listens on right now. A left rail of kinds (web
 * pages / usually / maybe / not web pages, each with a count; a row on top when narrow) and a compact list of that kind,
 * one port per line that opens on a click (a stopped browser starts on it, a running one opens a new tab). Search runs
 * over everything, then the list pages, so the height stays put however many ports there are. A small path on top shows
 * why the address is localhost: this browser ─SSH─ localhost on the device.
 */
import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Cpu, Info, Lock, MonitorPlay, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination } from "@/components/ui/pagination";
import { RefreshButton } from "@/components/ui/refresh-button";
import { useFeatures } from "@/hooks/useFeatures";
import { usePagination } from "@/hooks/usePagination";
import { emptyKey, groupKey, groupPorts, matchPort, portName, PORT_GROUPS, shownGroup, type DevicePortsData, type PortGroup } from "@/lib/devicePorts";
import { serviceName } from "@/lib/lanConnect";
import { useI18n } from "@/lib/i18n";
import { pageSlice } from "@/lib/pagination";
import { cn } from "@/lib/utils";

/** port 夠多才給搜尋框。/ The search box appears once there are this many ports. */
const SEARCH_FROM = 10;
/**
 * 清單固定 4 列高：寬的時候兩欄（一頁 8 格）、窄的時候一欄（4 格）。不足的位置留空，所以切換分類、翻到最後一頁高度都不變。
 * 「寬」= 元件至少 32rem（和 `@lg` 容器查詢同一條線）。
 * The list is always 4 rows tall: two columns when wide (8 per page), one when narrow (4). Missing cells stay empty, so
 * switching kinds or reaching the last page never changes the height. "Wide" = the component is at least 32rem (the
 * same line as the `@lg` container query).
 */
const ROWS = 4;
const CELL = "3rem";
const GRID_HEIGHT = `calc(${ROWS} * ${CELL} + ${ROWS - 1} * 0.375rem)`;
const WIDE_REM = 32;

/** 元件夠不夠寬放兩欄（以 rem 算，跟著顯示比例）。/ Whether the component fits two columns (in rem, so it follows the display scale). */
function useWide(ref: React.RefObject<HTMLElement | null>): boolean {
    const [wide, setWide] = useState(true);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const check = () => {
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            setWide(el.clientWidth >= WIDE_REM * rem);
        };
        check();
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return wide;
}

export interface DevicePortsProps {
    serverId: number | string;
    username: string;
    data: DevicePortsData | null;
    loading: boolean;
    error: string | null;
    onRefresh: () => Promise<boolean>;
    onOpen: (url: string) => void;
    /** 瀏覽器已經開著：點了是開新分頁。/ The browser is running: a click opens a new tab. */
    running?: boolean;
    className?: string;
}

export function DevicePorts({ serverId, username, data, loading, error, onRefresh, onOpen, running = false, className }: DevicePortsProps) {
    const { t } = useI18n();
    const { has } = useFeatures();
    const [query, setQuery] = useState("");
    const [chosen, setChosen] = useState<PortGroup | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const sectionRef = useRef<HTMLElement>(null);
    const wide = useWide(sectionRef);
    const perPage = wide ? ROWS * 2 : ROWS;
    const all = data?.ports ?? [];
    const named = all.map((p) => ({ p, name: portName(p, serviceName) }));
    const nameOf = new Map(named.map(({ p, name }) => [p.port, name]));
    const totals = groupPorts(all);
    const found = groupPorts(named.filter(({ p, name }) => matchPort(p, query, name)).map(({ p }) => p));
    const group = shownGroup(found, chosen);
    const rows = found[group];
    const groups = PORT_GROUPS.filter((g) => totals[g].length > 0);
    const pager = usePagination(rows.length, { storageKey: "telepy.browserPortsPageSize", resetKey: `${group}|${query}|${perPage}`, sizes: [perPage] });
    const unnamed = !!data && !data.scanned && totals.maybe.length > 0;
    // 這一類的一句說明：不是網頁 = 瀏覽器打不開；可能是網頁 + 沒掃過 = 名稱要靠網路掃描。
    // The kind's one-line hint: not web pages = the browser can't open them; maybe + never scanned = names need a scan.
    const hint: React.ReactNode =
        group === "no" ? t("browser.ports.otherHint")
        : unnamed && group === "maybe" ? (
            <>
                {t("browser.ports.scanHint")}{" "}
                {has("network") && (
                    <Link href={`/tunnels/network?tunnel=${serverId}`} className="underline underline-offset-2 hover:text-foreground">
                        {t("browser.ports.scanLink")}
                    </Link>
                )}
            </>
        ) : null;

    return (
        <section ref={sectionRef} className={cn("@container rounded-lg border border-border bg-background/60", className)} aria-label={t(running ? "browser.ports.title" : "browser.ports.titleStart")}>
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                <h4 className="min-w-0 flex-1 text-sm font-medium text-foreground">{t(running ? "browser.ports.title" : "browser.ports.titleStart")}</h4>
                <RefreshButton onRefresh={onRefresh} busy={loading} failed={!!error} variant="ghost" size="icon" className="h-7 w-7" iconSize={14} aria-label={t("browser.ports.refresh")} title={t("browser.ports.refresh")} />
            </header>

            {/* 為什麼是 localhost：瀏覽器 ─SSH─ 裝置。開始畫面上面的步驟已經畫了這條路，只在執行中的 popover 畫。
                Why localhost: this browser ─SSH─ the device. The start screen's steps already show that path, so only the running popover draws it. */}
            {running && <div className="flex items-center gap-2 px-3 pt-3 text-xs text-muted-foreground" aria-hidden="true">
                <span className="flex shrink-0 items-center gap-1.5 text-foreground">
                    <MonitorPlay size={14} className="text-muted-foreground" />
                    {t("browser.ports.pathBrowser")}
                </span>
                <span className="flex min-w-6 flex-1 items-center gap-2">
                    <span className="h-px flex-1 bg-border" />
                    <span className="hidden shrink-0 @sm:inline">{t("browser.ports.pathVia", { username })}</span>
                    <span className="hidden h-px flex-1 bg-border @sm:block" />
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-foreground">
                    <Cpu size={14} className="text-muted-foreground" />
                    {t("browser.ports.pathDevice")}
                </span>
            </div>}
            <p className="px-3 pt-2 text-xs text-muted-foreground">{t(running ? "browser.ports.introTab" : "browser.ports.intro")}</p>

            <div className="p-3">
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                {!error && !data && <p role="status" className="text-sm text-muted-foreground">{t("browser.ports.loading")}</p>}
                {!error && data && all.length === 0 && <p className="text-sm text-muted-foreground">{t(emptyKey(data))}</p>}

                {!error && all.length > 0 && (
                    <div className="flex flex-col gap-3 @lg:flex-row @lg:items-start">
                        {/* 種類：窄的時候是一行下拉選單（四個按鈕會各佔一行），寬的時候是左邊一欄。
                            Kinds: a one-line select when narrow (four buttons would take a line each), a left column when wide. */}
                        <div className="flex items-center gap-2 @lg:hidden">
                        <NativeSelect value={group} onChange={(e) => setChosen(e.target.value as PortGroup)} aria-label={t("browser.ports.groups")} className="h-8 min-w-0 flex-1 text-sm">
                            {groups.map((g) => (
                                <option key={g} value={g}>
                                    {t(groupKey(g))} ({found[g].length})
                                </option>
                            ))}
                        </NativeSelect>
                            {/* 窄的時候說明收在 ⓘ 後面，清單高度才不會跟著分類變。/ When narrow the hint sits behind ⓘ, so the list's height never depends on the kind. */}
                            {hint && (
                                <Popover>
                                    <PopoverTrigger asChild>
                                        <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label={t("browser.ports.hintButton")} title={t("browser.ports.hintButton")}>
                                            <Info size={14} />
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] p-3 text-xs text-muted-foreground">{hint}</PopoverContent>
                                </Popover>
                            )}
                        </div>
                        <div className="hidden w-44 shrink-0 flex-col gap-3 @lg:flex">
                        <div role="tablist" aria-label={t("browser.ports.groups")} aria-orientation="vertical" className="flex flex-col gap-1">
                            {groups.map((g) => {
                                const active = g === group;
                                const count = found[g].length;
                                return (
                                    <button
                                        key={g}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        onClick={() => setChosen(g)}
                                        className={cn(
                                            "flex items-baseline gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                                            active ? "bg-card text-foreground ring-1 ring-border dark:bg-secondary" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                                            count === 0 && !active && "opacity-50",
                                        )}
                                    >
                                        <span className="min-w-0 flex-1">{t(groupKey(g))}</span>
                                        <span className={cn("shrink-0 font-mono text-xs tabular-nums", active ? "text-primary" : "text-muted-foreground", g === "seen" && !active && "text-success")}>{count}</span>
                                    </button>
                                );
                            })}
                        </div>
                        {/* 寬的時候說明放在分類下面的空位，清單那邊的高度就不會跟著分類變。/ When wide the hint sits under the kinds, so the list's height never depends on the kind. */}
                        {hint && <div className="px-1 text-xs text-muted-foreground">{hint}</div>}
                        </div>

                        <div ref={listRef} role="tabpanel" aria-label={t(groupKey(group))} className="flex min-w-0 flex-1 flex-col gap-2">
                            {all.length > SEARCH_FROM && (
                                <div className="relative">
                                    <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("browser.ports.search")} aria-label={t("browser.ports.search")} className="h-8 pl-8" />
                                </div>
                            )}

                            {/* 固定 4 列高的格子；不足的位置留空。/ A grid that is always 4 rows tall; missing cells stay empty. */}
                            {rows.length === 0 ? (
                                <p className="grid place-items-center px-1 text-sm text-muted-foreground" style={{ height: GRID_HEIGHT }}>{t("browser.ports.noMatch", { query: query.trim() })}</p>
                            ) : (
                                <ul data-refresh-list className="grid grid-cols-1 gap-1.5 @lg:grid-cols-2" style={{ gridTemplateRows: `repeat(${ROWS}, ${CELL})`, height: GRID_HEIGHT }}>
                                    {pageSlice(rows, pager.page, pager.size).map((p) => {
                                        const name = nameOf.get(p.port) ?? null;
                                        const second = name ?? (p.url ? p.url.replace(/^https?:\/\//, "") : null);
                                        const cell = (
                                            <>
                                                <span className="flex w-full items-center gap-1.5">
                                                    <span className="font-mono text-sm text-foreground">:{p.port}</span>
                                                    {p.scheme === "https" && <Lock size={12} className="shrink-0 text-muted-foreground" aria-label="HTTPS" />}
                                                    {p.loopback_only && (
                                                        <span className="ml-auto shrink-0 text-xs text-muted-foreground" title={t("browser.ports.loopback")}>{t("browser.ports.loopbackShort")}</span>
                                                    )}
                                                </span>
                                                {/* 名稱只佔一行（格子高度固定），完整的在滑過提示。/ One line for the name (fixed cell height); the full name is in the tooltip. */}
                                                {second && <span className={cn("block w-full truncate", name ? "text-sm text-foreground" : "font-mono text-xs text-muted-foreground")}>{second}</span>}
                                            </>
                                        );
                                        const box = "flex h-full w-full min-w-0 flex-col justify-center rounded-md border border-border bg-card px-2.5 text-left";
                                        return (
                                            <li key={p.port} className="min-w-0">
                                                {p.url ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => p.url && onOpen(p.url)}
                                                        title={[name, t("browser.ports.open", { url: p.url }), p.loopback_only ? t("browser.ports.loopback") : null].filter(Boolean).join("\n")}
                                                        className={cn(box, "transition-colors hover:border-primary/60 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
                                                    >
                                                        {cell}
                                                    </button>
                                                ) : (
                                                    <div className={box} title={[name, p.loopback_only ? t("browser.ports.loopback") : null].filter(Boolean).join("\n") || undefined}>{cell}</div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}

                            {/* 分頁列永遠佔一行，沒有第二頁時也一樣。/ The pager row always takes its line, even with a single page. */}
                            <div className="flex h-7 items-center justify-end">
                                <Pagination pager={pager} anchor={listRef} compact />
                            </div>

                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
