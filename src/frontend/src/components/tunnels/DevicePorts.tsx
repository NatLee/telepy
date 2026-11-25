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
import React, { useRef, useState } from "react";
import Link from "next/link";
import { Cpu, Lock, MonitorPlay, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
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

/** 超過一頁才給搜尋框。/ The search box appears once the ports don't fit on one page. */
const SEARCH_FROM = 10;

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
    const all = data?.ports ?? [];
    const named = all.map((p) => ({ p, name: portName(p, serviceName) }));
    const nameOf = new Map(named.map(({ p, name }) => [p.port, name]));
    const totals = groupPorts(all);
    const found = groupPorts(named.filter(({ p, name }) => matchPort(p, query, name)).map(({ p }) => p));
    const group = shownGroup(found, chosen);
    const rows = found[group];
    const groups = PORT_GROUPS.filter((g) => totals[g].length > 0);
    const pager = usePagination(rows.length, { storageKey: "telepy.browserPortsPageSize", resetKey: `${group}|${query}` });
    const unnamed = !!data && !data.scanned && totals.maybe.length > 0;

    return (
        <section className={cn("@container rounded-lg border border-border bg-background/60", className)} aria-label={t(running ? "browser.ports.title" : "browser.ports.titleStart")}>
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
                        <NativeSelect value={group} onChange={(e) => setChosen(e.target.value as PortGroup)} aria-label={t("browser.ports.groups")} className="h-8 text-sm @lg:hidden">
                            {groups.map((g) => (
                                <option key={g} value={g}>
                                    {t(groupKey(g))} ({found[g].length})
                                </option>
                            ))}
                        </NativeSelect>
                        <div role="tablist" aria-label={t("browser.ports.groups")} aria-orientation="vertical" className="hidden w-44 shrink-0 flex-col gap-1 @lg:flex">
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

                        <div ref={listRef} role="tabpanel" aria-label={t(groupKey(group))} className="min-w-0 flex-1 space-y-2">
                            {all.length > SEARCH_FROM && (
                                <div className="relative">
                                    <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("browser.ports.search")} aria-label={t("browser.ports.search")} className="h-8 pl-8" />
                                </div>
                            )}

                            {rows.length === 0 ? (
                                <p className="px-1 py-2 text-sm text-muted-foreground">{t("browser.ports.noMatch", { query: query.trim() })}</p>
                            ) : (
                                <ul data-refresh-list className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
                                    {pageSlice(rows, pager.page, pager.size).map((p) => {
                                        const name = nameOf.get(p.port) ?? null;
                                        const line = (
                                            <>
                                                <span className="w-[4.5rem] shrink-0 font-mono text-sm text-foreground">:{p.port}</span>
                                                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                                                    <span className="flex min-w-0 items-center gap-1.5">
                                                        {p.scheme === "https" && <Lock size={12} className="shrink-0 text-muted-foreground" aria-label="HTTPS" />}
                                                        {name ? (
                                                            <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{name}</span>
                                                        ) : p.url ? (
                                                            <span className="min-w-0 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.url.replace(/^https?:\/\//, "")}</span>
                                                        ) : null}
                                                    </span>
                                                    {p.loopback_only && <span className="text-xs text-muted-foreground">{t("browser.ports.loopback")}</span>}
                                                </span>
                                            </>
                                        );
                                        return (
                                            <li key={p.port}>
                                                {p.url ? (
                                                    <button
                                                        type="button"
                                                        onClick={() => p.url && onOpen(p.url)}
                                                        title={t("browser.ports.open", { url: p.url })}
                                                        className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
                                                    >
                                                        {line}
                                                    </button>
                                                ) : (
                                                    <div className="flex items-baseline gap-2 px-3 py-1.5">{line}</div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}

                            <Pagination pager={pager} anchor={listRef} />

                            {group === "no" && rows.length > 0 && <p className="px-1 text-xs text-muted-foreground">{t("browser.ports.otherHint")}</p>}
                            {unnamed && group === "maybe" && (
                                <p className="px-1 text-xs text-muted-foreground">
                                    {t("browser.ports.scanHint")}{" "}
                                    {has("network") && (
                                        <Link href={`/tunnels/network?tunnel=${serverId}`} className="underline underline-offset-2 hover:text-foreground">
                                            {t("browser.ports.scanLink")}
                                        </Link>
                                    )}
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </section>
    );
}
