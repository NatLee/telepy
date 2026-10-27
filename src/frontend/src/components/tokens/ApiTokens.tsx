"use client";

/**
 * 個人 API token 清單：API 頁的「你的 token」（可建立、可撤銷、有說明圖、每把的呼叫摘要；`onShowCalls` = 點一下看它的紀錄）
 * 與管理員的「管理使用者」視窗（`userId`：只能看與撤銷）。每列：名稱、祕密開頭、scope、隧道、最後使用、到期狀態、
 * 開著的 session、最近的呼叫。
 * Personal API token list: the API page's "Your tokens" (create, revoke, the explainer, each token's call summary;
 * `onShowCalls` opens its calls) and the admin's Manage-user modal (`userId`: list and revoke only). Each row: name,
 * secret prefix, scopes, tunnels, last use, expiry state, open sessions, recent calls.
 */
import React, { useState } from "react";
import { Info, KeyRound, ListTree, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { SCOPE_META } from "@/components/oauth/ConnectFlow";
import { useApiTokens } from "@/hooks/useApiTokens";
import { useI18n } from "@/lib/i18n";
import { tokenState, type ApiToken, type TokenState } from "@/lib/apiTokens";
import type { TranslationKey } from "@/locales/en";
import { ApiTokenCreateDialog } from "./ApiTokenCreateDialog";
import { ApiTokenInfoDialog } from "./ApiTokenFlow";

const STATE: Record<TokenState, { key: TranslationKey; tone: "success" | "warning" | "neutral" | "danger" }> = {
    active: { key: "tokens.state.active", tone: "success" },
    soon: { key: "tokens.state.soon", tone: "warning" },
    expired: { key: "tokens.state.expired", tone: "neutral" },
    revoked: { key: "tokens.state.revoked", tone: "neutral" },
};

export function ApiTokens({
    userId,
    canCreate = true,
    onShowCalls,
    onTokens,
    hideHeading = false,
}: {
    userId?: number;
    canCreate?: boolean;
    /** 看這把的呼叫紀錄。/ Show this token's calls. */
    onShowCalls?: (tok: ApiToken) => void;
    /** 清單載入 / 更新時告訴外面（API 頁的活動篩選要用）。/ Reports the list (the activity filter uses it). */
    onTokens?: (tokens: ApiToken[] | null) => void;
    hideHeading?: boolean;
}) {
    const { t, locale } = useI18n();
    const { showError, showSuccess } = useToast();
    const { tokens, failed, create, revoke, reauthDialog } = useApiTokens(userId);
    React.useEffect(() => {
        onTokens?.(tokens);
    }, [tokens, onTokens]);
    const [creating, setCreating] = useState(false);
    // 每次打開建立視窗都換一個 key：表單從空白開始。/ A new key per open: the form starts blank.
    const [createKey, setCreateKey] = useState(0);
    const [info, setInfo] = useState<{ token: ApiToken | null } | null>(null);
    const [pending, setPending] = useState<ApiToken | null>(null);
    const admin = userId !== undefined;

    const when = (iso: string | null) => {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };
    const day = (iso: string) => {
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
    };

    const doRevoke = async (tok: ApiToken) => {
        setPending(null);
        if (await revoke(tok)) showSuccess(t("tokens.revoked", { name: tok.name }));
        else showError(t("tokens.revokeFailed"));
    };

    const headingActions = (
        <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" onClick={() => setInfo({ token: null })}>
                <Info />
                {t("tokens.howItWorks")}
            </Button>
            {!admin && canCreate && (
                <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                        setCreateKey((k) => k + 1);
                        setCreating(true);
                    }}
                >
                    <Plus />
                    {t("tokens.new")}
                </Button>
            )}
        </div>
    );

    return (
        <section className="space-y-3">
            {hideHeading ? (
                <div className="flex justify-end">{headingActions}</div>
            ) : (
                <SectionHeading
                    icon={<KeyRound />}
                    title={admin ? t("tokens.adminTitle") : t("tokens.title")}
                    description={admin ? t("tokens.adminDescription") : t("tokens.description")}
                    action={headingActions}
                />
            )}
            {failed && <p className="text-sm text-destructive">{t("tokens.loadFailed")}</p>}
            {tokens === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : tokens.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm leading-relaxed text-muted-foreground">{admin ? t("tokens.adminEmpty") : t("tokens.empty")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                    {tokens.map((tok) => {
                        const state = tokenState(tok);
                        const live = state === "active" || state === "soon";
                        return (
                            <li key={tok.id} className="flex items-start gap-3 px-4 py-3">
                                <button
                                    type="button"
                                    onClick={() => setInfo({ token: tok })}
                                    className="min-w-0 flex-1 space-y-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm"
                                    aria-label={t("tokens.showPath", { name: tok.name })}
                                >
                                    <span className="flex flex-wrap items-center gap-2">
                                        <span className={live ? "text-foreground" : "text-muted-foreground"}>{tok.name}</span>
                                        <Chip mono>{tok.prefix}…</Chip>
                                        <Chip tone={STATE[state].tone}>{t(STATE[state].key)}</Chip>
                                        {tok.sessions > 0 && <Chip tone="primary">{t("tokens.sessions", { count: tok.sessions })}</Chip>}
                                    </span>
                                    <span className="flex flex-wrap gap-1">
                                        {tok.scopes.map((s) => (
                                            <Chip key={s}>{SCOPE_META[s] ? t(SCOPE_META[s].label) : s}</Chip>
                                        ))}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {tok.tunnels === null ? t("tokens.allTunnels") : tok.tunnels.map((x) => x.name ?? `#${x.id}`).join(", ") || t("tokens.noTunnelsLeft")}
                                        {" · "}
                                        {state === "revoked" && tok.revoked_at ? t("tokens.revokedAt", { date: day(tok.revoked_at) }) : state === "expired" ? t("tokens.expired", { date: day(tok.expires_at) }) : t("tokens.expires", { date: day(tok.expires_at) })}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {tok.last_used_at ? (tok.last_used_ip ? t("tokens.lastUsedFrom", { time: when(tok.last_used_at), ip: tok.last_used_ip }) : t("tokens.lastUsed", { time: when(tok.last_used_at) })) : t("tokens.neverUsed")}
                                    </span>
                                    {tok.calls && (tok.call_count ?? 0) > 0 && (
                                        <span className="block text-xs text-muted-foreground tabular-nums">
                                            {t("tokens.callSummary", { day: tok.calls.calls_24h, week: tok.calls.calls_7d, total: tok.call_count ?? 0 })}
                                            {tok.calls.errors_7d > 0 && <span className="text-warning"> · {t("tokens.callErrors", { count: tok.calls.errors_7d })}</span>}
                                        </span>
                                    )}
                                </button>
                                {onShowCalls && (
                                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1" onClick={() => onShowCalls(tok)}>
                                        <ListTree size={13} /> {t("tokens.showCalls")}
                                    </Button>
                                )}
                                {live && (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => setPending(tok)}
                                        className="shrink-0 text-destructive hover:bg-destructive/8 hover:text-destructive"
                                        aria-label={t("tokens.revoke")}
                                        title={t("tokens.revoke")}
                                    >
                                        <Trash2 />
                                    </Button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {!admin && <ApiTokenCreateDialog key={createKey} isOpen={creating} onClose={() => setCreating(false)} onCreate={create} />}
            <ApiTokenInfoDialog isOpen={info !== null} onClose={() => setInfo(null)} token={info?.token} />
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => pending && doRevoke(pending)}
                title={t("tokens.revoke")}
                message={t("tokens.revokeConfirm", { name: pending?.name ?? "" })}
                confirmText={t("tokens.revoke")}
                isDestructive
            />
            {reauthDialog}
        </section>
    );
}
