"use client";

/**
 * AI 活動頁：開著的 AI（MCP）SSH session 與工具呼叫紀錄。所有使用者都看得到（自己的＋自己隧道上的），
 * 管理員看全部並可篩選。/ AI activity: live AI SSH sessions and the tool-call audit log.
 */
import React, { useState } from "react";
import { Bot, RefreshCw, Filter, X, Activity, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useI18n } from "@/lib/i18n";
import { describeDetail, toolLabel } from "@/lib/aiAccess";
import { ALL, useAiActivityPage, type AiSession } from "@/hooks/useAiActivityPage";
import { ConnectedAppDialog } from "@/components/layout/ConnectedAppDialog";

function formatBytes(n: number | null): string {
    if (n === null || n === undefined) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function AiActivityPage() {
    const { t } = useI18n();
    const { state, actions } = useAiActivityPage();
    const { sessions, rows, loading, isAdmin, me, meId, tunnelFilter, userFilter, tunnels, users } = state;
    const { refresh, closeSession, setTunnelFilter, setUserFilter, formatTime } = actions;
    const [pending, setPending] = useState<AiSession | null>(null);
    const [appId, setAppId] = useState<number | null>(null);
    // app 的詳細資料只給授權的本人與管理員（隧道擁有者看得到 session，但不是他的授權）。
    // App details are for the person who authorized it and admins; tunnel owners see sessions, not the grant.
    const canOpenApp = (userId: number | null, grantId: number | null | undefined): grantId is number =>
        grantId !== null && grantId !== undefined && (isAdmin || (userId !== null && userId === meId));

    return (
        <div className="flex flex-col min-h-[calc(100vh-8rem)] animate-fade-in-up">
            <PageHeader
                className="mb-6 shrink-0"
                icon={<Bot />}
                title={t("activity.title")}
                description={t("activity.subtitle")}
                actions={
                    <Button onClick={refresh} variant="outline">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            <Callout tone="info" className="mb-4 shrink-0">{isAdmin ? t("activity.bannerAdmin") : t("activity.banner")}</Callout>

            {/* 開著的 session / Live sessions */}
            <section className="mb-6 shrink-0">
                <h2 className="text-sm font-semibold flex items-center gap-2 mb-2">
                    <Activity size={15} className="text-primary" />
                    {t("activity.sessionsTitle")}
                    <Badge variant="secondary" className="text-[0.6875rem] leading-none py-0.5">{sessions.length}</Badge>
                </h2>
                {sessions.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border px-4 py-3">{t("activity.sessionsEmpty")}</p>
                ) : (
                    <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {sessions.map((s) => (
                            <li key={s.id} className="rounded-lg border border-border bg-card p-4 text-sm flex flex-col gap-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        {canOpenApp(s.user.id, s.grant_id) ? (
                                            <button type="button" onClick={() => setAppId(s.grant_id)} className="block max-w-full truncate text-left text-foreground underline decoration-dotted decoration-foreground/40 underline-offset-4 hover:text-primary hover:decoration-solid" title={t("apps.openDetails", { name: s.client_name })}>
                                                {s.client_name}
                                            </button>
                                        ) : (
                                            <p className="truncate">{s.client_name}</p>
                                        )}
                                        <p className="text-xs text-muted-foreground truncate">
                                            {s.tunnel.name} · {s.username}
                                            {s.user.username !== me && ` · ${t("activity.sessionBy", { user: s.user.username })}`}
                                        </p>
                                    </div>
                                    {s.busy ? (
                                        <Badge variant="default" className="text-[0.6875rem] leading-none py-0.5 gap-1 whitespace-nowrap"><Loader2 size={10} className="animate-spin" /> {t("activity.sessionBusy")}</Badge>
                                    ) : (
                                        <Badge variant="outline" className="text-[0.6875rem] leading-none py-0.5 whitespace-nowrap">{t("activity.sessionIdle")}</Badge>
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
                                        return (
                                            <tr key={r.id} className="hover:bg-muted/50 transition-colors align-top">
                                                <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">{formatTime(r.at)}</td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs">
                                                    <span className="font-medium">{r.user.username ?? "—"}</span>
                                                    {r.client_name && (canOpenApp(r.user.id, r.grant_id) ? (
                                                        <button type="button" onClick={() => setAppId(r.grant_id as number)} className="block max-w-[10rem] truncate text-left text-muted-foreground underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 hover:text-primary hover:decoration-solid" title={t("apps.openDetails", { name: r.client_name })}>
                                                            {r.client_name}
                                                        </button>
                                                    ) : (
                                                        <span className="block text-muted-foreground truncate max-w-[10rem]">{r.client_name}</span>
                                                    ))}
                                                    {r.ip && <span className="block font-mono text-[0.75rem] text-muted-foreground" title={t("activity.ipTitle")}>{r.ip}</span>}
                                                </td>
                                                <td className="px-4 py-2 whitespace-nowrap text-xs">
                                                    <Badge variant={r.tool === "ssh_exec" || r.tool === "sftp_write" ? "default" : "outline"} className="text-[0.6875rem] leading-none py-0.5">
                                                        {toolLabel(r.tool, t)}
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
                                                    <Badge variant={r.ok ? "secondary" : "destructive"} className="text-[0.6875rem] leading-none py-0.5">
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

            <ConnectedAppDialog grantId={appId} onClose={() => setAppId(null)} onRevoked={refresh} />
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
