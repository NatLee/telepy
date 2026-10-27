"use client";

/**
 * 已連接的應用程式（OAuth grants）：列出使用者授權過的 MCP / AI 客戶端；點一列看詳細資料（權限、隧道、
 * session、最近紀錄），也可以直接撤銷。偏好設定與 MCP 頁共用。
 * Connected apps: the MCP / AI clients the user has authorized. A row opens the details (permissions,
 * tunnels, sessions, recent calls); revoke from the row or the details. Used in preferences and on the MCP page.
 * 管理員在「管理使用者」傳 `userId` 看別人的（詳細資料與撤銷用同一組 API，管理員本來就能用）。
 * Admins pass `userId` in the Manage-user dialog to see someone else's (details and revoke use the same API).
 */
import React, { useEffect, useState } from "react";
import { Bot, ChevronRight, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionHeading } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import type { OAuthGrant } from "@/types/oauth";
import { ConnectedAppDialog } from "./ConnectedAppDialog";

export type { OAuthGrant } from "@/types/oauth";

export function ConnectedApps({ userId }: { userId?: number } = {}) {
    const { t, locale } = useI18n();
    const { showError, showSuccess } = useToast();
    const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
    const [pending, setPending] = useState<OAuthGrant | null>(null);
    const [openId, setOpenId] = useState<number | null>(null);
    const admin = userId !== undefined;

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(admin ? `/api/user/users/${userId}/grants` : "/api/oauth/grants");
                const data = res.ok ? await res.json() : [];
                if (!cancelled) setGrants(data);
            } catch {
                if (!cancelled) setGrants([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [admin, userId]);

    const removeFromList = (id: number) => setGrants((prev) => (prev ?? []).filter((x) => x.id !== id));

    const revoke = async (g: OAuthGrant) => {
        setPending(null);
        try {
            const res = await apiFetch(`/api/oauth/grants/${g.id}`, { method: "DELETE" });
            if (res.ok || res.status === 404) {
                showSuccess(t("prefs.appRevoked", { name: g.client_name }));
                removeFromList(g.id);
            } else {
                showError(t("prefs.appRevokeFailed"));
            }
        } catch {
            showError(t("prefs.appRevokeFailed"));
        }
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
