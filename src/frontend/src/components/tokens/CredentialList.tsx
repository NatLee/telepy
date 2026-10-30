"use client";

/**
 * API 頁兩種憑證（API token、CLI 登入）共用的清單 / 卡片版面。呼叫端把每一筆整理成 `CredentialItem`（名稱與下面那行、權限、
 * 隧道、使用與到期、呼叫摘要、動作），這裡只負責排：清單 = 容器夠寬（`@3xl`）時是有欄位標題的表格、窄的時候每列疊成
 * 幾行；卡片 = 1 / 2 / 3 欄。選哪種跟著帳號走（`view_modes.api_tokens` / `view_modes.cli_signins`，偏好設定 → 外觀
 * 也看得到），預設清單。已撤銷 / 到期的整列變淡。
 * 少用籤：權限是固定順序的一排圖示（有的實心、沒有的淡掉）+ 一句摘要，每列同一格比得出來；狀態是點 + 字，跟祕密開頭
 * 一起放在名稱下面安靜的一行；開著的 session、「下一個被登出」是有顏色的字。真的需要一眼看見的才上色。
 * The list / card layout shared by the API page's two credentials (API tokens, CLI sign-ins). Callers turn each one
 * into a `CredentialItem` (name, the line under it, scopes, tunnels, use and expiry, call summary, actions); this only lays them
 * out: the list is a table with column titles from a wide container (`@3xl`) and stacked lines when narrow, cards are
 * 1 / 2 / 3 columns. The choice follows the account (`view_modes.api_tokens` / `view_modes.cli_signins`, also in
 * Preferences → Appearance), list by default. Revoked / expired rows are dimmed.
 * Few chips: scopes are a fixed-order strip of icons (held = solid, missing = faint) plus one phrase, so rows compare
 * slot by slot; the state is a dot + text on a quiet line under the name with the secret prefix; open sessions and
 * "next to be signed out" are coloured text. Colour only for what needs to be seen at a glance.
 */
import React from "react";
import { Activity, CalendarClock, Clock3, ListTree, Network, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SCOPE_META } from "@/components/oauth/ConnectFlow";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { ViewMode } from "@/lib/viewModes";
import { scopeSummary, type ApiToken } from "@/lib/apiTokens";
import { cn } from "@/lib/utils";

export interface CredentialItem {
    id: number;
    icon: React.ReactNode;
    name: string;
    /** 點名稱（例如打開說明圖）；沒有就只是文字。/ Clicking the name (e.g. the explainer); plain text without it. */
    onOpen?: () => void;
    openLabel?: string;
    /** 名稱下面那行：祕密開頭（等寬）、狀態點、其他提醒。/ The line under the name: secret prefix (mono), state dot, notes. */
    prefix?: string;
    prefixTitle?: string;
    status?: { text: string; tone: "success" | "warning" | "muted" };
    notes?: { text: string; tone: "primary" | "warning" }[];
    /** 已撤銷 / 到期：整列變淡。/ Revoked / expired: the row is dimmed. */
    dim?: boolean;
    scopes: string[];
    /** 這種憑證可能有的全部 scope（圖示排的格子）。/ Every scope this kind can hold (the strip's slots). */
    slots: readonly string[];
    tunnels: string;
    /** 最後使用（null = 從沒用過）與它的來源 IP。/ Last use (null = never) and its source IP. */
    lastUsedAt: string | null;
    lastUsedIp?: string | null;
    neverUsed: string;
    /** 到期那一行：文字 + 顏色。/ The expiry line: text and tone. */
    expiry: { text: string; title?: string; tone?: "warning" | "danger" | "muted" } | null;
    /** 額外一行（例如「登入於 …」）。/ An extra line (e.g. "signed in …"). */
    extra?: string;
    calls: ApiToken["calls"] | null | undefined;
    onCalls?: () => void;
    onRemove?: () => void;
    removeLabel: string;
}

const COLS = "minmax(0,1.7fr) minmax(0,1.2fr) minmax(0,1fr) minmax(0,1.1fr) minmax(0,1fr) auto";

const TONE = { warning: "text-warning", danger: "text-destructive", muted: "text-muted-foreground" } as const;

const DOT = { success: "bg-success", warning: "bg-warning", muted: "bg-muted-foreground/50" } as const;
const NOTE = { primary: "text-primary", warning: "text-warning" } as const;

/** 權限一句話：全部 / 只讀 / 幾項中的幾項。/ The scopes in one phrase. */
function useScopePhrase() {
    const { t } = useI18n();
    return (item: CredentialItem) => {
        const sum = scopeSummary(item.scopes, item.slots);
        return sum.kind === "all" ? t("tokens.list.scopesAll") : sum.kind === "readOnly" ? t("tokens.list.scopesReadOnly") : t("tokens.list.scopesSome", { count: sum.count, total: sum.total });
    };
}

/**
 * 權限圖示排：每個可能的 scope 一格、順序固定，有的實心、沒有的淡掉；滑過看名稱。每列同一格對得起來，不用讀一排籤。
 * The scope strip: one slot per possible scope in a fixed order, held = solid, missing = faint; hover for the name.
 * Rows line up slot by slot instead of reading a row of chips.
 */
function ScopeStrip({ item, className, stack = false }: { item: CredentialItem; className?: string; stack?: boolean }) {
    const { t } = useI18n();
    const phrase = useScopePhrase();
    const label = (s: string) => (SCOPE_META[s] ? t(SCOPE_META[s].label) : s);
    const held = item.slots.filter((s) => item.scopes.includes(s));
    return (
        // 表格裡摘要永遠在圖示下一行，每列一樣高低。/ In the table the phrase always sits under the icons, the same in every row.
        <span className={cn("flex min-w-0 gap-x-2 gap-y-1", stack ? "flex-col items-start" : "flex-wrap items-center", className)}>
            <span className="inline-flex shrink-0 items-center gap-0.5" role="img" aria-label={t("tokens.list.scopesAria", { list: held.map(label).join(", ") || "—" })}>
                {item.slots.map((s) => {
                    const Icon = SCOPE_META[s]?.Icon;
                    const on = item.scopes.includes(s);
                    return (
                        <span
                            key={s}
                            title={`${label(s)}${on ? "" : ` (${t("tokens.list.scopeMissing")})`}`}
                            className={cn(
                                "grid size-[1.375rem] place-items-center rounded-sm [&>svg]:size-3.5",
                                on ? (item.dim ? "bg-muted text-muted-foreground" : "bg-muted text-foreground/85") : "text-muted-foreground/30"
                            )}
                        >
                            {Icon ? <Icon aria-hidden /> : null}
                        </span>
                    );
                })}
            </span>
            <span className="text-xs text-muted-foreground">{phrase(item)}</span>
        </span>
    );
}

/** 卡片上：有的權限一項一行（圖示 + 字，不是籤）。/ On cards: each held scope as icon + text (not chips). */
function ScopeLines({ item }: { item: CredentialItem }) {
    const { t } = useI18n();
    const held = item.slots.filter((s) => item.scopes.includes(s)).concat(item.scopes.filter((s) => !item.slots.includes(s)));
    return (
        <ul className="grid gap-x-3 gap-y-0.5 @xs:grid-cols-2">
            {held.map((s) => {
                const Icon = SCOPE_META[s]?.Icon;
                return (
                    <li key={s} className="flex min-w-0 items-start gap-1.5 text-xs text-foreground/85">
                        {Icon && <Icon size={12} className="mt-[0.1875rem] shrink-0 text-muted-foreground" aria-hidden />}
                        <span className="min-w-0 [overflow-wrap:anywhere]">{SCOPE_META[s] ? t(SCOPE_META[s].label) : s}</span>
                    </li>
                );
            })}
        </ul>
    );
}

/** 名稱下面安靜的一行：祕密開頭 · ● 狀態 · 提醒。/ The quiet line under the name: prefix · ● state · notes. */
function SubLine({ item, className }: { item: CredentialItem; className?: string }) {
    const parts: React.ReactNode[] = [];
    if (item.prefix)
        parts.push(
            <span key="p" className="font-mono" title={item.prefixTitle}>
                {item.prefix}
            </span>
        );
    if (item.status)
        parts.push(
            <span key="s" className={cn("inline-flex items-center gap-1.5", item.status.tone === "warning" ? "text-warning" : item.status.tone === "success" ? "text-foreground/80" : undefined)}>
                <span className={cn("size-1.5 shrink-0 rounded-full", DOT[item.status.tone])} aria-hidden />
                {item.status.text}
            </span>
        );
    for (const [i, n] of (item.notes ?? []).entries())
        parts.push(
            <span key={`n${i}`} className={NOTE[n.tone]}>
                {n.text}
            </span>
        );
    if (!parts.length) return null;
    return (
        <p className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.75rem] text-muted-foreground", className)}>
            {parts.map((p, i) => (
                <React.Fragment key={i}>
                    {i > 0 && (
                        <span aria-hidden className="text-muted-foreground/50">
                            ·
                        </span>
                    )}
                    {p}
                </React.Fragment>
            ))}
        </p>
    );
}

function LastUsed({ item, withIp = false }: { item: CredentialItem; withIp?: boolean }) {
    const { t, locale } = useI18n();
    if (!item.lastUsedAt) return <span className="text-muted-foreground">{item.neverUsed}</span>;
    const full = new Date(item.lastUsedAt).toLocaleString(locale) + (item.lastUsedIp ? ` · ${item.lastUsedIp}` : "");
    return (
        <span title={full}>
            {t("tokens.list.used", { when: formatRelativeTime(item.lastUsedAt, locale) })}
            {withIp && item.lastUsedIp && <span className="block font-mono text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere]">{item.lastUsedIp}</span>}
        </span>
    );
}

function Expiry({ item }: { item: CredentialItem }) {
    if (!item.expiry) return null;
    return (
        <span title={item.expiry.title} className={item.expiry.tone ? TONE[item.expiry.tone] : "text-foreground/85"}>
            {item.expiry.text}
        </span>
    );
}

/** 「24 小時 3 · 7 天 12」，有錯誤時多一行警告。/ "3 in 24 h · 12 in 7 days", plus a warning line on errors. */
function Calls({ item, stacked = false }: { item: CredentialItem; stacked?: boolean }) {
    const { t } = useI18n();
    const c = item.calls;
    if (!c || c.calls_7d === 0) return <span className="text-muted-foreground">{t("tokens.list.noCalls")}</span>;
    return (
        <span className="tabular-nums">
            <span className={stacked ? "block" : undefined}>{t("tokens.list.calls24h", { count: c.calls_24h })}</span>
            {!stacked && " · "}
            <span className={stacked ? "block text-muted-foreground" : undefined}>{t("tokens.list.calls7d", { count: c.calls_7d })}</span>
            {/* 表格欄窄、上一行已經說了 7 天，錯誤用短句。/ The table column is narrow and the line above says 7 days: a short phrase. */}
            {c.errors_7d > 0 && (
                <span className="block text-warning" title={t("tokens.callErrors", { count: c.errors_7d })}>
                    {stacked ? t("tokens.list.errors", { count: c.errors_7d }) : t("tokens.callErrors", { count: c.errors_7d })}
                </span>
            )}
        </span>
    );
}

function Name({ item }: { item: CredentialItem }) {
    const cls = cn("min-w-0 text-left text-[0.9375rem] [overflow-wrap:anywhere]", item.dim ? "text-muted-foreground" : "text-foreground");
    if (!item.onOpen) return <span className={cls}>{item.name}</span>;
    return (
        <button
            type="button"
            onClick={item.onOpen}
            aria-label={item.openLabel}
            className={cn(cls, "rounded-sm hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60")}
        >
            {item.name}
        </button>
    );
}

function Actions({ item, labelled = false, className }: { item: CredentialItem; labelled?: boolean; className?: string }) {
    const { t } = useI18n();
    return (
        <div className={cn("flex shrink-0 items-center gap-0.5", className)}>
            {item.onCalls &&
                (labelled ? (
                    <Button type="button" variant="outline" size="sm" className="h-7 gap-1" onClick={item.onCalls}>
                        <ListTree size={13} /> {t("tokens.showCalls")}
                    </Button>
                ) : (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={item.onCalls}
                        className="text-muted-foreground hover:text-primary"
                        aria-label={t("tokens.list.callsAria", { name: item.name })}
                        title={t("tokens.showCalls")}
                    >
                        <ListTree />
                    </Button>
                ))}
            {item.onRemove && (
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={item.onRemove}
                    className="text-muted-foreground hover:bg-destructive/8 hover:text-destructive"
                    aria-label={`${item.removeLabel}: ${item.name}`}
                    title={item.removeLabel}
                >
                    <Trash2 />
                </Button>
            )}
        </div>
    );
}

function IconTile({ item }: { item: CredentialItem }) {
    return (
        <span
            className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg [&>svg]:size-[0.9375rem]", item.dim ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}
            aria-hidden
        >
            {item.icon}
        </span>
    );
}

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <span className="inline-flex min-w-0 items-start gap-1 [&>svg]:mt-[0.1875rem] [&>svg]:size-3 [&>svg]:shrink-0">
            {icon}
            <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        </span>
    );
}

function Row({ item }: { item: CredentialItem }) {
    return (
        <li className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-2.5 @3xl:grid-cols-(--cred-cols) @3xl:px-4", item.dim && "bg-surface/50")}>
            <div className="flex min-w-0 items-start gap-3">
                <IconTile item={item} />
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="min-w-0 leading-snug">
                        <Name item={item} />
                    </p>
                    <SubLine item={item} />
                    {item.extra && <p className="hidden text-[0.75rem] text-muted-foreground @3xl:block">{item.extra}</p>}
                    {/* 窄：權限圖示排與一行摘要（寬的時候各有欄位）。/ Narrow: the scope strip and a summary line (columns when wide). */}
                    <ScopeStrip item={item} className="@3xl:hidden" />
                    <p className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-0.5 text-[0.75rem] text-muted-foreground @3xl:hidden">
                        <Meta icon={<Network />}>{item.tunnels}</Meta>
                        <Meta icon={<Clock3 />}>
                            <LastUsed item={item} />
                        </Meta>
                        {item.expiry && (
                            <Meta icon={<CalendarClock />}>
                                <Expiry item={item} />
                            </Meta>
                        )}
                        {item.calls && item.calls.calls_7d > 0 && (
                            <Meta icon={<Activity />}>
                                <Calls item={item} />
                            </Meta>
                        )}
                    </p>
                </div>
            </div>
            <ScopeStrip item={item} stack className="hidden self-start @3xl:flex" />
            <p className="hidden min-w-0 text-xs text-foreground/85 [overflow-wrap:anywhere] @3xl:line-clamp-3" title={item.tunnels}>
                {item.tunnels}
            </p>
            <div className="hidden min-w-0 space-y-0.5 text-xs @3xl:block">
                <p className="text-foreground/85">
                    <LastUsed item={item} />
                </p>
                {item.expiry && (
                    <p>
                        <Expiry item={item} />
                    </p>
                )}
            </div>
            <div className="hidden min-w-0 text-xs @3xl:block">
                <Calls item={item} stacked />
            </div>
            {/* 固定寬度：每列按鈕數不同（撤銷過的沒有垃圾桶），auto 欄會各自變寬，欄位就對不齊。
                Fixed width: rows have different buttons (a revoked one has no bin), and an auto column would drift. */}
            <Actions item={item} className="justify-end @3xl:w-[4.125rem]" />
        </li>
    );
}

function Field({ icon, label, children, className }: { icon: React.ReactNode; label: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("min-w-0", className)}>
            <dt className="flex items-center gap-1 text-[0.75rem] text-muted-foreground [&>svg]:size-3 [&>svg]:shrink-0">
                {icon}
                {label}
            </dt>
            <dd className="mt-0.5 min-w-0 text-xs text-foreground/85 [overflow-wrap:anywhere]">{children}</dd>
        </div>
    );
}

function Card({ item, nameHeader }: { item: CredentialItem; nameHeader: string }) {
    const { t } = useI18n();
    const phrase = useScopePhrase();
    return (
        <article aria-label={`${nameHeader}: ${item.name}`} className={cn("@container flex min-w-0 flex-col rounded-xl border border-border bg-card shadow-card", item.dim && "bg-surface/60")}>
            <header className="flex items-start gap-3 px-4 pt-3.5">
                <IconTile item={item} />
                <div className="min-w-0 flex-1">
                    <h3 className="min-w-0 leading-snug">
                        <Name item={item} />
                    </h3>
                    <SubLine item={item} className="mt-1" />
                    {item.extra && <p className="mt-0.5 text-[0.75rem] text-muted-foreground">{item.extra}</p>}
                </div>
                <div className="-mr-1.5 -mt-0.5">
                    <Actions item={{ ...item, onCalls: undefined }} />
                </div>
            </header>
            <dl className="mt-3 grid flex-1 grid-cols-2 content-start gap-x-4 gap-y-2.5 border-t border-border px-4 pb-3.5 pt-3">
                {/* 卡片有空間：有的權限一項一行就好，摘要放在標題旁。/ Cards have room: one line per held scope, the phrase beside the title. */}
                <Field icon={<ShieldCheck />} label={`${t("tokens.list.colScopes")} · ${phrase(item)}`} className="col-span-2">
                    <ScopeLines item={item} />
                </Field>
                <Field icon={<Network />} label={t("tokens.list.colTunnels")} className="col-span-2">
                    {item.tunnels}
                </Field>
                <Field icon={<Clock3 />} label={t("tokens.list.colUsed")}>
                    <LastUsed item={item} withIp />
                </Field>
                <Field icon={<CalendarClock />} label={t("tokens.list.colEnds")}>
                    {item.expiry ? <Expiry item={item} /> : <span className="text-muted-foreground">—</span>}
                </Field>
                <Field icon={<Activity />} label={t("tokens.list.colCalls")} className="col-span-2">
                    <span className="flex flex-wrap items-end justify-between gap-2">
                        <Calls item={item} />
                        {item.onCalls && <Actions item={{ ...item, onRemove: undefined }} labelled />}
                    </span>
                </Field>
            </dl>
        </article>
    );
}

export function CredentialList({ items, view, nameHeader }: { items: CredentialItem[]; view: ViewMode; nameHeader: string }) {
    const { t } = useI18n();
    if (view === "card") {
        return (
            <div className="@container">
                <div data-refresh-list className="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
                    {items.map((item) => (
                        <Card key={item.id} item={item} nameHeader={nameHeader} />
                    ))}
                </div>
            </div>
        );
    }
    return (
        <div className="@container overflow-hidden rounded-xl border border-border bg-card shadow-card" style={{ "--cred-cols": COLS } as React.CSSProperties}>
            {/* 欄位標題只在表格排版時出現。/ Column titles only in the table layout. */}
            <div className="hidden grid-cols-(--cred-cols) gap-x-3 border-b border-border bg-surface px-4 py-2 text-xs text-muted-foreground @3xl:grid" aria-hidden>
                <span className="pl-11">{nameHeader}</span>
                <span>{t("tokens.list.colScopes")}</span>
                <span>{t("tokens.list.colTunnels")}</span>
                <span>{t("tokens.list.colUseEnds")}</span>
                <span>{t("tokens.list.colCalls")}</span>
                <span className="w-[4.125rem]" />
            </div>
            <ul data-refresh-list className="divide-y divide-border/70">
                {items.map((item) => (
                    <Row key={item.id} item={item} />
                ))}
            </ul>
        </div>
    );
}
