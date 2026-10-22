"use client";

/**
 * 指令速查頁：選一條隧道，挑一個情境（-L / -D / -R / -J / scp），填埠號，就拿到能直接貼上的 SSH 指令，
 * 並以流程圖畫出流量怎麼走。選定的隧道在 URL（?tunnel=<id>），隧道列表的「埠轉發」會深連結過來。
 * Command sheet: pick a tunnel and a recipe (-L / -D / -R / -J / scp), fill in ports, and get a paste-ready SSH
 * command plus a diagram of where the traffic goes. The tunnel lives in the URL (?tunnel=<id>) so the tunnel list's
 * "Port forwarding" action deep-links here.
 */
import React, { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    CheckCircle2,
    CircleDashed,
    FolderSync,
    Globe,
    Lightbulb,
    ListChecks,
    MonitorDown,
    MonitorUp,
    Plus,
    Route,
    Router,
    SquareTerminal,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { FlowDiagram } from "@/components/cheatsheet/FlowDiagram";
import { CommandLegend, CommandLine, InlineCommand, MiniCommand } from "@/components/cheatsheet/CommandView";
import { recipeFlow } from "@/components/cheatsheet/recipeFlow";
import { useCheatsheetPage } from "@/hooks/useCheatsheetPage";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
    LOCAL_PRESETS,
    RECIPES,
    RECIPE_BY_ID,
    buildSegments,
    forwardSpec,
    isValidHost,
    isValidPort,
    resolveParams,
    shellSegments,
    type ConnectMode,
    type FieldDef,
    type ForwardOptions,
    type RecipeId,
    type RecipeParams,
} from "@/lib/forwardRecipes";

const RECIPE_ICONS: Record<RecipeId, LucideIcon> = {
    local: MonitorDown,
    lan: Router,
    socks: Globe,
    remote: MonitorUp,
    jump: Route,
    copy: FolderSync,
};

const CARD = "rounded-2xl border border-border bg-card/85 backdrop-blur-sm shadow-card";

function Prereq({ ok, title, children }: { ok: boolean | null; title: string; children: React.ReactNode }) {
    const Icon = ok === null ? CircleDashed : ok ? CheckCircle2 : AlertTriangle;
    return (
        <div
            className={cn(
                "flex gap-3 rounded-xl border p-3",
                ok === null && "border-border bg-muted/30",
                ok === true && "border-emerald-500/25 bg-emerald-500/[0.06]",
                ok === false && "border-amber-500/35 bg-amber-500/[0.07]"
            )}
        >
            <Icon
                size={18}
                className={cn("mt-0.5 shrink-0", ok === null ? "text-muted-foreground" : ok ? "text-emerald-500" : "text-amber-500")}
                aria-hidden
            />
            <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{title}</p>
                <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{children}</div>
            </div>
        </div>
    );
}

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    ariaLabel: string;
}) {
    return (
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label={ariaLabel}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={value === o.value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "h-8 rounded-md px-3 text-xs font-medium transition-colors whitespace-nowrap",
                        value === o.value ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}

function FieldInput({ field, value, onChange }: { field: FieldDef; value: string; onChange: (v: string) => void }) {
    const { t } = useI18n();
    if (field.kind === "choice") {
        return (
            <div className="space-y-1.5">
                <span className="block text-xs font-medium text-foreground">{t(field.label)}</span>
                <Segmented
                    value={value}
                    options={(field.choices ?? []).map((c) => ({ value: c.value, label: t(c.label) }))}
                    onChange={onChange}
                    ariaLabel={t(field.label)}
                />
            </div>
        );
    }
    const trimmed = value.trim();
    const invalidPort = field.kind === "port" && trimmed !== "" && !isValidPort(trimmed);
    const invalidHost = field.key === "lanHost" && trimmed !== "" && !isValidHost(trimmed);
    const invalid = invalidPort || invalidHost;
    return (
        <label className="block space-y-1.5">
            <span className="block text-xs font-medium text-foreground">{t(field.label)}</span>
            <Input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                inputMode={field.kind === "port" ? "numeric" : undefined}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={invalid || undefined}
                className={cn("h-9 font-mono text-sm", invalid && "border-destructive focus-visible:ring-destructive/30")}
            />
            {invalid && (
                <span className="block text-[11px] text-destructive">
                    {invalidPort ? t("sheet.field.invalidPort") : t("sheet.field.invalidHost")}
                </span>
            )}
        </label>
    );
}

function OptionToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-left text-xs text-foreground hover:bg-muted/50"
        >
            <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-primary" : "bg-muted-foreground/30")} aria-hidden>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
            </span>
            {label}
        </button>
    );
}

function CheatsheetInner() {
    const { t, tn } = useI18n();
    const { state, actions } = useCheatsheetPage();
    const { tunnels, loadingTunnels, portsMap, selected, online, keyCount, config, usernameId, hasTargetUser, target, mode } = state;

    const [recipe, setRecipe] = useState<RecipeId>("local");
    const [paramsById, setParamsById] = useState<Record<RecipeId, RecipeParams>>(
        () => Object.fromEntries(RECIPES.map((r) => [r.id, { ...r.defaults }])) as Record<RecipeId, RecipeParams>
    );
    const [options, setOptions] = useState<ForwardOptions>({ background: false, keepAlive: false, exitOnFailure: false });
    const [showConfig, setShowConfig] = useState(false);

    const def = RECIPE_BY_ID[recipe];
    const params = paramsById[recipe];
    const resolved = resolveParams(recipe, params);
    const setParam = (key: string, value: string) =>
        setParamsById((prev) => ({ ...prev, [recipe]: { ...prev[recipe], [key]: value } }));

    const segments = useMemo(() => (target ? buildSegments(recipe, params, target, options) : []), [recipe, params, target, options]);
    const flow = useMemo(() => (target ? recipeFlow(recipe, params, target, t) : null), [recipe, params, target, t]);

    if (loadingTunnels) {
        return (
            <div className="flex flex-col items-center justify-center p-16 text-muted-foreground">
                <div className="mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                {t("common.loading")}
            </div>
        );
    }

    const header = (
        <div className="flex items-start gap-4">
            <div className="hidden sm:grid place-items-center w-12 h-12 rounded-2xl bg-brand-gradient shadow-glow shrink-0" aria-hidden>
                <SquareTerminal className="text-white" size={22} />
            </div>
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">{t("sheet.title")}</h1>
                <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("sheet.subtitle")}</p>
            </div>
        </div>
    );

    if (tunnels.length === 0) {
        return (
            <div className="space-y-6 animate-fade-in-up">
                {header}
                <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card/70 p-16 text-center">
                    <SquareTerminal size={40} className="mb-4 text-muted-foreground/60" aria-hidden />
                    <h3 className="text-xl font-semibold tracking-tight text-foreground">{t("sheet.emptyTitle")}</h3>
                    <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("sheet.emptyBody")}</p>
                    <Button asChild className="mt-6 shadow-glow">
                        <Link href="/tunnels/create" prefetch={false}>
                            <Plus size={16} />
                            {t("tunnels.create")}
                        </Link>
                    </Button>
                </div>
            </div>
        );
    }

    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground">{s}</code>;
    const spec = forwardSpec(recipe, params);

    const usage = (() => {
        switch (recipe) {
            case "local":
                return <p>{tn("sheet.use.local", { addr: code(`localhost:${resolved.localPort}`), url: code(`${resolved.remotePort === "443" ? "https" : "http"}://localhost:${resolved.localPort}`) })}</p>;
            case "lan":
                return <p>{tn("sheet.use.lan", { addr: code(`localhost:${resolved.localPort}`), target: code(`${resolved.lanHost}:${resolved.lanPort}`) })}</p>;
            case "socks":
                return (
                    <>
                        <p>{tn("sheet.use.socks", { addr: code(`localhost:${resolved.localPort}`) })}</p>
                        <MiniCommand command={`curl --socks5-hostname localhost:${resolved.localPort} https://ifconfig.me`} />
                    </>
                );
            case "remote":
                return (
                    <>
                        <p>{tn("sheet.use.remote", { addr: code(`localhost:${resolved.devicePort}`) })}</p>
                        <MiniCommand command={`curl http://localhost:${resolved.devicePort}`} />
                    </>
                );
            case "jump":
                return <p>{tn("sheet.use.jump", { target: code(`${resolved.lanUser}@${resolved.lanHost}`) })}</p>;
            case "copy":
                return <p>{t("sheet.use.copy")}</p>;
        }
    })();

    const refRows = target
        ? [
            { label: t("sheet.ref.shell"), segments: shellSegments(target) },
            { label: t("sheet.ref.exec"), segments: shellSegments(target, "uptime") },
            ...RECIPES.map((r) => ({ label: t(r.title), segments: buildSegments(r.id, paramsById[r.id], target, options) })),
        ]
        : [];

    const RecipeIcon = RECIPE_ICONS[recipe];

    return (
        <div className="space-y-6 animate-fade-in-up">
            {header}

            {/* ── 1. 連線對象與前置條件 / Target + prerequisites ── */}
            <section className={cn(CARD, "p-4 sm:p-5 space-y-4")}>
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] lg:items-end">
                    <div className="space-y-1.5 min-w-0">
                        <span className="block text-xs font-medium text-foreground">{t("sheet.tunnel")}</span>
                        <Select value={selected ? String(selected.id) : ""} onValueChange={(v) => actions.setTunnel(Number(v))}>
                            <SelectTrigger className="h-10 w-full text-sm" aria-label={t("sheet.tunnel")}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {tunnels.map((tn) => (
                                    <SelectItem key={tn.id} value={String(tn.id)}>
                                        <span className="flex items-center gap-2">
                                            <StatusDot online={portsMap[String(tn.reverse_port)] === true} />
                                            <span className="truncate">{tn.host_friendly_name}</span>
                                            <span className="font-mono text-xs text-muted-foreground">:{tn.reverse_port}</span>
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="space-y-1.5 min-w-0">
                        <span className="block text-xs font-medium text-foreground">{t("sheet.targetUser")}</span>
                        {config && config.usernames.length > 1 ? (
                            <Select value={usernameId !== null ? String(usernameId) : ""} onValueChange={(v) => actions.setUsernameId(Number(v))}>
                                <SelectTrigger className="h-10 w-full text-sm font-mono" aria-label={t("sheet.targetUser")}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {config.usernames.map((u) => (
                                        <SelectItem key={u.id} value={String(u.id)} className="font-mono">{u.username}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <div className="flex h-10 items-center rounded-md border border-input bg-muted/40 px-3 font-mono text-sm text-foreground">
                                {target?.username ?? "—"}
                            </div>
                        )}
                    </div>
                    <div className="space-y-1.5">
                        <span className="block text-xs font-medium text-foreground">{t("sheet.modeLabel")}</span>
                        <Segmented<ConnectMode>
                            value={mode}
                            onChange={actions.setMode}
                            ariaLabel={t("sheet.modeLabel")}
                            options={[
                                { value: "alias", label: t("sheet.modeAlias") },
                                { value: "direct", label: t("sheet.modeDirect") },
                            ]}
                        />
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">
                    {mode === "alias"
                        ? tn("sheet.modeAliasHint", { alias: code(target?.alias ?? "") })
                        : t("sheet.modeDirectHint")}
                </p>

                {config && !hasTargetUser && (
                    <div className="flex items-start gap-2 rounded-xl border border-amber-500/35 bg-amber-500/[0.07] p-3 text-xs text-amber-800 dark:text-amber-200">
                        <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                        <span>{t("sheet.noTargetUser")}</span>
                    </div>
                )}

                <div>
                    <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        <ListChecks size={14} aria-hidden /> {t("sheet.prereqTitle")}
                    </p>
                    <div className="grid gap-3 md:grid-cols-3">
                        <Prereq ok={keyCount === null ? null : keyCount > 0} title={t("sheet.prereq.key")}>
                            {keyCount !== null && keyCount > 0 ? (
                                t("sheet.prereq.keyOk", { count: keyCount })
                            ) : (
                                <>
                                    {t("sheet.prereq.keyMissing")}{" "}
                                    <Link href="/tunnels/keys" prefetch={false} className="font-medium text-primary hover:underline">
                                        {t("sheet.prereq.keyAction")}
                                    </Link>
                                </>
                            )}
                        </Prereq>
                        <Prereq ok={mode === "direct" ? true : null} title={t("sheet.prereq.config")}>
                            {mode === "direct" ? (
                                t("sheet.prereq.configNotNeeded")
                            ) : (
                                <>
                                    {tn("sheet.prereq.configTodo", { alias: code(target?.alias ?? "") })}{" "}
                                    <button type="button" onClick={() => setShowConfig((v) => !v)} className="font-medium text-primary hover:underline">
                                        {showConfig ? t("sheet.prereq.configHide") : t("sheet.prereq.configShow")}
                                    </button>
                                </>
                            )}
                        </Prereq>
                        <Prereq ok={online} title={t("sheet.prereq.device")}>
                            {online ? t("sheet.prereq.deviceOnline") : t("sheet.prereq.deviceOffline")}
                        </Prereq>
                    </div>
                </div>

                {mode === "alias" && showConfig && config && (
                    <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">{tn("sheet.configPathHint", { path: code("~/.ssh/config") })}</p>
                        <div className="max-h-72 overflow-auto rounded-md">
                            <CodeBlock language="txt" value={config.config} />
                        </div>
                    </div>
                )}
            </section>

            {/* ── 2. 情境 / Recipes ── */}
            <section className="space-y-3">
                <h2 className="text-sm font-semibold text-foreground">{t("sheet.pickRecipe")}</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
                    {RECIPES.map((r) => {
                        const Icon = RECIPE_ICONS[r.id];
                        const active = r.id === recipe;
                        return (
                            <button
                                key={r.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setRecipe(r.id)}
                                className={cn(
                                    "group flex flex-col gap-2 rounded-2xl border p-3.5 text-left shadow-card backdrop-blur-sm transition-all duration-200",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    active
                                        ? "border-transparent bg-primary/[0.07] ring-2 ring-primary/60"
                                        : "border-border bg-card/85 hover:-translate-y-px hover:border-primary/30"
                                )}
                            >
                                <span className="flex items-center justify-between gap-2">
                                    <span className={cn("grid size-9 place-items-center rounded-xl", active ? "bg-brand-gradient text-white shadow-glow" : "bg-primary/10 text-primary")} aria-hidden>
                                        <Icon size={18} />
                                    </span>
                                    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{r.flag}</code>
                                </span>
                                <span className="text-sm font-semibold leading-tight text-foreground">{t(r.title)}</span>
                                <span className="text-xs leading-snug text-muted-foreground">{t(r.hint)}</span>
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* ── 3. 情境細節：流程圖 + 參數 + 指令 / Recipe detail: diagram + inputs + command ── */}
            {target && flow && (
                <section className={cn(CARD, "overflow-hidden")}>
                    <div className="flex items-start gap-3 border-b border-border bg-muted/20 p-4 sm:p-5">
                        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-gradient text-white shadow-glow" aria-hidden>
                            <RecipeIcon size={20} />
                        </span>
                        <div className="min-w-0">
                            <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight text-foreground">
                                {t(def.title)}
                                <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{def.flag}</code>
                            </h2>
                            <p className="mt-1 text-sm text-muted-foreground">{t(def.description)}</p>
                        </div>
                    </div>

                    <div className="space-y-6 p-4 sm:p-5">
                        <FlowDiagram nodes={flow.nodes} links={flow.links} />

                        <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                            <div className="space-y-5">
                                <div className="grid gap-4 sm:grid-cols-2">
                                    {def.fields.map((f) => (
                                        <div key={f.key} className={cn(f.kind !== "port" && f.kind !== "choice" && "sm:col-span-2")}>
                                            <FieldInput field={f} value={params[f.key] ?? ""} onChange={(v) => setParam(f.key, v)} />
                                        </div>
                                    ))}
                                </div>

                                {recipe === "local" && (
                                    <div className="space-y-2">
                                        <span className="block text-xs font-medium text-foreground">{t("sheet.presets")}</span>
                                        <div className="flex flex-wrap gap-1.5">
                                            {LOCAL_PRESETS.map((p) => {
                                                const active = resolved.remotePort === p.remotePort && resolved.localPort === p.localPort;
                                                return (
                                                    <button
                                                        key={p.label}
                                                        type="button"
                                                        aria-pressed={active}
                                                        onClick={() => setParamsById((prev) => ({ ...prev, local: { remotePort: p.remotePort, localPort: p.localPort } }))}
                                                        className={cn(
                                                            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                                                            active ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-background/60 text-muted-foreground hover:border-primary/30 hover:text-foreground"
                                                        )}
                                                    >
                                                        {p.label}
                                                        <span className="font-mono text-[10px] opacity-70">{p.remotePort}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}

                                {def.forwarding && (
                                    <div className="space-y-1">
                                        <span className="block text-xs font-medium text-foreground">{t("sheet.options")}</span>
                                        <div className="flex flex-col">
                                            <OptionToggle checked={options.background} label={t("sheet.opt.background")} onChange={(v) => setOptions((o) => ({ ...o, background: v }))} />
                                            <OptionToggle checked={options.keepAlive} label={t("sheet.opt.keepAlive")} onChange={(v) => setOptions((o) => ({ ...o, keepAlive: v }))} />
                                            <OptionToggle checked={options.exitOnFailure} label={t("sheet.opt.exitOnFailure")} onChange={(v) => setOptions((o) => ({ ...o, exitOnFailure: v }))} />
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="space-y-4 min-w-0">
                                <div className="space-y-2">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("sheet.command")}</span>
                                        <span className="hidden sm:inline text-[11px] text-muted-foreground/80">{t("sheet.hoverHint")}</span>
                                    </div>
                                    <CommandLine segments={segments} title={target.alias} />
                                </div>

                                <div className="space-y-2 text-sm text-muted-foreground">
                                    <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("sheet.howToUse")}</span>
                                    {usage}
                                </div>

                                {def.forwarding && (
                                    <div className="space-y-2 text-sm text-muted-foreground">
                                        <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("sheet.stop")}</span>
                                        {options.background && spec ? (
                                            <>
                                                <p>{t("sheet.stopBackground")}</p>
                                                <MiniCommand command={`pkill -f 'ssh.*${spec}'`} />
                                            </>
                                        ) : (
                                            <p>{t("sheet.stopForeground")}</p>
                                        )}
                                    </div>
                                )}

                                <div className="space-y-2">
                                    <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("sheet.whatItMeans")}</span>
                                    <CommandLegend segments={segments} />
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            )}

            {/* ── 4. 速查表 + 小提醒 / Quick reference + tips ── */}
            {target && (
                <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                    <section className={cn(CARD, "p-4 sm:p-5 space-y-3 min-w-0")}>
                        <div>
                            <h2 className="text-sm font-semibold text-foreground">{t("sheet.quickRef")}</h2>
                            <p className="mt-0.5 text-xs text-muted-foreground">{t("sheet.quickRefHint", { name: selected?.host_friendly_name ?? "" })}</p>
                        </div>
                        <div className="space-y-2">
                            {refRows.map((row) => (
                                <div key={row.label} className="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-3">
                                    <span className="text-xs font-medium text-foreground">{row.label}</span>
                                    <InlineCommand segments={row.segments} />
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className={cn(CARD, "p-4 sm:p-5 space-y-3")}>
                        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                            <Lightbulb size={16} className="text-amber-500" aria-hidden /> {t("sheet.tips")}
                        </h2>
                        <ul className="space-y-2.5 text-xs leading-relaxed text-muted-foreground">
                            {(["sheet.tip.deviceKey", "sheet.tip.lowPorts", "sheet.tip.inUse", "sheet.tip.windows", "sheet.tip.forwarding", "sheet.tip.gatewayPorts"] as const).map((k) => (
                                <li key={k} className="flex gap-2">
                                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
                                    <span>{t(k)}</span>
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            )}
        </div>
    );
}

export default function CheatsheetPage() {
    return (
        <Suspense fallback={null}>
            <CheatsheetInner />
        </Suspense>
    );
}
