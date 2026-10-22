"use client";

/**
 * 指令速查頁：三步驟——① 挑要做的事（插圖卡片）② 在一句話裡填空 ③ 複製一行指令。
 * 插圖場景跟著填的值即時更新；指令拆解、選項、全部指令、疑難排解都收在可展開區塊，第一次設定放在對話框。
 * 選定的隧道在 URL（?tunnel=<id>），隧道列表的「埠轉發」會深連結過來。
 * Command sheet in three steps: ① pick a task (illustrated cards) ② fill in the blanks of one sentence ③ copy one
 * command. The illustrated scene follows the values live; the breakdown, options, all commands and troubleshooting
 * are collapsible, and first-time setup lives in a dialog. The tunnel lives in the URL (?tunnel=<id>).
 */
import React, { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    AlertTriangle,
    ArrowRight,
    ChevronDown,
    Cpu,
    HelpCircle,
    Lightbulb,
    ListChecks,
    ListTree,
    Plus,
    Repeat,
    SlidersHorizontal,
    SquareTerminal,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/layout/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { MiniScene, TunnelScene } from "@/components/cheatsheet/TunnelScene";
import { MINI_SCENES, sceneFor } from "@/components/cheatsheet/sceneSpec";
import { AnnotatedCommand, CommandBar, InlineCommand, MiniCommand } from "@/components/cheatsheet/CommandView";
import { SetupGuide } from "@/components/cheatsheet/SetupGuide";
import { useCheatsheetPage } from "@/hooks/useCheatsheetPage";
import { useSetupChecklist } from "@/hooks/useSetupChecklist";
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

const CARD = "rounded-xl border border-border bg-card shadow-card";

/** 這些埠多半是網頁服務，「接著」直接給可點的網址。/ Ports that are usually web apps get a clickable URL. */
const WEB_PORTS = new Set(["80", "443", "3000", "3001", "4200", "5000", "5173", "8000", "8080", "8123", "8443", "8888", "9000"]);

function StepHeading({ n, children, className }: { n: number; children: React.ReactNode; className?: string }) {
    return (
        <h2 className={cn("mb-3 flex items-center gap-2.5 text-sm font-semibold text-foreground", className)}>
            <span className="grid size-5 place-items-center rounded-sm bg-primary font-mono text-xs text-primary-foreground" aria-hidden>{n}</span>
            {children}
        </h2>
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

/** 句子裡的填空格。/ A fill-in blank inside the sentence. */
function Blank({ field, value, onChange }: { field: FieldDef; value: string; onChange: (v: string) => void }) {
    const { t } = useI18n();
    const trimmed = value.trim();
    const invalid = trimmed !== "" && ((field.kind === "port" && !isValidPort(trimmed)) || (field.key === "lanHost" && !isValidHost(trimmed)));
    const width = Math.min(Math.max(value.length, field.kind === "port" ? 3 : 4), 26) + 2.5;
    return (
        <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={t(field.label)}
            title={t(field.label)}
            aria-invalid={invalid || undefined}
            inputMode={field.kind === "port" ? "numeric" : undefined}
            spellCheck={false}
            autoComplete="off"
            style={{ width: `${width}ch` }}
            className={cn(
                "mx-0.5 inline-block h-7 rounded-md border border-dashed px-1.5 text-center align-middle font-mono text-sm font-semibold shadow-xs transition-colors",
                "focus:border-solid focus:outline-none focus:ring-2 focus:ring-ring/30",
                invalid ? "border-destructive bg-destructive/5 text-destructive" : "border-primary/50 bg-background text-primary hover:border-primary"
            )}
        />
    );
}

function Disclosure({ icon: Icon, title, children, defaultOpen = false }: { icon: LucideIcon; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
    return (
        <details className={cn(CARD, "group overflow-hidden")} open={defaultOpen}>
            <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden">
                <Icon size={16} className="text-primary" aria-hidden />
                <span className="flex-1">{title}</span>
                <ChevronDown size={16} className="text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
            </summary>
            <div className="border-t border-border px-4 py-4">{children}</div>
        </details>
    );
}

function OptionToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="flex items-center gap-2.5 rounded-lg px-1 py-1 text-left text-sm text-foreground hover:bg-muted/50"
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

    // 深連結：?recipe=<id> 選定任務，該任務的欄位可用同名參數帶入（例如網路拓撲頁的 jump + lanHost/lanUser/lanPort）。
    // Deep link: ?recipe=<id> picks the task and same-named params prefill its fields (e.g. jump from the network page).
    const searchParams = useSearchParams();
    const [recipe, setRecipe] = useState<RecipeId>(() => {
        const r = searchParams.get("recipe");
        return r && r in RECIPE_BY_ID ? (r as RecipeId) : "local";
    });
    const [paramsById, setParamsById] = useState<Record<RecipeId, RecipeParams>>(() => {
        const all = Object.fromEntries(RECIPES.map((r) => [r.id, { ...r.defaults }])) as Record<RecipeId, RecipeParams>;
        const r = searchParams.get("recipe");
        if (r && r in RECIPE_BY_ID) {
            for (const f of RECIPE_BY_ID[r as RecipeId].fields) {
                const v = searchParams.get(f.key);
                if (v) all[r as RecipeId][f.key] = v;
            }
        }
        return all;
    });
    const [options, setOptions] = useState<ForwardOptions>({ background: false, keepAlive: false, exitOnFailure: false });
    const [setupOpen, setSetupOpen] = useState(false);
    const checklist = useSetupChecklist({
        tunnelId: selected?.id ?? null,
        username: hasTargetUser && target ? target.username : null,
        keyCount,
        online,
        mode,
    });

    const def = RECIPE_BY_ID[recipe];
    const params = paramsById[recipe];
    const resolved = resolveParams(recipe, params);
    const setParam = (key: string, value: string) =>
        setParamsById((prev) => ({ ...prev, [recipe]: { ...prev[recipe], [key]: value } }));

    const segments = useMemo(() => (target ? buildSegments(recipe, params, target, options) : []), [recipe, params, target, options]);
    const scene = useMemo(() => (target ? sceneFor(recipe, params, target, t) : null), [recipe, params, target, t]);

    // 選預設隧道的那一瞬間 target 還是 null：先顯示載入中，別閃出「沒有通道」。
    // target is briefly null while the default tunnel is being picked: keep the spinner instead of flashing "no tunnels".
    if (loadingTunnels || (tunnels.length > 0 && !target)) {
        return (
            <div className="flex flex-col items-center justify-center p-16 text-muted-foreground">
                <div className="mb-4 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                {t("common.loading")}
            </div>
        );
    }

    const header = <PageHeader icon={<SquareTerminal />} title={t("sheet.title")} description={t("sheet.subtitle")} />;

    if (tunnels.length === 0 || !target) {
        return (
            <div className="space-y-6 animate-fade-in-up">
                {header}
                <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card p-16 text-center">
                    <SquareTerminal size={40} className="mb-4 text-muted-foreground/60" aria-hidden />
                    <h3 className="text-xl font-semibold tracking-tight text-foreground">{t("sheet.emptyTitle")}</h3>
                    <p className="mt-2 max-w-sm text-sm text-muted-foreground">{t("sheet.emptyBody")}</p>
                    <Button asChild className="mt-6">
                        <Link href="/tunnels/create" prefetch={false}>
                            <Plus size={16} />
                            {t("tunnels.create")}
                        </Link>
                    </Button>
                </div>
            </div>
        );
    }

    const alias = target.alias;
    const needsSetup = checklist.current !== null;
    const code = (s: string) => <code className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[0.9em] text-foreground ring-1 ring-border">{s}</code>;
    const field = (key: string) => def.fields.find((f) => f.key === key)!;
    const blank = (key: string) => <Blank field={field(key)} value={params[key] ?? ""} onChange={(v) => setParam(key, v)} />;
    const device = (
        <span className="mx-0.5 inline-flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 align-middle text-sm font-semibold text-primary">
            <Cpu size={14} aria-hidden />{alias}
        </span>
    );
    const upload = resolved.direction !== "download";
    const tool = (
        <button
            type="button"
            onClick={() => setParam("tool", resolved.tool === "rsync" ? "scp" : "rsync")}
            title={t("sheet.field.tool")}
            className="mx-0.5 inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-primary/50 bg-background px-2 align-middle font-mono text-sm font-semibold text-primary shadow-xs hover:border-primary"
        >
            {resolved.tool}
            <Repeat size={12} aria-hidden />
        </button>
    );

    const sentence = (() => {
        switch (recipe) {
            case "local": return tn("sheet.sentence.local", { device, remotePort: blank("remotePort"), localPort: blank("localPort") });
            case "lan": return tn("sheet.sentence.lan", { device, lanHost: blank("lanHost"), lanPort: blank("lanPort"), localPort: blank("localPort") });
            case "socks": return tn("sheet.sentence.socks", { device, localPort: blank("localPort") });
            case "remote": return tn("sheet.sentence.remote", { device, localPort: blank("localPort"), devicePort: blank("devicePort") });
            case "jump": return tn("sheet.sentence.jump", { device, lanUser: blank("lanUser"), lanHost: blank("lanHost"), lanPort: blank("lanPort") });
            case "copy": return tn(upload ? "sheet.sentence.copyUp" : "sheet.sentence.copyDown", { device, localPath: blank("localPath"), remotePath: blank("remotePath"), tool });
        }
    })();

    const caption = (() => {
        const name = <strong className="font-semibold text-foreground">{alias}</strong>;
        switch (recipe) {
            case "local": return tn("sheet.caption.local", { you: code(`localhost:${resolved.localPort}`), port: code(resolved.remotePort), alias: name });
            case "lan": return tn("sheet.caption.lan", { you: code(`localhost:${resolved.localPort}`), target: code(`${resolved.lanHost}:${resolved.lanPort}`), alias: name });
            case "socks": return tn("sheet.caption.socks", { you: code(`localhost:${resolved.localPort}`), alias: name });
            case "remote": return tn("sheet.caption.remote", { device: code(`localhost:${resolved.devicePort}`), you: code(`localhost:${resolved.localPort}`), alias: name });
            case "jump": return tn("sheet.caption.jump", { target: code(`${resolved.lanUser}@${resolved.lanHost}`), alias: name });
            case "copy": return tn(upload ? "sheet.caption.copyUp" : "sheet.caption.copyDown", { from: code(upload ? resolved.localPath : resolved.remotePath), to: code(upload ? resolved.remotePath : resolved.localPath), alias: name });
        }
    })();

    const webNext = (port: string, localPort: string) => {
        if (WEB_PORTS.has(port)) {
            const url = `${port === "443" || port === "8443" ? "https" : "http"}://localhost:${localPort}`;
            return tn("sheet.next.openUrl", {
                url: <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono font-semibold text-primary underline-offset-4 hover:underline">{url}</a>,
            });
        }
        return tn("sheet.next.connectTo", { addr: code(`localhost:${localPort}`) });
    };

    const next = (() => {
        switch (recipe) {
            case "local": return <p>{webNext(resolved.remotePort, resolved.localPort)}</p>;
            case "lan": return <p>{webNext(resolved.lanPort, resolved.localPort)}</p>;
            case "socks":
                return (
                    <>
                        <p>{tn("sheet.next.socks", { addr: code(`localhost:${resolved.localPort}`) })}</p>
                        <p className="text-xs">{t("sheet.next.socksTest")}</p>
                        <MiniCommand command={`curl --socks5-hostname localhost:${resolved.localPort} https://ifconfig.me`} />
                    </>
                );
            case "remote":
                return (
                    <>
                        <p>{t("sheet.next.remote")}</p>
                        <MiniCommand command={`curl http://localhost:${resolved.devicePort}`} />
                    </>
                );
            case "jump": return <p>{t("sheet.next.jump")}</p>;
            case "copy": return null;
        }
    })();

    const spec = forwardSpec(recipe, params);
    const anyInvalid = def.fields.some((f) => {
        const v = (params[f.key] ?? "").trim();
        return v !== "" && ((f.kind === "port" && !isValidPort(v)) || (f.key === "lanHost" && !isValidHost(v)));
    });

    const refRows = [
        { label: t("sheet.ref.shell"), segments: shellSegments(target) },
        { label: t("sheet.ref.exec"), segments: shellSegments(target, "uptime") },
        ...RECIPES.map((r) => ({ label: t(r.title), segments: buildSegments(r.id, paramsById[r.id], target, options) })),
    ];

    return (
        <div className="space-y-6 animate-fade-in-up">
            {header}

            {/* 裝置 + 設定指南 / Device + setup guide */}
            <div className={cn(CARD, "flex flex-wrap items-center gap-x-3 gap-y-2 p-3")}>
                <span className="pl-1 text-sm font-medium text-muted-foreground">{t("sheet.device")}</span>
                <Select value={selected ? String(selected.id) : ""} onValueChange={(v) => actions.setTunnel(Number(v))}>
                    <SelectTrigger className="h-10 w-full sm:w-72 text-sm" aria-label={t("sheet.device")}>
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
                {config && config.usernames.length > 1 && (
                    <Select value={usernameId !== null ? String(usernameId) : ""} onValueChange={(v) => actions.setUsernameId(Number(v))}>
                        <SelectTrigger className="h-10 w-full sm:w-44 text-sm font-mono" aria-label={t("sheet.targetUser")}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {config.usernames.map((u) => (
                                <SelectItem key={u.id} value={String(u.id)} className="font-mono">{u.username}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
                <Button
                    variant="outline"
                    onClick={() => setSetupOpen(true)}
                    className={cn("sm:ml-auto", needsSetup && "border-warning/50 text-warning hover:text-warning")}
                >
                    {needsSetup ? <AlertTriangle size={16} /> : <ListChecks size={16} />}
                    {needsSetup ? t("sheet.setupNeeded") : t("sheet.setupGuide")}
                    {needsSetup && (
                        <span className="rounded-sm bg-warning/15 px-1.5 py-px font-mono text-[0.75rem] tabular-nums">
                            {checklist.done}/{checklist.total}
                        </span>
                    )}
                </Button>
            </div>

            {config && !hasTargetUser && (
                <div className="flex items-start gap-2 rounded-xl border border-warning/35 bg-warning/[0.07] p-3 text-xs text-warning">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                    <span>{t("sheet.noTargetUser")}</span>
                </div>
            )}

            {/* ① 要做什麼 / What to do */}
            <section>
                <StepHeading n={1}>{t("sheet.step1")}</StepHeading>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                    {RECIPES.map((r) => {
                        const active = r.id === recipe;
                        return (
                            <button
                                key={r.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setRecipe(r.id)}
                                className={cn(
                                    "relative flex flex-col items-center gap-3 rounded-xl border px-3 pb-3.5 pt-5 text-center transition-colors duration-150",
                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                    active ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border bg-card hover:border-foreground/30"
                                )}
                            >
                                <code className="absolute right-2 top-2 rounded bg-muted px-1 font-mono text-[0.6875rem] text-muted-foreground">{r.flag}</code>
                                <MiniScene items={MINI_SCENES[r.id]} active={active} />
                                <span className="text-sm font-semibold leading-tight text-foreground">{t(r.title)}</span>
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* ② 填空 + 插圖，③ 指令 / Fill in + scene, then the command */}
            {scene && (
                <section className={cn(CARD, "space-y-6 p-4 sm:p-6")}>
                    <div>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <StepHeading n={2} className="mb-0">{t("sheet.step2")}</StepHeading>
                            {recipe === "copy" && (
                                <Segmented
                                    value={upload ? "upload" : "download"}
                                    onChange={(v) => setParam("direction", v)}
                                    ariaLabel={t("sheet.field.direction")}
                                    options={[
                                        { value: "upload", label: t("sheet.field.upload") },
                                        { value: "download", label: t("sheet.field.download") },
                                    ]}
                                />
                            )}
                        </div>
                        <div className="rounded-xl border border-border bg-muted/30 px-4 py-2.5">
                            <p className="text-[1rem] leading-9 text-foreground">{sentence}</p>
                            {anyInvalid && <p className="pb-1 text-xs text-destructive">{t("sheet.field.invalidPort")}</p>}
                            {recipe === "local" && (
                                <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-border/70 pt-2.5 pb-0.5">
                                    <span className="mr-0.5 text-[0.75rem] text-muted-foreground">{t("sheet.presets")}</span>
                                    {LOCAL_PRESETS.map((p) => {
                                        const active = resolved.remotePort === p.remotePort && resolved.localPort === p.localPort;
                                        return (
                                            <button
                                                key={p.label}
                                                type="button"
                                                aria-pressed={active}
                                                onClick={() => setParamsById((prev) => ({ ...prev, local: { remotePort: p.remotePort, localPort: p.localPort } }))}
                                                className={cn(
                                                    "rounded-full border px-2 py-0.5 text-[0.75rem] transition-colors",
                                                    active ? "border-primary/50 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground"
                                                )}
                                            >
                                                {p.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    <TunnelScene nodes={scene.nodes} links={scene.links} file={scene.file} caption={caption} />

                    <div>
                        <StepHeading n={3}>{t("sheet.step3")}</StepHeading>
                        <CommandBar segments={segments} />
                        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                            {next && (
                                <div className="flex gap-2">
                                    <ArrowRight size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                                    <div className="min-w-0 flex-1 space-y-2">{next}</div>
                                </div>
                            )}
                            {def.forwarding && (
                                options.background && spec ? (
                                    <div className="space-y-1.5 pl-6">
                                        <p className="text-xs">{t("sheet.next.background")}</p>
                                        <MiniCommand command={`pkill -f 'ssh.*${spec}'`} />
                                    </div>
                                ) : (
                                    <p className="pl-6 text-xs">{t("sheet.next.keepOpen")}</p>
                                )
                            )}
                        </div>
                    </div>

                    <div className="space-y-3">
                        <Disclosure icon={HelpCircle} title={t("sheet.more.explain")}>
                            <AnnotatedCommand segments={segments} />
                            <p className="mt-2 text-xs text-muted-foreground">{t("sheet.more.explainHint")}</p>
                        </Disclosure>
                        <Disclosure icon={SlidersHorizontal} title={t("sheet.more.options")}>
                            <div className="space-y-4">
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
                                    <p className="text-xs text-muted-foreground">
                                        {mode === "alias" ? tn("sheet.modeAliasHint", { alias: code(alias) }) : t("sheet.modeDirectHint")}
                                    </p>
                                </div>
                                {def.forwarding && (
                                    <div className="flex flex-col">
                                        <OptionToggle checked={options.background} label={t("sheet.opt.background")} onChange={(v) => setOptions((o) => ({ ...o, background: v }))} />
                                        <OptionToggle checked={options.keepAlive} label={t("sheet.opt.keepAlive")} onChange={(v) => setOptions((o) => ({ ...o, keepAlive: v }))} />
                                        <OptionToggle checked={options.exitOnFailure} label={t("sheet.opt.exitOnFailure")} onChange={(v) => setOptions((o) => ({ ...o, exitOnFailure: v }))} />
                                    </div>
                                )}
                            </div>
                        </Disclosure>
                    </div>
                </section>
            )}

            {/* 參考：全部指令、疑難排解 / Reference: all commands, troubleshooting */}
            <div className="grid items-start gap-3 lg:grid-cols-2">
                <Disclosure icon={ListTree} title={t("sheet.more.all", { name: alias })}>
                    <div className="space-y-2">
                        {refRows.map((row) => (
                            <div key={row.label} className="grid gap-1.5">
                                <span className="text-xs font-medium text-foreground">{row.label}</span>
                                <InlineCommand segments={row.segments} />
                            </div>
                        ))}
                    </div>
                </Disclosure>
                <Disclosure icon={Lightbulb} title={t("sheet.more.tips")}>
                    <ul className="space-y-2.5 text-xs leading-relaxed text-muted-foreground">
                        {(["sheet.tip.deviceKey", "sheet.tip.lowPorts", "sheet.tip.inUse", "sheet.tip.windows", "sheet.tip.forwarding", "sheet.tip.gatewayPorts"] as const).map((k) => (
                            <li key={k} className="flex gap-2">
                                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
                                <span>{t(k)}</span>
                            </li>
                        ))}
                    </ul>
                </Disclosure>
            </div>

            <SetupGuide
                isOpen={setupOpen}
                onClose={() => setSetupOpen(false)}
                tunnelId={selected?.id ?? 0}
                alias={alias}
                username={hasTargetUser ? target.username : null}
                online={online}
                mode={mode}
                setMode={actions.setMode}
                configText={config?.config ?? null}
                checklist={checklist}
            />
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
