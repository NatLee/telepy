"use client";

/**
 * 已連接應用程式的詳細資料:它能做什麼(scope 與工具)、碰得到哪些隧道、開著的 session、
 * 用了多少次與最近的工具呼叫,以及它會導回哪個網域(註冊是公開的,名稱誰都能取)。
 * Connected app details: what it may do (scopes and tools), which tunnels, open sessions, usage and the
 * latest tool calls, and where it sends you back to (registration is open, so the name proves nothing).
 */
import React, { useState } from "react";
import Link from "next/link";
import { Activity, Bot, ExternalLink, Info, KeyRound, Loader2, Server, Trash2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { NavTabLabel, NavTabs } from "@/components/ui/nav-tabs";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { SCOPES, describeDetail, toolLabel } from "@/lib/aiAccess";
import { cn } from "@/lib/utils";
import { useConnectedApp } from "@/hooks/useConnectedApp";

interface ConnectedAppDialogProps {
    /** null = 關閉。/ null = closed. */
    grantId: number | null;
    onClose: () => void;
    onRevoked?: (id: number, name: string) => void;
}

type AppTab = "access" | "sessions" | "activity" | "about";

export function ConnectedAppDialog({ grantId, onClose, onRevoked }: ConnectedAppDialogProps) {
    const { t, tn, locale } = useI18n();
    const { user } = useAuth();
    const { detail: d, loading, failed, revoking, closeSession, revoke } = useConnectedApp(grantId, onRevoked);
    const [confirmRevoke, setConfirmRevoke] = useState(false);

    // 完整日期給「關於」清單;緊湊格式給數字列與紀錄列(窄欄放得下)。/ Full dates for the property list, compact ones for tight rows.
    const format = (iso: string | null | undefined, opts: Intl.DateTimeFormatOptions) => {
        if (!iso) return t("prefs.appNever");
        const date = new Date(iso);
        return isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(locale, opts).format(date);
    };
    const fmt = (iso: string | null | undefined) => format(iso, { dateStyle: "medium", timeStyle: "short" });
    const fmtShort = (iso: string | null | undefined) => format(iso, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const code = (text: string) => <code className="rounded-sm bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">{text}</code>;

    const granted = d ? SCOPES.filter((s) => d.scopes.includes(s.scope)) : [];
    const unknownScopes = d ? d.scopes.filter((s) => !SCOPES.some((x) => x.scope === s)) : [];
    const someoneElse = d && user && d.user.id !== user.id;
    // 左側分頁：能做什麼 + 碰得到的隧道 / 開著的 session（有才有）/ 最近的呼叫 / 授權資料。一眼看到的數字放在固定的工具列。
    // Side tabs: what it can do + tunnels / open sessions (when any) / recent calls / about. The numbers sit in the toolbar.
    const [picked, setTab] = useState<AppTab>("access");
    const sessionCount = d?.sessions.length ?? 0;
    const tabs = [
        { value: "access" as const, icon: <KeyRound />, label: t("apps.tab.access"), hint: t("apps.tab.accessHint") },
        ...(sessionCount > 0 ? [{ value: "sessions" as const, icon: <Activity />, label: <NavTabLabel label={t("apps.tab.sessions", { count: sessionCount })} mark={null} /> }] : []),
        { value: "activity" as const, icon: <Activity />, label: t("apps.recentActivity") },
        { value: "about" as const, icon: <Info />, label: t("apps.about") },
    ];
    const tab: AppTab = tabs.some((x) => x.value === picked) ? picked : "access";
    const glance = d ? (
                    <dl className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-surface">
                        {[
                            { label: t("apps.lastUsed"), value: fmtShort(d.last_used_at) },
                            { label: t("apps.calls"), value: String(d.stats.calls), sub: d.stats.failed > 0 ? t("apps.callsFailed", { count: d.stats.failed }) : null },
                            { label: t("apps.openSessions"), value: String(d.sessions.length) },
                        ].map((s) => (
                            <div key={s.label} className="min-w-0 px-3 py-2.5">
                                <dt className="text-xs text-muted-foreground [overflow-wrap:anywhere] sm:truncate">{s.label}</dt>
                                <dd className="mt-0.5 text-sm text-foreground [overflow-wrap:anywhere] sm:truncate">
                                    {s.value}
                                    {s.sub && <span className="ml-1.5 text-xs text-destructive">{s.sub}</span>}
                                </dd>
                            </div>
                        ))}
                    </dl>
    ) : undefined;

    return (
        <Modal
            isOpen={grantId !== null}
            onClose={onClose}
            title={d?.client_name ?? t("apps.detailsTitle")}
            description={
                d && d.client.redirect_hosts.length > 0
                    ? tn("apps.redirectsTo", { host: code(d.client.redirect_hosts.join(", ")) })
                    : undefined
            }
            icon={<Bot />}
            size="4xl"
            fixedHeight
            isLoading={loading}
            toolbar={glance}
            nav={d ? <NavTabs aria-label={t("apps.tab.aria")} tabs={tabs} value={tab} onChange={setTab} /> : undefined}
            footer={
                <>
                    {d && (
                        <Button type="button" variant="outline" className="mr-auto text-destructive hover:text-destructive" onClick={() => setConfirmRevoke(true)} disabled={revoking}>
                            {revoking ? <Loader2 className="animate-spin" /> : <Trash2 />}
                            {t("apps.revoke")}
                        </Button>
                    )}
                    <Button type="button" variant="outline" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                </>
            }
        >
            {failed && <Callout tone="danger">{t("apps.loadFailed")}</Callout>}
            {!d && !failed && <div className="min-h-40" aria-hidden />}
            {d && (
                <div className="space-y-6">

                    <div role="tabpanel" hidden={tab !== "access"} className="space-y-6">
                    {/* 能做什麼 / Permissions */}
                    <Section icon={<KeyRound />} title={t("apps.permissions")} description={someoneElse ? t("apps.permissionsHintOther", { user: d.user.username ?? `#${d.user.id}` }) : t("apps.permissionsHint")}>
                        <ul className="divide-y divide-border rounded-lg border border-border">
                            {granted.map((s) => (
                                <li key={s.scope} className="px-3.5 py-2.5 text-sm">
                                    <p className="text-foreground">{t(s.label)}</p>
                                    <p className="text-xs text-muted-foreground">{t(s.description)}</p>
                                    <div className="mt-1.5 flex flex-wrap gap-1">
                                        {s.tools.map((tool) => (
                                            <Chip key={tool} mono>{tool}</Chip>
                                        ))}
                                    </div>
                                </li>
                            ))}
                            {unknownScopes.map((s) => (
                                <li key={s} className="px-3.5 py-2.5 font-mono text-sm text-foreground">{s}</li>
                            ))}
                        </ul>
                    </Section>

                    {/* 碰得到的隧道 / Tunnels */}
                    <Section icon={<Server />} title={t("apps.tunnels")}>
                        {d.tunnels === null ? (
                            <p className="text-sm text-muted-foreground">{someoneElse ? t("apps.tunnelsAllOther", { user: d.user.username ?? `#${d.user.id}` }) : t("apps.tunnelsAll")}</p>
                        ) : d.tunnels.length === 0 ? (
                            <Callout tone="warning">{t("apps.tunnelsNone")}</Callout>
                        ) : (
                            <div className="flex flex-wrap gap-1.5">
                                {d.tunnels.map((tun) => (
                                    <Chip key={tun.id}>{tun.name}</Chip>
                                ))}
                            </div>
                        )}
                    </Section>

                    </div>

                    <div role="tabpanel" hidden={tab !== "sessions"} className="space-y-6">
                    {/* 開著的 session / Open sessions */}
                    {d.sessions.length > 0 && (
                        <Section icon={<Activity />} title={t("apps.sessionsTitle")}>
                            <ul className="divide-y divide-border rounded-lg border border-border">
                                {d.sessions.map((s) => (
                                    <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 text-sm">
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate text-foreground">
                                                {s.tunnel.name} · <span className="font-mono">{s.username}</span>
                                            </span>
                                            <span className="block truncate text-xs text-muted-foreground">
                                                {t("activity.sessionCommands", { count: s.commands })} · {t("activity.sessionLastUsed", { time: fmtShort(s.last_used_at) })}
                                            </span>
                                        </span>
                                        <Button type="button" size="xs" variant="outline" className="text-destructive hover:text-destructive" onClick={() => closeSession(s)}>
                                            <X /> {t("activity.sessionClose")}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        </Section>
                    )}

                    </div>

                    <div role="tabpanel" hidden={tab !== "activity"} className="space-y-6">
                    {/* 最近的工具呼叫 / Recent activity */}
                    <Section
                        icon={<Activity />}
                        title={t("apps.recentActivity")}
                        action={
                            <Link href={someoneElse ? `/tunnels/admin/activity?app=${d.id}` : `/tunnels/activity?app=${d.id}`} prefetch={false} onClick={onClose} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                                {t("apps.allActivity")}
                            </Link>
                        }
                    >
                        {d.activity.length === 0 ? (
                            <p className="text-sm text-muted-foreground">{t("apps.noActivity")}</p>
                        ) : (
                            <ul className="divide-y divide-border rounded-lg border border-border">
                                {d.activity.map((r) => {
                                    const detail = describeDetail(r.tool, r.detail, t);
                                    return (
                                        <li key={r.id} className="px-3.5 py-2 text-sm">
                                            <div className="flex items-center gap-2">
                                                <span className={cn("size-1.5 shrink-0 rounded-full", r.ok ? "bg-success" : "bg-destructive")} aria-label={r.ok ? t("activity.resultOk") : t("activity.resultFailed")} />
                                                <span className="shrink-0 text-foreground">{toolLabel(r.tool, t)}</span>
                                                {r.tunnel && (
                                                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                                                        {r.tunnel.name ?? `#${r.tunnel.id}`}
                                                        {r.target_username && ` · ${r.target_username}`}
                                                    </span>
                                                )}
                                                <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{fmtShort(r.at)}</span>
                                            </div>
                                            {detail && <p className="mt-0.5 truncate pl-3.5 font-mono text-xs text-muted-foreground" title={detail}>{detail}</p>}
                                            {r.error && <p className="mt-0.5 pl-3.5 text-xs text-destructive">{r.error}</p>}
                                        </li>
                                    );
                                })}
                            </ul>
                        )}
                    </Section>

                    </div>

                    <div role="tabpanel" hidden={tab !== "about"} className="space-y-6">
                    {/* 授權與 app 的資料 / About this authorization */}
                    <Section icon={<Info />} title={t("apps.about")}>
                        <PropertyList>
                            {someoneElse && <Property label={t("apps.authorizedBy")}>{d.user.username ?? `#${d.user.id}`}</Property>}
                            <Property label={t("apps.authorizedAt")}>{fmt(d.created_at)}</Property>
                            <Property label={t("apps.expiresAt")}>{fmt(d.expires_at)}</Property>
                            <Property label={t("apps.redirectUris")}>
                                <span className="block space-y-0.5">
                                    {d.client.redirect_uris.map((u) => (
                                        <span key={u} className="block break-all font-mono text-xs">{u}</span>
                                    ))}
                                </span>
                            </Property>
                            {d.client_uri && (
                                <Property label={t("apps.website")}>
                                    <a href={d.client_uri} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">
                                        {d.client_uri}
                                        <ExternalLink size={12} className="shrink-0" aria-hidden />
                                    </a>
                                </Property>
                            )}
                            <Property label={t("apps.clientType")}>{d.client.public ? t("apps.clientPublic") : t("apps.clientConfidential")}</Property>
                            <Property label={t("apps.clientId")} mono>
                                <span className="break-all text-xs">{d.client_id}</span>
                            </Property>
                            <Property label={t("apps.registeredAt")}>{fmt(d.client.registered_at)}</Property>
                        </PropertyList>
                    </Section>
                    </div>
                </div>
            )}

            <ConfirmDialog
                isOpen={confirmRevoke}
                onClose={() => setConfirmRevoke(false)}
                onConfirm={async () => {
                    if (await revoke()) onClose();
                }}
                title={t("apps.revoke")}
                message={t("prefs.revokeAppConfirm", { name: d?.client_name ?? "" })}
                confirmText={t("prefs.revokeApp")}
                isDestructive
            />
        </Modal>
    );
}
