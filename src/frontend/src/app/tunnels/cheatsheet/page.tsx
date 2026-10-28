"use client";

/**
 * 指令速查頁：一次只看一步——① 裝置與準備（選裝置 / 帳號；就緒圖把四項設定擺在它們所在的地方，下面是清單）
 * ② 要做什麼（插圖卡片，點了就到下一步）③ 填入數值（一句話裡填空，插圖跟著變）④ 複製並執行（指令、接著做什麼、
 * 每一段的意思、選項）。上面的步驟列可以直接點，每一步下面一行是它目前的值；全部指令、疑難排解在頁首的按鈕。
 * 打開時：深連結（?recipe=）到填空，設定沒做完到 ①，否則到 ②（`lib/sheetSteps.ts`）。選定的隧道在 URL（?tunnel=<id>）。
 * The command sheet, one step at a time: ① device and setup (device / account; a readiness diagram places the four
 * setup items where they live, the checklist below) ② pick a task (illustrated cards; a click moves on) ③ fill in
 * (blanks in one sentence, the picture follows) ④ copy and run (the command, what next, what each part means,
 * options). The step bar above is clickable and shows each step's current value; all commands and troubleshooting
 * sit behind header buttons. Opens on fill-in for deep links (?recipe=), on ① while setup is unfinished, else on ②
 * (`lib/sheetSteps.ts`). The tunnel lives in the URL (?tunnel=<id>).
 */
import React, { Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    ArrowRight,
    ChevronDown,
    Cpu,
    LayoutGrid,
    Lightbulb,
    ListTree,
    Plus,
    Repeat,
    RotateCcw,
    SlidersHorizontal,
    SquareTerminal,
    TextCursorInput,
    type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { StepPanel, StepPath, type PathStep } from "@/components/ui/step-path";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layout/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { MiniScene, TunnelScene } from "@/components/cheatsheet/TunnelScene";
import { MINI_SCENES, sceneFor } from "@/components/cheatsheet/sceneSpec";
import { AnnotatedCommand, CommandBar, InlineCommand, MiniCommand } from "@/components/cheatsheet/CommandView";
import { SetupGuide } from "@/components/cheatsheet/SetupGuide";
import { ReadinessPath } from "@/components/cheatsheet/ReadinessPath";
import { useCheatsheetPage } from "@/hooks/useCheatsheetPage";
import { useSetupChecklist, type SetupStepId } from "@/hooks/useSetupChecklist";
import { fillSummary, sheetOpenStep, sheetStates, type SheetStep } from "@/lib/sheetSteps";
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
    segmentsToString,
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

const TIPS = ["sheet.tip.deviceKey", "sheet.tip.lowPorts", "sheet.tip.inUse", "sheet.tip.windows", "sheet.tip.forwarding", "sheet.tip.gatewayPorts"] as const;

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

function CheatsheetInner() {
    const { t, tn } = useI18n();
    const { state, actions } = useCheatsheetPage();
    const { tunnels, loadingTunnels, portsMap, selected, online, keyCount, config, usernameId, hasTargetUser, target, mode } = state;

    // 深連結：?recipe=<id> 選定任務，該任務的欄位可用同名參數帶入（例如網路拓撲頁的 jump + lanHost/lanUser/lanPort）。
    // Deep link: ?recipe=<id> picks the task and same-named params prefill its fields (e.g. jump from the network page).
    const searchParams = useSearchParams();
    const deepRecipe = searchParams.get("recipe");
    const deepLinked = deepRecipe !== null && deepRecipe in RECIPE_BY_ID;
    const [recipe, setRecipe] = useState<RecipeId>(() => (deepLinked ? (deepRecipe as RecipeId) : "local"));
    const [paramsById, setParamsById] = useState<Record<RecipeId, RecipeParams>>(() => {
        const all = Object.fromEntries(RECIPES.map((r) => [r.id, { ...r.defaults }])) as Record<RecipeId, RecipeParams>;
        if (deepLinked) {
            for (const f of RECIPE_BY_ID[deepRecipe as RecipeId].fields) {
                const v = searchParams.get(f.key);
                if (v) all[deepRecipe as RecipeId][f.key] = v;
            }
        }
        return all;
    });
    const [options, setOptions] = useState<ForwardOptions>({ background: false, keepAlive: false, exitOnFailure: false });
    const checklist = useSetupChecklist({
        tunnelId: selected?.id ?? null,
        username: hasTargetUser && target ? target.username : null,
        keyCount,
        online,
        mode,
    });

    // 步驟：深連結直接到填空；否則等設定清單讀完再決定（沒做完 → ①，做完 → ②），之後照使用者點的。
    // Steps: a deep link opens on fill-in; otherwise wait for the setup checklist (unfinished → ①, done → ②).
    const setupLoading = checklist.steps.some((s) => s.state === "loading");
    const setupComplete = checklist.current === null;
    const [step, setStep] = useState<SheetStep | null>(deepLinked ? "fill" : null);
    useEffect(() => {
        if (step === null && !setupLoading && target) setStep(sheetOpenStep({ deepLinked: false, setupComplete }));
    }, [step, setupLoading, target, setupComplete]);
    // 金鑰清單一直讀不到（請求失敗）也別一直轉圈：1.5 秒後先到 ①。/ Never spin forever: open ① after 1.5 s.
    useEffect(() => {
        if (step !== null || !target) return;
        const id = setTimeout(() => setStep((s) => s ?? "device"), 1500);
        return () => clearTimeout(id);
    }, [step, target]);
    const [picked, setPicked] = useState(deepLinked);
    // 填空那一步：改過值或往下走了才算填好（深連結帶來的值一開始就算）。/ Fill-in counts once edited or left behind.
    const [filled, setFilled] = useState(deepLinked);
    const [copiedText, setCopiedText] = useState<string | null>(null);
    const [openRequest, setOpenRequest] = useState<{ id: SetupStepId; n: number } | null>(null);
    const [dialog, setDialog] = useState<"all" | "tips" | null>(null);
    const barRef = useRef<HTMLDivElement>(null);
    const panelId = useId();

    const def = RECIPE_BY_ID[recipe];
    const params = paramsById[recipe];
    const resolved = resolveParams(recipe, params);
    const setParam = (key: string, value: string) => {
        setFilled(true);
        setParamsById((prev) => ({ ...prev, [recipe]: { ...prev[recipe], [key]: value } }));
    };

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

    if (tunnels.length === 0 || !target) {
        return (
            <div className="space-y-6 animate-fade-in-up">
                <PageHeader icon={<SquareTerminal />} title={t("sheet.title")} description={t("sheet.subtitle")} />
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
            case "rustdesk": return tn("sheet.sentence.rustdesk", { device, lanHost: blank("lanHost"), remotePort: blank("remotePort"), localPort: blank("localPort") });
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
            case "rustdesk": return tn("sheet.caption.rustdesk", { you: code(`127.0.0.1:${resolved.localPort}`), target: code(`${resolved.lanHost}:${resolved.remotePort}`), alias: name });
        }
    })();

    const webNext = (port: string, localPort: string) => {
        if (WEB_PORTS.has(port)) {
            const url = `${port === "443" || port === "8443" ? "https" : "http"}://localhost:${localPort}`;
            return tn("sheet.next.openUrl", {
                url: <a href={url} target="_blank" rel="noopener noreferrer" className="font-mono font-semibold text-primary underline-offset-4 wrap-anywhere hover:underline">{url}</a>,
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
            case "rustdesk": return <p>{tn("sheet.next.rustdesk", { addr: code(resolved.localPort === "21118" ? "127.0.0.1" : `127.0.0.1:${resolved.localPort}`) })}</p>;
        }
    })();

    const spec = forwardSpec(recipe, params);
    const anyInvalid = def.fields.some((f) => {
        const v = (params[f.key] ?? "").trim();
        return v !== "" && ((f.kind === "port" && !isValidPort(v)) || (f.key === "lanHost" && !isValidHost(v)));
    });
    const commandText = segmentsToString(segments);

    const refRows = [
        { label: t("sheet.ref.shell"), segments: shellSegments(target) },
        { label: t("sheet.ref.exec"), segments: shellSegments(target, "uptime") },
        ...RECIPES.map((r) => ({ label: t(r.title), segments: buildSegments(r.id, paramsById[r.id], target, options) })),
    ];

    // ---------------------------------------------------------------- steps
    const states = sheetStates({
        setupDone: checklist.done,
        setupTotal: checklist.total,
        setupLoading,
        picked,
        filled,
        invalid: anyInvalid,
        copied: copiedText === commandText,
    });
    const account = hasTargetUser ? target.username : null;
    const steps: PathStep<SheetStep>[] = [
        {
            value: "device",
            title: t("sheet.step.device"),
            icon: Cpu,
            state: states.device,
            sub: needsSetup && !setupLoading ? `${alias} · ${t("sheet.step.setupLeft", { done: checklist.done, total: checklist.total })}` : [alias, account].filter(Boolean).join(" · "),
        },
        { value: "task", title: t("sheet.step.task"), icon: LayoutGrid, state: states.task, sub: t(def.title) },
        { value: "fill", title: t("sheet.step.fill"), icon: TextCursorInput, state: states.fill, sub: anyInvalid ? t("sheet.field.invalidPort") : <span className="font-mono">{fillSummary(recipe, resolved)}</span> },
        { value: "run", title: t("sheet.step.run"), icon: SquareTerminal, state: states.run, sub: states.run === "done" ? t("sheet.step.copied") : t("sheet.step.runTodo") },
    ];
    const current: SheetStep = step ?? "device";
    // 換步驟時，步驟列若已捲出畫面就捲回來（內容從頂端開始看）。/ Switching steps brings the bar back into view.
    const go = (s: SheetStep) => {
        if (current === "fill" && s !== "fill") setFilled(true);
        setStep(s);
        requestAnimationFrame(() => {
            const bar = barRef.current;
            if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ behavior: "smooth", block: "start" });
        });
    };
    const pickTask = (id: RecipeId) => {
        setRecipe(id);
        setPicked(true);
        go("fill");
    };

    const panel = (() => {
        switch (current) {
            case "device":
                return (
                    <StepPanel id={panelId} steps={steps} value={current} onChange={go} title={t("sheet.step.deviceTitle")} description={t("sheet.setup.subtitle")}>
                        <div className="grid gap-3 sm:grid-cols-[minmax(0,20rem)_minmax(0,14rem)]">
                            <Field label={t("sheet.device")}>
                                <Select value={selected ? String(selected.id) : ""} onValueChange={(v) => actions.setTunnel(Number(v))}>
                                    <SelectTrigger className="h-10 w-full text-sm" aria-label={t("sheet.device")}>
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
                            </Field>
                            {config && config.usernames.length > 1 && (
                                <Field label={t("sheet.targetUser")}>
                                    <Select value={usernameId !== null ? String(usernameId) : ""} onValueChange={(v) => actions.setUsernameId(Number(v))}>
                                        <SelectTrigger className="h-10 w-full font-mono text-sm" aria-label={t("sheet.targetUser")}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {config.usernames.map((u) => (
                                                <SelectItem key={u.id} value={String(u.id)} className="font-mono">{u.username}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </Field>
                            )}
                        </div>
                        {config && !hasTargetUser && <Callout tone="warning">{t("sheet.noTargetUser")}</Callout>}
                        <ReadinessPath
                            checklist={checklist}
                            alias={alias}
                            username={account}
                            online={online}
                            mode={mode}
                            onOpen={(id) => setOpenRequest((r) => ({ id, n: (r?.n ?? 0) + 1 }))}
                        />
                        <SetupGuide
                            openRequest={openRequest}
                            tunnelId={selected?.id ?? 0}
                            alias={alias}
                            username={account}
                            online={online}
                            mode={mode}
                            setMode={actions.setMode}
                            configText={config?.config ?? null}
                            knownHosts={config?.known_hosts ?? null}
                            legacyAlias={config?.server.legacy_alias ?? null}
                            checklist={checklist}
                        />
                    </StepPanel>
                );
            case "task":
                return (
                    <StepPanel id={panelId} steps={steps} value={current} onChange={go} title={t("sheet.step1")} description={t("sheet.step.taskHint")}>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                            {RECIPES.map((r) => {
                                const active = r.id === recipe;
                                return (
                                    <button
                                        key={r.id}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => pickTask(r.id)}
                                        className={cn(
                                            // pt-8：插圖排在右上角的旗標底下，不跟它重疊。/ pt-8 keeps the illustration below the corner flag.
                                            "@container relative flex flex-col items-center gap-3 rounded-xl border px-3 pb-3.5 pt-8 text-center transition-colors duration-150",
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
                    </StepPanel>
                );
            case "fill":
                return (
                    <StepPanel
                        id={panelId}
                        steps={steps}
                        value={current}
                        onChange={go}
                        title={t("sheet.step2")}
                        description={tn("sheet.step.fillHint", { task: <strong className="text-foreground">{t(def.title)}</strong> })}
                        actions={
                            recipe === "copy" ? (
                                <Segmented
                                    value={upload ? "upload" : "download"}
                                    onChange={(v) => setParam("direction", v)}
                                    ariaLabel={t("sheet.field.direction")}
                                    options={[
                                        { value: "upload", label: t("sheet.field.upload") },
                                        { value: "download", label: t("sheet.field.download") },
                                    ]}
                                />
                            ) : undefined
                        }
                    >
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
                                                onClick={() => {
                                                    setFilled(true);
                                                    setParamsById((prev) => ({ ...prev, local: { remotePort: p.remotePort, localPort: p.localPort } }));
                                                }}
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
                        {scene && <TunnelScene nodes={scene.nodes} links={scene.links} file={scene.file} caption={caption} />}
                    </StepPanel>
                );
            case "run":
                return (
                    <StepPanel
                        id={panelId}
                        steps={steps}
                        value={current}
                        onChange={go}
                        title={t("sheet.step3")}
                        description={tn("sheet.step.runHint", { task: <strong className="text-foreground">{t(def.title)}</strong> })}
                        final={
                            <Button variant="outline" onClick={() => go("task")}>
                                <RotateCcw size={16} />
                                {t("sheet.step.another")}
                            </Button>
                        }
                    >
                        <div>
                            <CommandBar segments={segments} onCopy={() => setCopiedText(commandText)} />
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
                        {needsSetup && !setupLoading && (
                            <Callout tone="warning">
                                <span className="block">{t("sheet.step.setupFirst", { done: checklist.done, total: checklist.total })}</span>
                                <Button variant="outline" size="sm" className="mt-2" onClick={() => go("device")}>{t("sheet.step.openSetup")}</Button>
                            </Callout>
                        )}
                        <section className="space-y-2">
                            <h3 className="text-sm text-foreground">{t("sheet.more.explain")}</h3>
                            <AnnotatedCommand segments={segments} />
                            <p className="text-xs text-muted-foreground">{t("sheet.more.explainHint")}</p>
                        </section>
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
                                        <Switch size="sm" checked={options.background} onCheckedChange={(v) => setOptions((o) => ({ ...o, background: v }))}>{t("sheet.opt.background")}</Switch>
                                        <Switch size="sm" checked={options.keepAlive} onCheckedChange={(v) => setOptions((o) => ({ ...o, keepAlive: v }))}>{t("sheet.opt.keepAlive")}</Switch>
                                        <Switch size="sm" checked={options.exitOnFailure} onCheckedChange={(v) => setOptions((o) => ({ ...o, exitOnFailure: v }))}>{t("sheet.opt.exitOnFailure")}</Switch>
                                    </div>
                                )}
                            </div>
                        </Disclosure>
                    </StepPanel>
                );
        }
    })();

    return (
        <div className="space-y-6 animate-fade-in-up">
            <PageHeader
                icon={<SquareTerminal />}
                title={t("sheet.title")}
                description={t("sheet.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setDialog("all")}>
                            <ListTree size={16} /> {t("sheet.allCommands")}
                        </Button>
                        <Button variant="outline" onClick={() => setDialog("tips")}>
                            <Lightbulb size={16} /> {t("sheet.more.tips")}
                        </Button>
                    </>
                }
            />

            <div ref={barRef} className="scroll-mt-20">
                <StepPath steps={steps} value={current} onChange={go} panelId={panelId} aria-label={t("ui.steps.aria")} />
            </div>

            {step === null ? (
                <div className="flex justify-center rounded-xl border border-border bg-card p-16 shadow-card">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" aria-label={t("common.loading")} />
                </div>
            ) : (
                panel
            )}

            <Modal isOpen={dialog === "all"} onClose={() => setDialog(null)} size="3xl" icon={<ListTree />} title={t("sheet.more.all", { name: alias })} description={t("sheet.allHint")}>
                <div className="space-y-3">
                    {refRows.map((row) => (
                        <div key={row.label} className="grid gap-1.5">
                            <span className="text-xs font-medium text-foreground">{row.label}</span>
                            <InlineCommand segments={row.segments} />
                        </div>
                    ))}
                </div>
            </Modal>
            <Modal isOpen={dialog === "tips"} onClose={() => setDialog(null)} size="xl" icon={<Lightbulb />} title={t("sheet.more.tips")}>
                <ul className="space-y-3 text-sm leading-relaxed text-muted-foreground">
                    {TIPS.map((k) => (
                        <li key={k} className="flex gap-2.5">
                            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
                            <span>{t(k)}</span>
                        </li>
                    ))}
                </ul>
            </Modal>
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
