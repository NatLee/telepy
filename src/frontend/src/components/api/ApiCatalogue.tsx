"use client";

/**
 * 「token 能打哪些端點」：伺服器的白名單（`GET /api/auth/tokens/routes`）依 scope 分組、可搜尋，預設只列 token 能打的。
 * 每列：方法 + 路徑、需要的 scope、隧道規則、功能開關；展開是填好基底網址的 curl（祕密用 `$TELEPY_TOKEN`）與對應的
 * `telepy` 指令。`browser:use` 那組多一段說明：腳本開的瀏覽器能做什麼、怎麼用（範例腳本）。
 * "What a token can call": the server's allow-list grouped by scope, searchable, token-reachable only by default.
 * Each row: method + path, the scope, the tunnel rule and the feature gate; expanded, a curl with the base URL (the
 * secret as `$TELEPY_TOKEN`) and the `telepy` equivalent. The `browser:use` group explains scripted browsers with an
 * example script.
 */
import React, { useMemo, useState } from "react";
import { ChevronDown, Globe, Search } from "lucide-react";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { Switch } from "@/components/ui/switch";
import { Highlighted } from "@/components/ui/timeline";
import { SCOPE_META, ScopeImpact } from "@/components/oauth/ConnectFlow";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { featureKey } from "@/lib/features";
import { browserScript, cliFor, curlFor, groupCounts, groupRoutes, type ApiRoute, type RouteGroupId, type TunnelRule } from "@/lib/apiCatalogue";
import type { TranslationKey } from "@/locales/en";

const TUNNEL_RULE: Record<TunnelRule, { label: TranslationKey; hint: TranslationKey }> = {
    path: { label: "apiPage.tunnel.path", hint: "apiPage.tunnel.pathHint" },
    handler: { label: "apiPage.tunnel.handler", hint: "apiPage.tunnel.handlerHint" },
    unrestricted: { label: "apiPage.tunnel.unrestricted", hint: "apiPage.tunnel.unrestrictedHint" },
    none: { label: "apiPage.tunnel.none", hint: "apiPage.tunnel.noneHint" },
};

const METHOD_TONE: Record<string, "neutral" | "primary" | "warning" | "danger" | "success"> = { GET: "neutral", POST: "primary", PUT: "warning", PATCH: "warning", DELETE: "danger" };

function MethodChip({ method }: { method: string }) {
    return (
        <Chip mono tone={METHOD_TONE[method] ?? "neutral"} className="w-[3.75rem] justify-center">
            {method}
        </Chip>
    );
}

function RouteRow({ r, baseUrl, query }: { r: ApiRoute; baseUrl: string; query: string }) {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const cli = cliFor(r.method, r.path);
    const fk = r.feature ? featureKey(r.feature) : null;
    return (
        <li>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60">
                <MethodChip method={r.method} />
                <span className="min-w-0 flex-1 font-mono text-[0.8125rem] text-foreground wrap-anywhere">
                    <Highlighted text={r.path} query={query} />
                </span>
                <span className="flex flex-wrap items-center gap-1.5">
                    {r.tunnel && r.tunnel !== "none" && <Chip title={t(TUNNEL_RULE[r.tunnel].hint)}>{t(TUNNEL_RULE[r.tunnel].label)}</Chip>}
                    {fk && fk !== "unknown" && <Chip title={t("apiPage.featureHint")}>{t(`access.f.${fk}` as TranslationKey)}</Chip>}
                    <ChevronDown size={14} className={cn("text-muted-foreground transition-transform", !open && "-rotate-90")} aria-hidden />
                </span>
                {r.summary && (
                    <span className="basis-full pl-[4.375rem] text-xs leading-5 text-muted-foreground">
                        <Highlighted text={r.summary} query={query} />
                    </span>
                )}
            </button>
            {open && (
                <div className="space-y-2 border-t border-border/70 bg-surface px-4 py-3">
                    {r.token ? (
                        <>
                            <CodeBlock language="bash" value={curlFor(r, baseUrl)} />
                            {cli && (
                                <>
                                    <p className="text-xs text-muted-foreground">{t("apiPage.cliEquivalent")}</p>
                                    <CodeBlock language="bash" value={cli} />
                                </>
                            )}
                            {r.tunnel && <p className="text-xs leading-relaxed text-muted-foreground">{t(TUNNEL_RULE[r.tunnel].hint)}</p>}
                        </>
                    ) : (
                        <p className="text-xs leading-relaxed text-muted-foreground">{t("apiPage.webOnlyRow")}</p>
                    )}
                </div>
            )}
        </li>
    );
}

/** 腳本開的瀏覽器：拿來做什麼、怎麼一步一步用。/ Scripted browsers: what they're for and how they're driven. */
function BrowserExplainer({ baseUrl }: { baseUrl: string }) {
    const { t } = useI18n();
    const [kind, setKind] = useState<"curl" | "cli">("curl");
    const script = browserScript(baseUrl);
    return (
        <Callout tone="info" icon={<Globe size={17} className="mt-0.5 shrink-0" aria-hidden />} title={t("apiPage.browser.title")} className="mx-4 my-3">
            <p>{t("apiPage.browser.what")}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
                <li>{t("apiPage.browser.step1")}</li>
                <li>{t("apiPage.browser.step2")}</li>
                <li>{t("apiPage.browser.step3")}</li>
                <li>{t("apiPage.browser.step4")}</li>
            </ol>
            <p className="mt-2">{t("apiPage.browser.limits")}</p>
            <div className="mt-3 space-y-2">
                <Segmented size="sm" aria-label={t("apiPage.browser.example")} value={kind} onChange={setKind} options={[{ value: "curl", label: "curl" }, { value: "cli", label: "telepy" }]} />
                <CodeBlock language="bash" value={kind === "curl" ? script.curl : script.cli} />
            </div>
        </Callout>
    );
}

export function ApiCatalogue({ routes, baseUrl }: { routes: ApiRoute[] | null; baseUrl: string }) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const [tokenOnly, setTokenOnly] = useState(true);
    // 收起來的組（「只能在網頁上用」預設收起）。/ Collapsed groups ("web app only" starts collapsed).
    const [closed, setClosed] = useState<Set<RouteGroupId>>(() => new Set(["web"]));
    const groups = useMemo(() => groupRoutes(routes ?? [], { query, tokenOnly }), [routes, query, tokenOnly]);
    const totals = useMemo(() => groupCounts(routes ?? []), [routes]);
    const reachable = (routes ?? []).filter((r) => r.token).length;
    const shown = groups.reduce((n, g) => n + g.routes.length, 0);
    const searching = query.trim() !== "";
    const toggle = (id: RouteGroupId) =>
        setClosed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const groupTitle = (id: RouteGroupId) => (id === "any" ? t("apiPage.group.any") : id === "web" ? t("apiPage.group.web") : SCOPE_META[id] ? t(SCOPE_META[id].label) : id);
    const groupHint = (id: RouteGroupId) => (id === "any" ? t("apiPage.group.anyHint") : id === "web" ? t("apiPage.group.webHint") : SCOPE_META[id] ? t(SCOPE_META[id].description) : "");

    return (
        <div className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                        <Search size={18} className="text-muted-foreground" />
                    </div>
                    <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("apiPage.searchRoutes")} className="pl-10" aria-label={t("apiPage.searchRoutes")} />
                </div>
                <Switch checked={tokenOnly} onCheckedChange={setTokenOnly} size="sm">
                    {t("apiPage.tokenOnly")}
                </Switch>
            </div>
            {routes && (
                <p className="text-xs text-muted-foreground tabular-nums">
                    {t("apiPage.routeCount", { shown, reachable, total: routes.length })}
                </p>
            )}
            {routes === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : groups.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t("apiPage.noRoutes")}</p>
            ) : (
                groups.map((g) => {
                    // 搜尋時全部展開。/ Searching opens every group.
                    const isOpen = searching || !closed.has(g.id);
                    return (
                        <section key={g.id} className="overflow-clip rounded-xl border border-border bg-card" aria-label={groupTitle(g.id)}>
                            <button type="button" onClick={() => toggle(g.id)} aria-expanded={isOpen} className="flex w-full items-start gap-3 px-4 py-3 text-left">
                                <ChevronDown size={16} className={cn("mt-0.5 shrink-0 text-muted-foreground transition-transform", !isOpen && "-rotate-90")} aria-hidden />
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                                        {groupTitle(g.id)}
                                        {g.id !== "any" && g.id !== "web" && <Chip mono>{g.id}</Chip>}
                                        {g.id !== "any" && g.id !== "web" && <ScopeImpact scope={g.id} />}
                                        <span className="text-xs text-muted-foreground tabular-nums">{searching ? `${g.routes.length} / ${totals[g.id]}` : totals[g.id]}</span>
                                    </span>
                                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{groupHint(g.id)}</span>
                                </span>
                            </button>
                            {isOpen && (
                                <div className="border-t border-border">
                                    {g.id === "browser:use" && <BrowserExplainer baseUrl={baseUrl} />}
                                    <ul className="divide-y divide-border/70">
                                        {g.routes.map((r) => (
                                            <RouteRow key={`${r.method} ${r.path}`} r={r} baseUrl={baseUrl} query={query} />
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </section>
                    );
                })
            )}
        </div>
    );
}
