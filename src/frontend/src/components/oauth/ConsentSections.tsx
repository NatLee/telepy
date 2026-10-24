"use client";

/**
 * OAuth 同意頁的各區塊：登入身分（不是你？換帳號）、重新連接同一個 app 的提示、權限、隧道範圍、送出後的結果。
 * Consent-page blocks: the signed-in account ("Not you?"), the reconnect notice, permissions, tunnel scope
 * and the result after the decision.
 */
import React from "react";
import Link from "next/link";
import { CircleCheck, CircleX, CornerDownLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Chip, Section } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { SCOPE_META, ScopeImpact } from "@/components/oauth/ConnectFlow";
import type { ConsentInfo, ConsentScope, ConsentTunnel } from "@/hooks/useOAuthConsent";
import { useI18n } from "@/lib/i18n";
import { TUNNEL_SEARCH_FROM } from "@/lib/oauthFlow";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

const PERMISSION_LABELS: Record<string, TranslationKey> = {
    owner: "network.permission.owner",
    admin: "network.permission.admin",
    edit: "network.permission.edit",
    view: "network.permission.view",
};

/** 目前登入的帳號 +「不是你？換帳號」。/ The signed-in account plus "Not you? Switch account". */
export function AccountRow({ username, onSwitch, disabled }: { username: string; onSwitch: () => void; disabled?: boolean }) {
    const { t } = useI18n();
    return (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-sm text-background" aria-hidden>
                {username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{t("oauth.signedInAs")}</p>
                <p className="truncate text-sm text-foreground">{username}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-xs text-muted-foreground sm:inline">{t("oauth.notYou")}</span>
                <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onSwitch} title={t("oauth.switchAccountHint")}>
                    {t("oauth.switchAccount")}
                </Button>
            </div>
        </div>
    );
}

/** 先前連接過同一個 app：說明 + 「取代舊連線」。/ The app was connected before: notice plus "replace". */
export function ExistingConnection({ app, existing, replace, onReplace }: { app: string; existing: NonNullable<ConsentInfo["existing"]>; replace: boolean; onReplace: (v: boolean) => void }) {
    const { t, locale } = useI18n();
    const latest = existing[0];
    const date = new Date(latest.created_at).toLocaleDateString(locale, { dateStyle: "medium" });
    const used = latest.last_used_at ? formatRelativeTime(latest.last_used_at, locale) : t("oauth.existingNeverUsed");
    return (
        <Callout tone="info" title={t("oauth.existingTitle", { app })}>
            <p>{existing.length === 1 ? t("oauth.existingOne", { date, used }) : t("oauth.existingMany", { count: existing.length, date })}</p>
            <label className="mt-2.5 flex cursor-pointer items-start gap-2.5">
                <input type="checkbox" className="mt-1 accent-primary" checked={replace} onChange={(e) => onReplace(e.target.checked)} />
                <span>
                    <span className="block text-foreground">{existing.length === 1 ? t("oauth.replaceOne") : t("oauth.replaceMany", { count: existing.length })}</span>
                    <span className="block text-xs text-muted-foreground">{replace ? t("oauth.replaceOnHint", { app }) : t("oauth.replaceOffHint")}</span>
                </span>
            </label>
        </Callout>
    );
}

/** 權限：每項可取消；會改東西的標成警告色。/ Permissions, each can be unticked; the ones that change things are flagged. */
export function ScopeChoices({ scopes, selected, onToggle }: { scopes: ConsentScope[]; selected: string[]; onToggle: (name: string) => void }) {
    const { t } = useI18n();
    return (
        <Section as="h2" title={t("oauth.permissions")} description={t("oauth.permissionsHint")}>
            <ul className="space-y-2">
                {scopes.map((s) => {
                    const meta = SCOPE_META[s.name];
                    const Icon = meta?.Icon;
                    const checked = selected.includes(s.name);
                    return (
                        <li key={s.name}>
                            <label
                                className={cn(
                                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
                                    checked ? "border-input bg-card" : "border-dashed border-border hover:bg-muted/40"
                                )}
                            >
                                <input type="checkbox" className="mt-2 accent-primary" checked={checked} onChange={() => onToggle(s.name)} />
                                {Icon && (
                                    <span className={cn("grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card", checked ? "text-foreground" : "text-muted-foreground")}>
                                        <Icon size={16} aria-hidden />
                                    </span>
                                )}
                                <span className="min-w-0 flex-1 text-sm">
                                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                        <span className={checked ? "text-foreground" : "text-muted-foreground line-through decoration-muted-foreground/50"}>{meta ? t(meta.label) : s.name}</span>
                                        <ScopeImpact scope={s.name} />
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{meta ? t(meta.description) : s.description}</span>
                                </span>
                            </label>
                        </li>
                    );
                })}
            </ul>
            {selected.length === 0 && <p className="text-xs text-destructive">{t("oauth.needOneScope")}</p>}
        </Section>
    );
}

/**
 * 隧道範圍：全部（含之後才有的）或只限勾選的；隧道多時有搜尋與「全選 / 清除目前顯示的」。
 * Tunnel scope: all (later ones too) or only the ticked ones; search and select / clear shown for long lists.
 */
export function TunnelChoice({
    all,
    shown,
    mode,
    selected,
    query,
    onMode,
    onToggle,
    onQuery,
    onShown,
}: {
    all: ConsentTunnel[];
    shown: ConsentTunnel[];
    mode: "all" | "some";
    selected: number[];
    query: string;
    onMode: (m: "all" | "some") => void;
    onToggle: (id: number) => void;
    onQuery: (q: string) => void;
    onShown: (on: boolean) => void;
}) {
    const { t } = useI18n();
    if (all.length === 0) {
        return (
            <Section as="h2" title={t("oauth.tunnels")}>
                <p className="text-sm text-muted-foreground">{t("oauth.noTunnels")}</p>
            </Section>
        );
    }
    return (
        <Section as="h2" title={t("oauth.tunnels")} description={t("oauth.tunnelsHint")}>
            <Segmented
                fullWidth
                size="sm"
                aria-label={t("oauth.tunnels")}
                value={mode}
                onChange={onMode}
                options={[
                    { value: "all", label: t("oauth.tunnelsAll") },
                    { value: "some", label: t("oauth.tunnelsSome") },
                ]}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
                {mode === "all" ? t("oauth.tunnelsAllHint", { count: all.length }) : t("oauth.tunnelsSomeHint", { count: selected.length, total: all.length })}
            </p>
            {mode === "some" && (
                <div className="overflow-hidden rounded-lg border border-border">
                    {all.length >= TUNNEL_SEARCH_FROM && (
                        <div className="relative border-b border-border p-2">
                            <Search size={15} className="pointer-events-none absolute left-4.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t("oauth.tunnelSearch")} aria-label={t("oauth.tunnelSearch")} className="h-9 pl-8" />
                        </div>
                    )}
                    <div className="flex items-center justify-end gap-3 border-b border-border bg-surface px-3 py-1.5 text-xs">
                        <button type="button" className="text-primary hover:underline disabled:text-muted-foreground disabled:no-underline" disabled={shown.length === 0} onClick={() => onShown(true)}>
                            {query ? t("oauth.selectShown") : t("oauth.selectAll")}
                        </button>
                        <button type="button" className="text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={selected.length === 0} onClick={() => onShown(false)}>
                            {t("oauth.clearSelection")}
                        </button>
                    </div>
                    {shown.length === 0 ? (
                        <p className="px-3 py-3 text-xs text-muted-foreground">{t("oauth.tunnelNoMatch", { query })}</p>
                    ) : (
                        <ul className="divide-y divide-border">
                            {shown.map((tun) => {
                                const perm = tun.permission ? PERMISSION_LABELS[tun.permission] : undefined;
                                return (
                                    <li key={tun.id}>
                                        <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                                            <input type="checkbox" className="accent-primary" checked={selected.includes(tun.id)} onChange={() => onToggle(tun.id)} />
                                            <span className="min-w-0 flex-1 truncate">{tun.name}</span>
                                            {tun.permission && <Chip>{perm ? t(perm) : tun.permission}</Chip>}
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
            {mode === "some" && selected.length === 0 && <p className="text-xs text-destructive">{t("oauth.needOneTunnel")}</p>}
        </Section>
    );
}

/**
 * 送出之後：已允許 / 已拒絕。http(s) 的 app 會直接換頁；自訂 scheme（桌面 app）不會，所以這裡要能再開一次、能關分頁。
 * After the decision. http(s) apps navigate away at once; custom-scheme desktop apps do not, hence "open again".
 */
export function DecisionView({ approved, app, onReopen }: { approved: boolean; app: string; onReopen: () => void }) {
    const { t } = useI18n();
    return (
        <div className="space-y-6" role="status">
            <div className="flex items-start gap-3">
                <span
                    className={cn(
                        "grid size-11 shrink-0 place-items-center rounded-xl border",
                        approved ? "border-success/30 bg-success/10 text-success" : "border-border bg-surface text-muted-foreground"
                    )}
                >
                    {approved ? <CircleCheck size={22} aria-hidden /> : <CircleX size={22} aria-hidden />}
                </span>
                <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">{approved ? t("oauth.doneApprovedTitle") : t("oauth.doneDeniedTitle")}</h1>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{approved ? t("oauth.doneApprovedBody", { app }) : t("oauth.doneDeniedBody", { app })}</p>
                </div>
            </div>
            <Button variant="outline" className="h-11 w-full" onClick={onReopen}>
                <CornerDownLeft size={16} aria-hidden />
                <span className="truncate">{t("oauth.openAgain", { app })}</span>
            </Button>
            {approved && (
                <p className="text-center text-sm text-muted-foreground">
                    {t("oauth.manageLater")}{" "}
                    <Link href="/tunnels/mcp" className="text-primary underline-offset-4 hover:underline">
                        {t("oauth.manageApps")}
                    </Link>
                </p>
            )}
        </div>
    );
}

/** 載入中的骨架（形狀跟同意頁一樣，換頁不跳）。/ Loading skeleton shaped like the consent page. */
export function ConsentSkeleton() {
    const { t } = useI18n();
    return (
        <div aria-busy="true">
            <span className="sr-only">{t("oauth.loading")}</span>
            <div className="flex items-start gap-3">
                <span className="size-11 shrink-0 animate-pulse rounded-xl bg-muted" />
                <div className="flex-1 space-y-2 pt-1">
                    <span className="block h-6 w-40 animate-pulse rounded-sm bg-muted" />
                    <span className="block h-4 w-56 animate-pulse rounded-sm bg-muted" />
                </div>
            </div>
            <span className="mt-6 block h-14 animate-pulse rounded-lg bg-muted" />
            <div className="mt-8 space-y-2">
                {[0, 1, 2].map((i) => (
                    <span key={i} className="block h-16 animate-pulse rounded-lg bg-muted" />
                ))}
            </div>
        </div>
    );
}
