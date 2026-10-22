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
        <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
                <Bot size={15} className="text-primary" />
                {t("prefs.connectedApps")}
            </h3>
            <p className="text-xs text-muted-foreground mb-2">{t("prefs.connectedAppsDescription")}</p>
            {grants === null ? (
                <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : grants.length === 0 ? (
                <p className="text-xs text-muted-foreground rounded-lg border border-dashed border-border px-4 py-3">{t("prefs.noConnectedApps")}</p>
            ) : (
                <ul className="rounded-lg border border-border divide-y divide-border">
                    {grants.map((g) => (
                        <li key={g.id} className="px-4 py-3 flex items-start gap-3 text-sm">
                            <div className="flex-1 min-w-0">
                                <p className="font-medium truncate">{g.client_name}</p>
                                <p className="text-xs text-muted-foreground truncate">
                                    {g.scopes.join(" · ")}
                                    {" — "}
                                    {g.tunnels === null ? t("prefs.appAllTunnels") : t("prefs.appTunnelCount", { count: g.tunnels.length })}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {t("prefs.appLastUsed", { time: fmt(g.last_used_at) })}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => setPending(g)}
                                className="shrink-0 inline-flex items-center gap-1 text-xs text-destructive hover:underline"
                                aria-label={t("prefs.revokeApp")}
                            >
                                <Trash2 size={13} /> {t("prefs.revokeApp")}
                            </button>
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
