"use client";

/**
 * SSH gateway 日誌頁：結構化事件、隧道篩選（?tunnel=<id>，可從隧道列表深連結）、關鍵字搜尋、事件種類標籤。
 * SSH gateway logs page: structured events, tunnel filter (?tunnel=<id>, deep-linkable from the tunnel list),
 * keyword search and event-kind badges.
 */
import React, { Suspense } from "react";
import { Search, FileText, AlertCircle, RefreshCw, Filter, X, ShieldCheck } from "lucide-react";
import { AuditVerifyDialog } from "@/components/logs/AuditVerifyDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { ALL_TUNNELS, useLogsPage } from "@/hooks/useLogsPage";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "success" | "warning";

// 標籤依 gateway 的 `event` 欄位決定（不是比對訊息字串），所以可以翻譯。
// Badges key off the gateway's `event` field (not message text), so their labels are translatable.
const EVENT_BADGES: Record<string, { key: TranslationKey; variant: BadgeVariant }> = {
    listening: { key: "logs.event.listening", variant: "outline" },
    accepted: { key: "logs.event.accepted", variant: "default" },
    forward: { key: "logs.event.forward", variant: "default" },
    forward_released: { key: "logs.event.forward_released", variant: "secondary" },
    disconnect: { key: "logs.event.disconnect", variant: "secondary" },
    refused_forward: { key: "logs.event.refused_forward", variant: "destructive" },
    refused_direct: { key: "logs.event.refused_direct", variant: "destructive" },
    refused_proxy: { key: "logs.event.refused_proxy", variant: "destructive" },
    failed_publickey: { key: "logs.event.failed_publickey", variant: "destructive" },
    invalid_user: { key: "logs.event.invalid_user", variant: "destructive" },
    preauth_close: { key: "logs.event.preauth_close", variant: "outline" },
    degraded: { key: "logs.event.degraded", variant: "warning" },
    recovered: { key: "logs.event.recovered", variant: "success" },
    ip_changed: { key: "logs.event.ip_changed", variant: "warning" },
    expired_key: { key: "logs.event.expired_key", variant: "destructive" },
    terminal_open: { key: "logs.event.terminal_open", variant: "default" },
    lan_terminal: { key: "logs.event.lan_terminal", variant: "default" },
    terminal_close: { key: "logs.event.terminal_close", variant: "secondary" },
    files_open: { key: "logs.event.files_open", variant: "default" },
    files_close: { key: "logs.event.files_close", variant: "secondary" },
    browser_open: { key: "logs.event.browser_open", variant: "default" },
    browser_close: { key: "logs.event.browser_close", variant: "secondary" },
    step_up_required: { key: "logs.event.step_up_required", variant: "warning" },
    step_up_setting: { key: "logs.event.step_up_setting", variant: "outline" },
    desktop_open: { key: "logs.event.desktop_open", variant: "default" },
    desktop_close: { key: "logs.event.desktop_close", variant: "secondary" },
    access_request: { key: "logs.event.access_request", variant: "outline" },
    host_key_pinned: { key: "logs.event.host_key_pinned", variant: "outline" },
    host_key_mismatch: { key: "logs.event.host_key_mismatch", variant: "destructive" },
    host_key_accepted: { key: "logs.event.host_key_accepted", variant: "warning" },
    host_key_forgotten: { key: "logs.event.host_key_forgotten", variant: "secondary" },
};

function LogsPageInner() {
    const { t } = useI18n();
    const { state, actions } = useLogsPage();
    const { logs, filteredLogs, loading, search, setSearch, tunnels, tunnelFilter, selectedTunnel, isAdmin, verifyOpen, verifying, verifyReport } = state;
    const { fetchLogs, setTunnelFilter, runVerify, closeVerify } = actions;

    const eventBadge = (event: string) => {
        const known = EVENT_BADGES[event];
        return (
            <Badge variant={known?.variant ?? "outline"} className="text-[0.6875rem] leading-none py-0.5 whitespace-nowrap">
                {known ? t(known.key) : event}
            </Badge>
        );
    };

    return (
        <div className="flex flex-col h-[calc(100vh-8rem)] animate-fade-in-up">
            <PageHeader
                className="mb-6 shrink-0"
                icon={<FileText />}
                title={t("logs.title")}
                description={t("logs.subtitle")}
                actions={
                    <>
                        {isAdmin && (
                            <Button onClick={runVerify} variant="outline">
                                <ShieldCheck size={16} />
                                {t("logs.verify.button")}
                            </Button>
                        )}
                        <Button onClick={fetchLogs} variant="outline">
                            <RefreshCw size={16} />
                            {t("common.refresh")}
                        </Button>
                    </>
                }
            />
            {isAdmin && <AuditVerifyDialog isOpen={verifyOpen} onClose={closeVerify} onRerun={runVerify} loading={verifying} report={verifyReport} />}

            <Callout tone="info" className="mb-4 shrink-0">{t("logs.banner")}</Callout>

            <div className="mb-4 shrink-0 flex flex-col sm:flex-row gap-2">
                <div className="flex items-center gap-2 sm:w-72">
                    <Filter size={16} className="text-muted-foreground shrink-0" aria-hidden />
                    <Select value={tunnelFilter} onValueChange={setTunnelFilter}>
                        <SelectTrigger className="h-10 flex-1 text-sm" aria-label={t("logs.tunnelFilter")}>
                            <SelectValue placeholder={t("logs.tunnelFilter")} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL_TUNNELS}>{t("logs.allTunnels")}</SelectItem>
                            {tunnels.map((tunnel) => (
                                <SelectItem key={tunnel.id} value={String(tunnel.id)}>
                                    {tunnel.host_friendly_name} · {tunnel.reverse_port}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="relative flex-1">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search size={18} className="text-muted-foreground" />
                    </div>
                    <Input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t("logs.searchPlaceholder")}
                        className="pl-10"
                    />
                </div>
            </div>

            {selectedTunnel && (
                <div className="mb-4 shrink-0 flex items-center justify-between gap-2 text-sm text-muted-foreground">
                    <span>{t("logs.showingTunnel", { name: selectedTunnel.host_friendly_name, port: selectedTunnel.reverse_port })}</span>
                    <Button variant="ghost" size="sm" className="gap-1 h-7" onClick={() => setTunnelFilter(ALL_TUNNELS)}>
                        <X size={14} /> {t("logs.showAll")}
                    </Button>
                </div>
            )}

            <div className="flex-1 bg-card text-card-foreground border border-border rounded-lg shadow-sm overflow-hidden flex flex-col min-h-0">
                {loading ? (
                    <div className="flex-1 flex justify-center items-center">
                        <div className="flex flex-col items-center">
                            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                            <p className="text-muted-foreground font-medium">{t("logs.loading")}</p>
                        </div>
                    </div>
                ) : logs.length === 0 ? (
                    <div className="flex-1 flex justify-center items-center">
                        <div className="text-center">
                            <AlertCircle size={48} className="mx-auto text-muted mb-4 opacity-50" />
                            <p className="text-muted-foreground font-medium text-lg">{t("logs.empty")}</p>
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 overflow-auto bg-muted/10 font-mono text-sm">
                        <table className="min-w-full divide-y divide-border border-collapse">
                            <thead className="bg-muted/50 sticky top-0 border-b border-border shadow-sm z-10">
                                <tr>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider w-44 border-r border-border/50">{t("logs.thTime")}</th>
                                    <th scope="col" className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider w-36 border-r border-border/50">{t("logs.thEvent")}</th>
                                    <th scope="col" className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider">{t("logs.thMessage")}</th>
                                </tr>
                            </thead>
                            <tbody className="bg-card divide-y divide-border">
                                {filteredLogs.map((log) => (
                                    <tr key={log.id} className="hover:bg-muted/50 transition-colors group">
                                        <td className="px-6 py-2 whitespace-nowrap text-xs text-muted-foreground border-r border-border/50 group-hover:bg-muted/30">
                                            {log.time}
                                        </td>
                                        <td className="px-4 py-2 whitespace-nowrap text-xs border-r border-border/50 group-hover:bg-muted/30">
                                            {eventBadge(log.event)}
                                        </td>
                                        <td className="px-6 py-2 text-xs text-foreground break-words group-hover:bg-muted/30">
                                            <span className="leading-relaxed whitespace-pre-wrap break-all">{log.message}</span>
                                        </td>
                                    </tr>
                                ))}
                                {filteredLogs.length === 0 && (
                                    <tr>
                                        <td colSpan={3} className="px-6 py-8 text-center text-sm text-muted-foreground">
                                            {t("logs.noMatch")}
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

export default function LogsPage() {
    // useSearchParams 需要 Suspense 邊界，否則靜態產生會整頁退回 client render。
    // useSearchParams needs a Suspense boundary or static generation bails out for the whole page.
    return (
        <Suspense fallback={null}>
            <LogsPageInner />
        </Suspense>
    );
}
