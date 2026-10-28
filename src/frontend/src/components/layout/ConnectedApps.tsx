"use client";

/**
 * MCP app（OAuth grant）：列出使用者授權過的 MCP / AI 客戶端；點一列看詳細資料（權限、隧道、session、最近紀錄），
 * 也可以直接撤銷。偏好設定與 MCP 頁共用。`telepy` CLI 的瀏覽器登入也是 OAuth grant，但不列在這裡（它在 API 頁的
 * 「CLI 登入」），只留一行指過去，免得把命令列當成 AI app。
 * MCP apps: the MCP / AI clients the user has authorized. A row opens the details (permissions, tunnels, sessions,
 * recent calls); revoke from the row or the details. Used in preferences and on the MCP page. The CLI's browser
 * sign-ins are OAuth grants too but live on the API page (CLI sign-ins); only a pointer stays here.
 * 管理員在「管理使用者」傳 `userId` 看別人的（詳細資料與撤銷用同一組 API，管理員本來就能用）。
 * Admins pass `userId` in the Manage-user dialog to see someone else's (details and revoke use the same API).
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, Bot, ChevronRight, SquareTerminal, Trash2 } from "lucide-react";
import { useOAuthGrants } from "@/hooks/useOAuthGrants";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionHeading } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import type { OAuthGrant } from "@/types/oauth";
import { ConnectedAppDialog } from "./ConnectedAppDialog";

export type { OAuthGrant } from "@/types/oauth";

export function ConnectedApps({
    userId,
    cliHref = "/tunnels/api?tab=cli",
    onShowCli,
    onNavigate,
}: {
    userId?: number;
    /** CLI 登入在哪裡。/ Where CLI sign-ins live. */
    cliHref?: string;
    /** 管理員視窗：切到同一個視窗的 CLI 登入分頁，而不是換頁。/ The admin dialog switches to its own tab instead of navigating. */
    onShowCli?: () => void;
    /** 點了連結（偏好設定視窗要關起來）。/ A link was followed (the preferences modal closes). */
    onNavigate?: () => void;
} = {}) {
    const { t, locale } = useI18n();
    const { showError, showSuccess } = useToast();
    const { apps: grants, cli, revoke: revokeGrant, forget } = useOAuthGrants(userId);
    const [pending, setPending] = useState<OAuthGrant | null>(null);
    const [openId, setOpenId] = useState<number | null>(null);
    const admin = userId !== undefined;
    const removeFromList = (id: number) => forget(id);

    const revoke = async (g: OAuthGrant) => {
        setPending(null);
        if (await revokeGrant(g)) showSuccess(t("prefs.appRevoked", { name: g.client_name }));
        else showError(t("prefs.appRevokeFailed"));
    };

    const fmt = (iso: string | null) => {
        if (!iso) return t("prefs.appNever");
        const d = new Date(iso);
        return isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };

    return (
        <section className="space-y-3">
            <SectionHeading icon={<Bot />} title={t("prefs.connectedApps")} description={admin ? t("apps.adminDescription") : t("prefs.connectedAppsDescription")} />
            {grants === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : grants.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm leading-relaxed text-muted-foreground">{admin ? t("apps.adminEmpty") : t("prefs.noConnectedApps")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                    {grants.map((g) => (
                        <li key={g.id} className="flex items-center gap-1 pr-2">
                            <button
                                type="button"
                                onClick={() => setOpenId(g.id)}
                                className="group flex min-w-0 flex-1 items-start gap-3 rounded-l-xl px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                                aria-label={t("apps.openDetails", { name: g.client_name })}
                            >
                                <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground/70" aria-hidden>
                                    <Bot size={16} />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-foreground">{g.client_name}</span>
                                    <span className="block truncate text-xs text-muted-foreground">
                                        {g.scopes.join(" · ")}
                                        {" — "}
                                        {g.tunnels === null ? t("prefs.appAllTunnels") : t("prefs.appTunnelCount", { count: g.tunnels.length })}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">{t("prefs.appLastUsed", { time: fmt(g.last_used_at) })}</span>
                                </span>
                                <ChevronRight size={16} className="mt-2.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                            </button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => setPending(g)}
                                className="shrink-0 text-destructive hover:bg-destructive/8 hover:text-destructive"
                                aria-label={t("prefs.revokeApp")}
                                title={t("prefs.revokeApp")}
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {/* CLI 登入不算 MCP app：指到它們真正的位置。/ CLI sign-ins are not MCP apps: point to where they live. */}
            {cli && cli.length > 0 && <CliPointer count={cli.length} admin={admin} href={cliHref} onNavigate={onNavigate} onShowCli={onShowCli} />}
            <ConnectedAppDialog grantId={openId} onClose={() => setOpenId(null)} onRevoked={removeFromList} />
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => pending && revoke(pending)}
                title={t("prefs.revokeApp")}
                message={t("prefs.revokeAppConfirm", { name: pending?.client_name ?? "" })}
                confirmText={t("prefs.revokeApp")}
                isDestructive
            />
        </section>
    );
}

function CliPointer({ count, admin, href, onNavigate, onShowCli }: { count: number; admin: boolean; href: string; onNavigate?: () => void; onShowCli?: () => void }) {
    const { t } = useI18n();
    const body = (
        <>
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground/70" aria-hidden>
                <SquareTerminal size={16} />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{t(admin ? "apps.cliElsewhereAdmin" : "apps.cliElsewhere", { count })}</span>
                <span className="block text-xs text-muted-foreground">{t("apps.cliElsewhereHint")}</span>
            </span>
            <ArrowRight size={15} className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </>
    );
    const cls = "group flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-foreground/25 hover:bg-muted/50";
    return onShowCli ? (
        <button type="button" onClick={onShowCli} className={cls}>
            {body}
        </button>
    ) : (
        <Link href={href} prefetch={false} onClick={onNavigate} className={cls}>
            {body}
        </Link>
    );
}
