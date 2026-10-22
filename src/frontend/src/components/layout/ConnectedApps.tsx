"use client";

/**
 * 已連接的應用程式（OAuth grants）：列出使用者授權過的 MCP / AI 客戶端，可撤銷。
 * Connected apps: the MCP / AI clients the user has authorized, with revoke.
 */
import React, { useEffect, useState } from "react";
import { Bot, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionHeading } from "@/components/ui/section";
import { Button } from "@/components/ui/button";

export interface OAuthGrant {
    id: number;
    client_id: string;
    client_name: string;
    client_uri?: string | null;
    scopes: string[];
    tunnels: { id: number; name: string }[] | null;
    created_at: string;
    last_used_at: string | null;
    expires_at: string | null;
}

export function ConnectedApps() {
    const { t, locale } = useI18n();
    const { showError, showSuccess } = useToast();
    const [grants, setGrants] = useState<OAuthGrant[] | null>(null);
    const [pending, setPending] = useState<OAuthGrant | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/oauth/grants");
                const data = res.ok ? await res.json() : [];
                if (!cancelled) setGrants(data);
            } catch {
                if (!cancelled) setGrants([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const revoke = async (g: OAuthGrant) => {
        setPending(null);
        try {
            const res = await apiFetch(`/api/oauth/grants/${g.id}`, { method: "DELETE" });
            if (res.ok || res.status === 404) {
                showSuccess(t("prefs.appRevoked", { name: g.client_name }));
                setGrants((prev) => (prev ?? []).filter((x) => x.id !== g.id));
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
            <SectionHeading icon={<Bot />} title={t("prefs.connectedApps")} description={t("prefs.connectedAppsDescription")} />
            {grants === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : grants.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm leading-relaxed text-muted-foreground">{t("prefs.noConnectedApps")}</p>
            ) : (
                <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                    {grants.map((g) => (
                        <li key={g.id} className="flex items-start gap-3 px-4 py-3">
                            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                                <Bot size={16} />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="truncate text-foreground">{g.client_name}</p>
                                <p className="truncate text-xs text-muted-foreground">
                                    {g.scopes.join(" · ")}
                                    {" — "}
                                    {g.tunnels === null ? t("prefs.appAllTunnels") : t("prefs.appTunnelCount", { count: g.tunnels.length })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t("prefs.appLastUsed", { time: fmt(g.last_used_at) })}
                                </p>
                            </div>
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => setPending(g)}
                                className="shrink-0 text-destructive hover:bg-destructive/8 hover:text-destructive"
                                aria-label={t("prefs.revokeApp")}
                            >
                                <Trash2 /> {t("prefs.revokeApp")}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
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
