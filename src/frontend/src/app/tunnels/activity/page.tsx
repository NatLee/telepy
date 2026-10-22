"use client";

/**
 * AI 活動頁：開著的 AI（MCP）SSH session 與工具呼叫紀錄。所有使用者都看得到（自己的＋自己隧道上的），
 * 管理員看全部並可篩選。/ AI activity: live AI SSH sessions and the tool-call audit log.
 */
import React, { useState } from "react";
import { Bot, RefreshCw, Info, Filter, X, Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { ALL, useAiActivityPage, type AiSession } from "@/hooks/useAiActivityPage";

const TOOL_LABELS: Record<string, TranslationKey> = {
    list_tunnels: "activity.tool.list_tunnels",
    tunnel_status: "activity.tool.tunnel_status",
    ssh_session_open: "activity.tool.ssh_session_open",
    ssh_exec: "activity.tool.ssh_exec",
    ssh_session_close: "activity.tool.ssh_session_close",
    sftp_list: "activity.tool.sftp_list",
    sftp_read: "activity.tool.sftp_read",
    sftp_write: "activity.tool.sftp_write",
};

const REASON_LABELS: Record<string, TranslationKey> = {
    idle: "activity.reason.idle",
    max_lifetime: "activity.reason.max_lifetime",
    device_offline: "activity.reason.device_offline",
    disconnected: "activity.reason.disconnected",
    revoked: "activity.reason.revoked",
    permission_removed: "activity.reason.permission_removed",
    closed_by_user: "activity.reason.closed_by_user",
    closed_by_agent: "activity.reason.closed_by_agent",
};

/** 關閉列的 detail 是 `reason: <r>; commands: N`，把 reason 換成翻譯。/ Translate the reason in close rows. */
function describeDetail(tool: string, detail: string | null, t: (k: TranslationKey, v?: Record<string, string | number>) => string): string {
    if (!detail) return "";
    if (tool === "ssh_session_close") {
        const m = detail.match(/^reason:\s*([a-z_]+);\s*commands:\s*(\d+)/);
        if (m) {
            const key = REASON_LABELS[m[1]];
            return t("activity.closeDetail", { reason: key ? t(key) : m[1], count: Number(m[2]) });
        }
    }
    return detail;
}

function formatBytes(n: number | null): string {
    if (n === null || n === undefined) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function AiActivityPage() {
    const { t } = useI18n();
    const { state, actions } = useAiActivityPage();
    const { sessions, rows, loading, isAdmin, me, tunnelFilter, userFilter, tunnels, users } = state;
    const { refresh, closeSession, setTunnelFilter, setUserFilter, formatTime } = actions;
    const [pending, setPending] = useState<AiSession | null>(null);

    return (
        <div className="flex flex-col min-h-[calc(100vh-8rem)] animate-fade-in-up">
            <div className="mb-6 shrink-0 sm:flex sm:items-center sm:justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
                        <Bot className="text-primary animate-float" />
                        {t("activity.title")}
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">{t("activity.subtitle")}</p>
                </div>
                <div className="mt-4 sm:mt-0 flex gap-2">
                    <Button onClick={refresh} variant="outline" className="gap-2">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                </div>
            </div>

            <div className="mb-4 shrink-0 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg p-4 flex items-start gap-3 text-sm text-blue-800 dark:text-blue-200">
                <Info size={18} className="mt-0.5 shrink-0" />
                <span>{isAdmin ? t("activity.bannerAdmin") : t("activity.banner")}</span>
            </div>

            {/* 開著的 session / Live sessions */}
            <section className="mb-6 shrink-0">
                <h2 className="text-sm font-semibold flex items-center gap-2 mb-2">
                    <Activity size={15} className="text-primary" />
                    {t("activity.sessionsTitle")}
                    <Badge variant="secondary" className="text-[10px] leading-none py-0.5">{sessions.length}</Badge>
                </h2>
                {sessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border px-4 py-3">{t("activity.sessionsEmpty")}</p>
                ) : (
                    <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {sessions.map((s) => (
                            <li key={s.id} className="rounded-lg border border-border bg-card p-4 text-sm flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <p className="font-semibold truncate">{s.client_name}</p>
                                        <p className="text-xs text-muted-foreground truncate">
                                            {s.tunnel.name} · {s.username}
                                            {s.user.username !== me && ` · ${t("activity.sessionBy", { user: s.user.username })}`}
                                        </p>
                                    </div>
                                    {s.busy ? (
                                        <Badge variant="default" className="text-[10px] leading-none py-0.5 gap-1 whitespace-nowrap"><Loader2 size={10} className="animate-spin" /> {t("activity.sessionBusy")}</Badge>
                                    ) : (
                                        <Badge variant="outline" className="text-[10px] leading-none py-0.5 whitespace-nowrap">{t("activity.sessionIdle")}</Badge>
                                    )}
                                </div>
                                <p className="text-xs text-muted-foreground">
                                    {t("activity.sessionCommands", { count: s.commands })} · {t("activity.sessionLastUsed", { time: formatTime(s.last_used_at) })}
                                </p>
                                <p className="text-xs text-muted-foreground">{t("activity.sessionExpires", { time: formatTime(s.expires_at) })}</p>
                                <div className="flex justify-end">
                                    <Button size="sm" variant="outline" className="h-7 gap-1 text-destructive hover:text-destructive" onClick={() => setPending(s)}>
                                        <X size={13} /> {t("activity.sessionClose")}
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* 紀錄 / Audit log */}
            <section className="flex-1 flex flex-col min-h-0">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
                    <h2 className="text-sm font-semibold flex items-center gap-2 flex-1">
                        <Filter size={15} className="text-primary" />
                        {t("activity.logTitle")}
                    </h2>
                    <Select value={tunnelFilter} onValueChange={setTunnelFilter}>
                        <SelectTrigger className="h-9 sm:w-56 text-sm" aria-label={t("activity.filterTunnel")}>
                            <SelectValue placeholder={t("activity.filterTunnel")} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={ALL}>{t("activity.allTunnels")}</SelectItem>
                            {tunnels.map((x) => (
                                <SelectItem key={x.id} value={String(x.id)}>{x.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    {isAdmin && (
                        <Select value={userFilter} onValueChange={setUserFilter}>
                            <SelectTrigger className="h-9 sm:w-48 text-sm" aria-label={t("activity.filterUser")}>
                                <SelectValue placeholder={t("activity.filterUser")} />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={ALL}>{t("activity.allUsers")}</SelectItem>
                                {users.map((x) => (
                                    <SelectItem key={x.id} value={String(x.id)}>{x.label}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>

                <div className="flex-1 bg-card text-card-foreground border border-border rounded-lg shadow-sm overflow-hidden flex flex-col min-h-[16rem]">
                    {loading ? (
                        <div className="flex-1 flex justify-center items-center py-12">
                            <div className="flex flex-col items-center">
                                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mb-4"></div>
                                <p className="text-muted-foreground font-medium">{t("activity.loading")}</p>
                            </div>
                        </div>
                    ) : rows.length === 0 ? (
                        <div className="flex-1 flex justify-center items-center py-12">
                            <p className="text-muted-foreground font-medium">{t("activity.empty")}</p>
                        </div>
                    ) : (
                        <div className="flex-1 overflow-auto bg-muted/10 text-sm">
                            <table className="min-w-full divide-y divide-border border-collapse">
                                <thead className="bg-muted/50 sticky top-0 border-b border-border shadow-sm z-10">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider whitespace-nowrap">{t("activity.thTime")}</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider whitespace-nowrap">{t("activity.thUser")}</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider whitespace-nowrap">{t("activity.thTool")}</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider whitespace-nowrap">{t("activity.thTarget")}</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider">{t("activity.thDetail")}</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground tracking-wider whitespace-nowrap">{t("activity.thResult")}</th>
                                    </tr>
                                </thead>
                                <tbody className="bg-card divide-y divide-border">
                                    {rows.map((r) => {
                                        const toolKey = TOOL_LABELS[r.tool];
                                        return (
                                            <tr key={r.id} className="hover:bg-muted/50 transition-colors align-top">
                                                <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">{formatTime(r.at)}</td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs">
                                                    <span className="font-medium">{r.user.username ?? "—"}</span>
                                                    {r.client_name && <span className="block text-muted-foreground truncate max-w-[10rem]">{r.client_name}</span>}
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs">
                                                    <Badge variant={r.tool === "ssh_exec" || r.tool === "sftp_write" ? "default" : "outline"} className="text-[10px] leading-none py-0.5">
                                                        {toolKey ? t(toolKey) : r.tool}
                                                    </Badge>
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">
                                                    {r.tunnel ? (r.tunnel.name ?? `#${r.tunnel.id}`) : "—"}
                                                    {r.target_username && <span className="block">{r.target_username}</span>}
                                                </td>
                                                <td className="px-4 py-2 text-xs font-mono break-all max-w-md">
                                                    {describeDetail(r.tool, r.detail, t)}
                                                    {r.error && <span className="block text-destructive font-sans mt-0.5">{r.error}</span>}
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs">
                                                    <Badge variant={r.ok ? "secondary" : "destructive"} className="text-[10px] leading-none py-0.5">
                                                        {r.ok ? t("activity.resultOk") : t("activity.resultFailed")}
                                                    </Badge>
                                                    <span className="block text-muted-foreground mt-0.5">
                                                        {r.exit_code !== null && r.exit_code !== undefined && `${t("activity.exitCode", { code: r.exit_code })} · `}
                                                        {r.duration_ms !== null && r.duration_ms !== undefined && `${r.duration_ms} ms`}
                                                        {r.bytes_out ? ` · ${formatBytes(r.bytes_out)}` : ""}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </section>

            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => {
                    if (pending) closeSession(pending);
                    setPending(null);
                }}
                title={t("activity.sessionClose")}
                message={t("activity.sessionCloseConfirm", { app: pending?.client_name ?? "", tunnel: pending?.tunnel.name ?? "" })}
                confirmText={t("activity.sessionClose")}
                isDestructive
            />
        </div>
    );
}
