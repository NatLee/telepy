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
import { Info, KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { Pagination } from "@/components/ui/pagination";
import { ViewToggle } from "@/components/ui/ViewToggle";
import { useApiTokens } from "@/hooks/useApiTokens";
import { usePagination } from "@/hooks/usePagination";
import { useViewMode } from "@/hooks/useViewMode";
import { CARD_PAGE_SIZES } from "@/lib/pagination";
import { useI18n } from "@/lib/i18n";
import { TOKEN_SCOPES, tokenState, type ApiToken, type TokenState } from "@/lib/apiTokens";
import type { TranslationKey } from "@/locales/en";
import { ApiTokenCreateDialog } from "./ApiTokenCreateDialog";
import { ApiTokenInfoDialog } from "./ApiTokenFlow";
import { CredentialList, type CredentialItem } from "./CredentialList";

const STATE: Record<TokenState, { key: TranslationKey; tone: "success" | "warning" | "muted" }> = {
    active: { key: "tokens.state.active", tone: "success" },
    soon: { key: "tokens.state.soon", tone: "warning" },
    expired: { key: "tokens.state.expired", tone: "muted" },
    revoked: { key: "tokens.state.revoked", tone: "muted" },
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
    // 清單 / 卡片跟著帳號（偏好設定 → 外觀也能改）；管理員的「管理使用者」視窗一律清單。
    // List / cards follow the account (also in Preferences → Appearance); the admin's Manage-user dialog is always a list.
    const [chosen, setView] = useViewMode("api_tokens");
    const view = admin ? "list" : chosen;
    const pager = usePagination(tokens?.length ?? 0, {
        storageKey: view === "card" ? "telepy.apiTokenCardsPageSize" : "telepy.apiTokensPageSize",
        resetKey: view,
        sizes: view === "card" ? CARD_PAGE_SIZES : undefined,
    });

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

    const items: CredentialItem[] = (tokens ?? []).slice(pager.from - 1, pager.to).map((tok) => {
        const state = tokenState(tok);
        const live = state === "active" || state === "soon";
        return {
            id: tok.id,
            icon: <KeyRound />,
            name: tok.name,
            onOpen: () => setInfo({ token: tok }),
            openLabel: t("tokens.showPath", { name: tok.name }),
            prefix: `${tok.prefix}…`,
            prefixTitle: t("tokens.list.prefixTitle"),
            status: { text: t(STATE[state].key), tone: STATE[state].tone },
            notes: tok.sessions > 0 ? [{ text: t("tokens.sessions", { count: tok.sessions }), tone: "primary" as const }] : undefined,
            dim: !live,
            scopes: tok.scopes,
            slots: TOKEN_SCOPES,
            tunnels: tok.tunnels === null ? t("tokens.allTunnels") : tok.tunnels.map((x) => x.name ?? `#${x.id}`).join(", ") || t("tokens.noTunnelsLeft"),
            lastUsedAt: tok.last_used_at,
            lastUsedIp: tok.last_used_ip,
            neverUsed: t("tokens.neverUsed"),
            expiry:
                state === "revoked" && tok.revoked_at
                    ? { text: t("tokens.revokedAt", { date: day(tok.revoked_at) }), tone: "muted" }
                    : state === "expired"
                      ? { text: t("tokens.expired", { date: day(tok.expires_at) }), tone: "muted" }
                      : { text: t("tokens.expires", { date: day(tok.expires_at) }), title: when(tok.expires_at), tone: state === "soon" ? "warning" : undefined },
            calls: tok.calls,
            onCalls: onShowCalls ? () => onShowCalls(tok) : undefined,
            onRemove: live ? () => setPending(tok) : undefined,
            removeLabel: t("tokens.revoke"),
        };
    });

    const headingActions = (
        <div className="flex flex-wrap items-center gap-1.5">
            {!admin && tokens !== null && tokens.length > 0 && <ViewToggle value={view} onChange={setView} />}
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
                <>
                    <CredentialList items={items} view={view} nameHeader={t("tokens.list.colToken")} />
                    <Pagination pager={pager} className="mt-3" />
                </>
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
