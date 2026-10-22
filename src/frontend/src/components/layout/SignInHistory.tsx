"use client";

/**
 * 最近的登入（成功與失敗）：時間、IP、瀏覽器 · 系統、方式。偏好設定的 Security 分頁看自己的
 * （`/api/auth/sign-ins`），管理員在「管理使用者」看別人的（`/api/user/users/{id}/sign-ins`）。
 * Recent sign-ins (successful and failed). Your own in the Security tab, any user's in the admin
 * "Manage user" modal.
 */
import React, { useEffect, useState } from "react";
import { CheckCircle2, History, XCircle } from "lucide-react";
import { apiFetch, readJson } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { describeUserAgent } from "@/lib/userAgent";
import { cn } from "@/lib/utils";

export interface SignInEvent {
    id: number;
    at: string;
    ok: boolean;
    method: string;
    second_factor: string | null;
    ip: string | null;
    user_agent: string | null;
    reason: string | null;
}

const METHOD_KEYS: Record<string, TranslationKey> = {
    password: "security.signInMethod.password",
    google: "security.signInMethod.google",
    passkey: "security.signInMethod.passkey",
};
const FACTOR_KEYS: Record<string, TranslationKey> = {
    totp: "security.signInFactor.totp",
    recovery_code: "security.signInFactor.recovery_code",
    passkey: "security.signInFactor.passkey",
};
const REASON_KEYS: Record<string, TranslationKey> = {
    bad_password: "security.signInReason.bad_password",
    inactive: "security.signInReason.inactive",
    mfa_failed: "security.signInReason.mfa_failed",
    google_account_conflict: "security.signInReason.google_account_conflict",
};

const COLLAPSED = 6;

export function SignInHistory({ endpoint, description }: { endpoint: string; description: string }) {
    const { t, locale } = useI18n();
    const [events, setEvents] = useState<SignInEvent[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch(`${endpoint}?limit=50`);
                const data = res.ok ? await readJson<SignInEvent[]>(res) : null;
                if (cancelled) return;
                if (Array.isArray(data)) setEvents(data);
                else setFailed(true);
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [endpoint]);

    const label = (map: Record<string, TranslationKey>, value: string) => (map[value] ? t(map[value]) : value);
    const how = (e: SignInEvent) => {
        const method = label(METHOD_KEYS, e.method);
        return e.second_factor ? t("security.signInWith", { method, factor: label(FACTOR_KEYS, e.second_factor) }) : method;
    };
    const when = (iso: string) => {
        const d = new Date(iso);
        return isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };

    const shown = events && !expanded ? events.slice(0, COLLAPSED) : events;

    return (
        <section>
            <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
                <History size={15} className="text-primary" />
                {t("security.signIns")}
            </h3>
            <p className="text-xs text-muted-foreground mb-2">{description}</p>
            {failed ? (
                <p className="text-xs text-destructive">{t("security.signInsLoadFailed")}</p>
            ) : !events ? (
                <p className="text-xs text-muted-foreground">{t("common.loading")}</p>
            ) : events.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("security.signInsEmpty")}</p>
            ) : (
                <>
                    <ul className="rounded-lg border border-border divide-y divide-border text-sm">
                        {shown!.map((e) => (
                            <li key={e.id} className="px-3 py-2 flex items-start gap-2.5">
                                {e.ok ? (
                                    <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" aria-label={t("security.signInOk")} />
                                ) : (
                                    <XCircle size={15} className="mt-0.5 shrink-0 text-destructive" aria-label={t("security.signInFailed")} />
                                )}
                                <div className="min-w-0 flex-1">
                                    <p className="flex flex-wrap items-baseline gap-x-2">
                                        <span className="font-medium text-foreground truncate" title={e.user_agent ?? undefined}>
                                            {describeUserAgent(e.user_agent) ?? t("security.unknownDevice")}
                                        </span>
                                        <span className={cn("font-mono text-xs", e.ip ? "text-foreground/80" : "text-muted-foreground")}>
                                            {e.ip ?? t("security.unknownIp")}
                                        </span>
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {when(e.at)} · {how(e)}
                                        {!e.ok && e.reason && <span className="text-destructive"> · {label(REASON_KEYS, e.reason)}</span>}
                                    </p>
                                </div>
                            </li>
                        ))}
                    </ul>
                    {events.length > COLLAPSED && (
                        <button type="button" className="mt-1.5 text-xs text-primary hover:underline" onClick={() => setExpanded((v) => !v)}>
                            {expanded ? t("security.signInsShowLess") : t("security.signInsShowAll", { count: events.length })}
                        </button>
                    )}
                </>
            )}
        </section>
    );
}
