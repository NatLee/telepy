"use client";

/**
 * `telepy` CLI 的瀏覽器登入（每次 `telepy login` 一個）：API 頁的「CLI 登入」分頁，以及管理員的「管理使用者」視窗（`userId`）。
 * 跟 MCP app 一樣是 OAuth 授權，但它是 Telepy 自己的命令列、打的是 REST API，所以列在 API token 旁邊、用量在 API 活動。
 * 每列：電腦、權限、隧道、登入 / 最後使用 / 沒在用多久會失效、最近的呼叫；「呼叫紀錄」跳到活動、垃圾桶 = 登出那台電腦。
 * 最多保留 `CLI_SIGNIN_LIMIT` 個；滿了時標出下一次登入會被登出的那個。
 * The CLI's browser sign-ins (one per `telepy login`): the API page's CLI sign-ins tab and the admin's Manage-user
 * dialog (`userId`). OAuth like an MCP app, but it is Telepy's own command line calling the REST API, so it sits next to
 * API tokens with its usage in the API activity. At most `CLI_SIGNIN_LIMIT` are kept; when full, the one the next
 * sign-in would sign out is marked.
 */
import React, { useState } from "react";
import Link from "next/link";
import { Laptop, ListTree, SquareTerminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip, SectionHeading } from "@/components/ui/section";
import { useToast } from "@/components/ui/Toast";
import { SCOPE_META } from "@/components/oauth/ConnectFlow";
import { useOAuthGrants } from "@/hooks/useOAuthGrants";
import { useAuth } from "@/lib/auth";
import { hasFeature } from "@/lib/features";
import { useI18n } from "@/lib/i18n";
import { CLI_SIGNIN_LIMIT, grantHost, overflowOnNext } from "@/lib/cliSignIns";
import type { OAuthGrant } from "@/types/oauth";

export function CliSignIns({ userId, onShowCalls, hideHeading = false }: { userId?: number; onShowCalls?: (g: OAuthGrant) => void; hideHeading?: boolean }) {
    const { t, tn, locale } = useI18n();
    const { user } = useAuth();
    const { showError, showSuccess } = useToast();
    const { cli, failed, revoke } = useOAuthGrants(userId);
    const [pending, setPending] = useState<OAuthGrant | null>(null);
    const admin = userId !== undefined;
    // 瀏覽器登入跟著「MCP app」這個功能權限（後端的規則）；關掉時說清楚，免得以為 CLI 壞了。
    // Browser sign-in follows the MCP apps feature (the backend's rule); say so when it is off.
    const browserOff = !admin && !!user && !hasFeature(user, "mcp.connect");

    const when = (iso: string | null) => {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    };
    const day = (iso: string | null) => {
        if (!iso) return "";
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
    };
    const hostOf = (g: OAuthGrant) => grantHost(g) || t("cliSignIns.unnamed");
    const code = (text: string) => <code className="rounded-sm bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">{text}</code>;

    const doRevoke = async (g: OAuthGrant) => {
        setPending(null);
        if (await revoke(g)) showSuccess(t("cliSignIns.signedOut", { host: hostOf(g) }));
        else showError(t("cliSignIns.signOutFailed"));
    };

    const list = cli ?? [];
    // 滿了：下一次 `telepy login` 會登出哪一個（最久沒用的）。/ Full: the one the next sign-in would sign out.
    const nextOut = list.length >= CLI_SIGNIN_LIMIT ? new Set(overflowOnNext(list).map((g) => g.id)) : new Set<number>();

    return (
        <section className="space-y-3">
            {!hideHeading && (
                <SectionHeading
                    icon={<SquareTerminal />}
                    title={admin ? t("cliSignIns.adminTitle") : t("cliSignIns.title")}
                    description={admin ? t("cliSignIns.adminDescription") : t("cliSignIns.description")}
                />
            )}
            {browserOff && <Callout tone="warning">{t("cliSignIns.browserOff")}</Callout>}
            {failed && <p className="text-sm text-destructive">{t("cliSignIns.loadFailed")}</p>}
            {cli === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : list.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-4 text-center text-sm leading-relaxed text-muted-foreground">
                    {admin ? (
                        t("cliSignIns.adminEmpty")
                    ) : (
                        <>
                            {tn("cliSignIns.empty", { cmd: code("telepy login") })}{" "}
                            <Link href="/tunnels/cli" className="text-foreground underline underline-offset-4">
                                {t("cliSignIns.openGuide")}
                            </Link>
                        </>
                    )}
                </div>
            ) : (
                <>
                    <p className="text-xs leading-relaxed text-muted-foreground tabular-nums">{t("cliSignIns.limit", { count: list.length, limit: CLI_SIGNIN_LIMIT })}</p>
                    <ul className="divide-y divide-border rounded-xl border border-border">
                        {list.map((g) => (
                            <li key={g.id} className="flex items-start gap-3 px-4 py-3">
                                <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground/70" aria-hidden>
                                    <Laptop size={16} />
                                </span>
                                <div className="min-w-0 flex-1 space-y-1">
                                    <span className="flex flex-wrap items-center gap-2">
                                        <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">{hostOf(g)}</span>
                                        {nextOut.has(g.id) && <Chip tone="warning">{t("cliSignIns.nextOut")}</Chip>}
                                    </span>
                                    <span className="flex flex-wrap gap-1">
                                        {g.scopes.map((s) => (
                                            <Chip key={s}>{SCOPE_META[s] ? t(SCOPE_META[s].label) : s}</Chip>
                                        ))}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {g.tunnels === null ? t("tokens.allTunnels") : g.tunnels.map((x) => x.name).join(", ") || t("tokens.noTunnelsLeft")}
                                        {" · "}
                                        {t("cliSignIns.signedInAt", { date: day(g.created_at) })}
                                        {g.expires_at && (
                                            <>
                                                {" · "}
                                                {t("cliSignIns.endsIfUnused", { date: day(g.expires_at) })}
                                            </>
                                        )}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">{g.last_used_at ? t("cliSignIns.lastUsed", { time: when(g.last_used_at) }) : t("cliSignIns.neverUsed")}</span>
                                    {g.calls && g.calls.calls_7d > 0 && (
                                        <span className="block text-xs text-muted-foreground tabular-nums">
                                            {t("cliSignIns.callSummary", { day: g.calls.calls_24h, week: g.calls.calls_7d })}
                                            {g.calls.errors_7d > 0 && <span className="text-warning"> · {t("tokens.callErrors", { count: g.calls.errors_7d })}</span>}
                                        </span>
                                    )}
                                </div>
                                {onShowCalls && (
                                    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1" onClick={() => onShowCalls(g)}>
                                        <ListTree size={13} /> {t("tokens.showCalls")}
                                    </Button>
                                )}
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => setPending(g)}
                                    className="shrink-0 text-destructive hover:bg-destructive/8 hover:text-destructive"
                                    aria-label={t("cliSignIns.signOut")}
                                    title={t("cliSignIns.signOut")}
                                >
                                    <Trash2 />
                                </Button>
                            </li>
                        ))}
                    </ul>
                </>
            )}
            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={() => pending && doRevoke(pending)}
                title={t("cliSignIns.signOut")}
                message={t(admin ? "cliSignIns.signOutConfirmAdmin" : "cliSignIns.signOutConfirm", { host: pending ? hostOf(pending) : "" })}
                confirmText={t("cliSignIns.signOut")}
                isDestructive
            />
        </section>
    );
}
