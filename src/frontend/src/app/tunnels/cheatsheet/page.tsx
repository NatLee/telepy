"use client";

/**
 * 指令速查頁：一頁看完，不分步驟。最上面一列選裝置 / 帳號與用什麼跑（telepy、~/.ssh/config 或單行 ssh），下面一行
 * 說設定好了沒（沒好才需要點開：就緒圖 + 清單在對話框裡）。左邊是任務清單（埠轉發、連進去與搬檔案、telepy CLI
 * 還能做的事），右邊立刻是那件事的填空句與指令（跟著每次修改變）、另一種工具的寫法、接著做什麼；示意圖、
 * 每一段的意思與選項收合在下面。telepy 的指令就是 CLI 自己的範例（`src/cli/src/examples.rs`，
 * `forwardRecipes.test.ts` 比對），不是另一份。隧道在 ?tunnel=<id>，跑法 ?way=，任務與數值 ?recipe=。
 * The command sheet on one page, no steps. A top row picks the device / account and what runs it (telepy,
 * ~/.ssh/config or a one-line ssh); one line below says whether setup is done (the readiness diagram and the
 * checklist open in a dialog only when needed). Tasks are listed on the left (port forwarding, getting in / moving
 * files, more with the telepy CLI); the right side is at once that task's fill-in sentence and its command
 * (following every edit), the other tool's form and what to do next; the picture, what each part means and the
 * options are folded below. The telepy commands are the CLI's own examples (`src/cli/src/examples.rs`, compared
 * by `forwardRecipes.test.ts`), not another copy. Tunnel in ?tunnel=<id>, the way in ?way=, task and values in
 * ?recipe=.
 */
import React, { Suspense, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
    ArrowRight,
    ChevronDown,
    CornerDownRight,
    Cpu,
    Files,
    Globe,
    HardDrive,
    Info,
    Lightbulb,
    ListTree,
    MonitorSmartphone,
    Network,
    Plus,
    Repeat,
    Route,
    Router,
    Scale,
    Settings2,
    Share2,
    SlidersHorizontal,
    SquareTerminal,
    type LucideIcon,
} from "lucide-react";
import { ForwardKinds, type ForwardValues } from "@/components/flow/ForwardKinds";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/components/layout/PageHeader";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { TunnelScene } from "@/components/cheatsheet/TunnelScene";
import { sceneFor } from "@/components/cheatsheet/sceneSpec";
import { AnnotatedCommand, CommandBar, InlineCommand, MiniCommand } from "@/components/cheatsheet/CommandView";
import { SetupGuide } from "@/components/cheatsheet/SetupGuide";
import { ReadinessPath } from "@/components/cheatsheet/ReadinessPath";
import { SHEET_CATALOGUE, SheetResults, SheetSearchBox, type WayFilter } from "@/components/cheatsheet/SheetSearch";
import { WayMarks } from "@/components/cheatsheet/WayMarks";
import { WaysDialog, type WaysTab } from "@/components/cheatsheet/WaysDialog";
import { TASK_FAMILY, TOPIC_FAMILY } from "@/lib/toolOverlap";
import { TOPIC_ICON, TopicBoard, TopicTiles } from "@/components/cheatsheet/TopicBoard";
import { CLI_EXAMPLE_TOPICS, type CliTopicId } from "@/lib/cliExamples.gen";
import type { TranslationKey } from "@/locales/en";
import { useCheatsheetPage } from "@/hooks/useCheatsheetPage";
import { useSetupChecklist, type SetupStepId } from "@/hooks/useSetupChecklist";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
    LOCAL_PRESETS,
    RECIPES,
    RECIPE_BY_ID,
    CONNECT_MODES,
    buildSegments,
    forwardSpec,
    isValidHost,
    isValidPort,
    recipeWays,
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

/** 任務的圖示：目標在哪裡（裝置自己 / 它區網裡的主機 / 網際網路…），兩個 -L 才分得出來。/ A task's icon: where the target is, so the two -L tasks can be told apart. */
const TASK_ICON: Record<RecipeId, LucideIcon> = { local: HardDrive, lan: Router, socks: Globe, remote: Share2, rustdesk: MonitorSmartphone, jump: CornerDownRight, copy: Files, vpn: Network };

/** 這些埠多半是網頁服務，「接著」直接給可點的網址。/ Ports that are usually web apps get a clickable URL. */
const WEB_PORTS = new Set(["80", "443", "3000", "3001", "4200", "5000", "5173", "8000", "8080", "8123", "8443", "8888", "9000"]);

const TIPS = ["sheet.tip.deviceKey", "sheet.tip.lowPorts", "sheet.tip.inUse", "sheet.tip.windows", "sheet.tip.forwarding", "sheet.tip.gatewayPorts"] as const;

function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
    value: T;
    options: { value: T; label: string; title?: string }[];
    onChange: (v: T) => void;
    ariaLabel: string;
}) {
    return (
        // 窄螢幕上換行，不被卡片裁掉（三種跑法的日文名稱放不進一列）。/ Wraps on narrow screens instead of being clipped.
        <div className="inline-flex max-w-full flex-wrap rounded-lg border border-border bg-muted/40 p-0.5" role="group" aria-label={ariaLabel}>
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    aria-pressed={value === o.value}
                    title={o.title}
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
    const { tunnels, loadingTunnels, portsMap, selected, online, keyCount, config, usernameId, hasTargetUser, target, mode, cliSignIns } = state;

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
        cliSignIns,
    });

    const setupLoading = checklist.steps.some((s) => s.state === "loading");
    const [openRequest, setOpenRequest] = useState<{ id: SetupStepId; n: number } | null>(null);
    // `?compare=ways|reach|files|run` 直接打開比較對話框的那一頁。/ `?compare=…` opens the comparison dialog on that tab.
    const compareParam = (["ways", "reach", "files", "run"] as const).find((v) => v === searchParams.get("compare")) ?? null;
    const [dialog, setDialog] = useState<"all" | "tips" | "directions" | "ways" | "setup" | null>(compareParam ? "ways" : null);
    // 「telepy 還是 ssh？」開在哪一頁：按鈕從任務或主題來時，直接開在那一組工具。/ Which tab the comparison opens on: from a task or a topic, straight on its family of tools.
    const [waysTab, setWaysTab] = useState<WaysTab>(compareParam ?? "ways");
    const openWays = (tab: WaysTab) => {
        setWaysTab(tab);
        setDialog("ways");
    };
    // 搜尋：有字（或選了某個 CLI 主題）時，結果清單取代下面的任務與指令。`?q=` 可以帶著搜尋進來。
    // Search: while there is a query (or a CLI topic is being browsed) the result list replaces the tasks and the command. `?q=` opens with one.
    const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
    // `?topic=<id>` 直接打開某個主題。/ `?topic=<id>` opens a topic directly.
    const [browseTopic, setBrowseTopic] = useState<CliTopicId | null>(() => CLI_EXAMPLE_TOPICS.find((tp) => tp.id === searchParams.get("topic"))?.id ?? null);
    const [wayFilter, setWayFilter] = useState<WayFilter>("all");
    const searching = query.trim() !== "" || browseTopic !== null;
    // 只選了主題、沒有打字：右邊換成那個主題的圖解頁，左邊的清單留著。/ A topic without a query: its illustrated page on the right, the list stays.
    const boardTopic = query.trim() === "" ? browseTopic : null;
    const leaveSearch = () => {
        setQuery("");
        setBrowseTopic(null);
        setWayFilter("all");
    };
    const headId = useId();

    const def = RECIPE_BY_ID[recipe];
    const params = paramsById[recipe];
    const resolved = resolveParams(recipe, params);
    const setParam = (key: string, value: string) => {
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

    const telepyWay = mode === "telepy";
    // 句子與圖裡的裝置名：telepy 用通道名，ssh 用 ~/.ssh/config 的別名。/ The device name: the tunnel for telepy, the Host alias for ssh.
    const alias = telepyWay ? target.tunnel : target.alias;
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
            case "vpn": return resolved.scope === "all" ? tn("sheet.sentence.vpnAll", { device }) : tn("sheet.sentence.vpn", { device, network: blank("network") });
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
            case "vpn": return resolved.scope === "all" ? tn("sheet.caption.vpnAll", { alias: name }) : tn("sheet.caption.vpn", { network: code(resolved.network), alias: name });
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
            case "local":
            case "lan": {
                const web = webNext(recipe === "local" ? resolved.remotePort : resolved.lanPort, resolved.localPort);
                return (
                    <>
                        {telepyWay && <p>{tn("sheet.next.telepyForward", { open: code("--open") })}</p>}
                        <p>{web}</p>
                    </>
                );
            }
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
            case "jump": return <p>{t(telepyWay ? "sheet.next.telepyJump" : "sheet.next.jump")}</p>;
            case "copy": return null;
            case "rustdesk": return <p>{tn("sheet.next.rustdesk", { addr: code(resolved.localPort === "21118" ? "127.0.0.1" : `127.0.0.1:${resolved.localPort}`) })}</p>;
            case "vpn":
                return (
                    <>
                        {!telepyWay && <p>{t("sheet.next.vpnTelepyOnly")}</p>}
                        <p>{t(resolved.scope === "all" ? "sheet.next.vpnAll" : "sheet.next.telepyVpn")}</p>
                        <p className="text-xs">{tn("sheet.next.vpnCheck", { check: code("--check") })}</p>
                    </>
                );
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

    // ---------------------------------------------------------------- page
    const wayLabel = (m: ConnectMode) => t(m === "telepy" ? "sheet.modeTelepy" : m === "alias" ? "sheet.modeAlias" : "sheet.modeDirect");
    const wayHint = (m: ConnectMode) => t(m === "telepy" ? "sheet.way.telepyHint" : m === "alias" ? "sheet.way.aliasHint" : "sheet.way.directHint");
    const account = hasTargetUser ? target.username : null;
    const pickTask = (id: RecipeId) => {
        leaveSearch();
        setDialog(null);
        setRecipe(id);
    };
    const browse = (id: CliTopicId) => {
        setDialog(null);
        setQuery("");
        setBrowseTopic(id);
    };
    // 另一種工具的同一件事（並排看）：telepy ↔ ~/.ssh/config 的 ssh。/ The same task with the other tool, side by side.
    const otherMode: ConnectMode = telepyWay ? "alias" : "telepy";
    const otherSegments = def.telepyOnly ? null : buildSegments(recipe, params, { ...target, mode: otherMode }, options);
    const taskFamily = TASK_FAMILY[recipe];
    const moreTopics = CLI_EXAMPLE_TOPICS.map((tp) => ({ id: tp.id, list: SHEET_CATALOGUE.filter((e) => e.kind === "example" && e.topic === tp.id) })).filter((tp) => tp.list.length > 0);
    // 方向圖用目前填的數字（埠轉發的三種各取對應任務的值）。/ The direction diagram with the numbers filled in.
    const fwd = (id: RecipeId) => resolveParams(id, paramsById[id]);
    const forwardValues: ForwardValues = {
        local: recipe === "lan" ? { local: fwd("lan").localPort, host: fwd("lan").lanHost, port: fwd("lan").lanPort } : recipe === "rustdesk" ? { local: fwd("rustdesk").localPort, host: fwd("rustdesk").lanHost, port: fwd("rustdesk").remotePort } : { local: fwd("local").localPort, host: "localhost", port: fwd("local").remotePort },
        remote: { remote: fwd("remote").devicePort, local: fwd("remote").localPort },
        socks: { local: fwd("socks").localPort },
    };
    const groups = [
        { id: "forward", title: t("sheet.group.forward") },
        { id: "reach", title: t("sheet.group.reach") },
    ] as const;
    const groupHead = "px-2.5 pb-1 pt-3 text-xs text-muted-foreground";
    const rowBase = "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

    // 最上面一列：裝置、帳號、用什麼跑；下面一行說設定好了沒。/ The top row: device, account, what runs it; one line on setup below.
    const topBar = (
        <section className={cn(CARD, "px-4 py-3.5")} aria-label={t("sheet.device")}>
            <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
                <Field label={t("sheet.device")} className="w-full sm:w-72">
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
                    <Field label={t("sheet.targetUser")} className="w-full sm:w-48">
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
                <Field label={t("sheet.way.runWith")} className="max-w-full min-w-0">
                    <div className="flex min-h-10 max-w-full items-center">
                        <Segmented<ConnectMode> value={mode} onChange={actions.setMode} ariaLabel={t("sheet.way.title")} options={CONNECT_MODES.map((m) => ({ value: m, label: wayLabel(m), title: wayHint(m) }))} />
                    </div>
                </Field>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{wayHint(mode)}</p>
            {config && !hasTargetUser && <Callout tone="warning" className="mt-3">{t("sheet.noTargetUser")}</Callout>}
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3 text-sm" role="status">
                {setupLoading ? (
                    <>
                        <span className="size-3.5 animate-spin rounded-full border-b-2 border-muted-foreground" aria-hidden />
                        <span className="text-muted-foreground">{t("sheet.ready.checking")}</span>
                    </>
                ) : (
                    <>
                        <span className={cn("size-2 shrink-0 rounded-full", needsSetup ? "bg-warning" : "bg-success")} aria-hidden />
                        <span className="min-w-0 flex-1 basis-56 text-foreground">
                            {needsSetup ? t("sheet.ready.left", { left: checklist.total - checklist.done, total: checklist.total }) : t("sheet.ready.allSet")}
                        </span>
                        <Button variant={needsSetup ? "outline" : "ghost"} size="sm" onClick={() => setDialog("setup")}>
                            <Settings2 size={15} /> {t(needsSetup ? "sheet.ready.open" : "sheet.ready.review")}
                        </Button>
                    </>
                )}
            </div>
        </section>
    );

    // 左邊的任務清單（內容區夠寬時，看容器不看視窗：顯示大小調大也對）；窄的時候是一個下拉。
    // The task list on the left when the content area is wide enough (a container query, so a larger display size works too); a select otherwise.
    const taskList = (
        <nav className={cn(CARD, "hidden p-1.5 @[52rem]:sticky @[52rem]:top-20 @[52rem]:block")} aria-label={t("sheet.tasks.label")}>
            {groups.map((g) => (
                <div key={g.id}>
                    <h2 className={groupHead}>{g.title}</h2>
                    <ul>
                        {RECIPES.filter((r) => r.group === g.id).map((r) => {
                            const active = r.id === recipe && boardTopic === null;
                            const TaskIcon = TASK_ICON[r.id];
                            return (
                                <li key={r.id}>
                                    <button
                                        type="button"
                                        aria-current={active ? "true" : undefined}
                                        onClick={() => pickTask(r.id)}
                                        className={cn(rowBase, active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted/70")}
                                    >
                                        <TaskIcon size={15} className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
                                        <span className="min-w-0 flex-1 leading-snug">{t(r.title)}</span>
                                        <code className={cn("shrink-0 font-mono text-[0.6875rem]", active ? "text-primary/80" : "text-muted-foreground")}>{r.flag}</code>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}
            {/* telepy CLI 才有的事：照主題列，點了看那個主題的範例。/ What only the telepy CLI does, by topic; a click lists that topic's examples. */}
            <h2 className={groupHead} title={t("sheet.ways.moreHint")}>{t("sheet.ways.more")}</h2>
            <ul>
                {moreTopics.map((tp) => {
                    const active = boardTopic === tp.id;
                    const Icon = TOPIC_ICON[tp.id];
                    return (
                        <li key={tp.id}>
                            <button type="button" aria-current={active ? "true" : undefined} onClick={() => browse(tp.id)} className={cn(rowBase, active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted/70")}>
                                <Icon size={15} className={cn("shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
                                <span className="min-w-0 flex-1 leading-snug">{t(`cli.topic.${tp.id}` as TranslationKey)}</span>
                                <span className={cn("shrink-0 text-xs tabular-nums", active ? "text-primary/80" : "text-muted-foreground")}>{tp.list.length}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
    const taskSelect = (
        <div className="@[52rem]:hidden">
            <Field label={t("sheet.tasks.label")}>
                <Select value={recipe} onValueChange={(v) => pickTask(v as RecipeId)}>
                    <SelectTrigger className="h-10 w-full text-sm" aria-label={t("sheet.tasks.label")}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {RECIPES.map((r) => (
                            <SelectItem key={r.id} value={r.id}>{t(r.title)}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </Field>
        </div>
    );

    // 右邊：這件事的填空句、指令、接著做什麼。/ The right side: this task's sentence, its command and what to do next.
    const commandCard = (
        <section className={cn(CARD, "min-w-0 space-y-4 p-4 sm:p-5")} aria-labelledby={headId}>
            <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h2 id={headId} className="text-lg font-semibold tracking-tight text-foreground">{t(def.title)}</h2>
                        <WayMarks ways={recipeWays(def)} />
                    </div>
                    <p className="text-sm text-muted-foreground">{t("sheet.fillHint")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {/* 同樣是 -L：服務在裝置自己身上，還是在它區網裡的別台主機？一鍵互換。/ Both are -L: is the service on the device itself or on another host in its LAN? One click swaps. */}
                    {(recipe === "local" || recipe === "lan") && (
                        <Segmented<RecipeId>
                            value={recipe}
                            onChange={pickTask}
                            ariaLabel={t("sheet.field.where")}
                            options={[
                                { value: "local", label: t("sheet.field.whereDevice") },
                                { value: "lan", label: t("sheet.field.whereLan") },
                            ]}
                        />
                    )}
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
                    {recipe === "vpn" && (
                        <Segmented
                            value={resolved.scope === "all" ? "all" : "network"}
                            onChange={(v) => setParam("scope", v)}
                            ariaLabel={t("sheet.field.vpnScope")}
                            options={[
                                { value: "network", label: t("sheet.field.vpnScopeNetwork") },
                                { value: "all", label: t("sheet.field.vpnScopeAll") },
                            ]}
                        />
                    )}
                    {def.group === "forward" && (
                        <Button variant="ghost" size="sm" onClick={() => setDialog("directions")}>
                            <Info size={15} /> {t("sheet.group.which")}
                        </Button>
                    )}
                </div>
            </header>
            {/* 填空與指令放在一起：改一個數字，下面的指令馬上跟著變。/ The blanks and the command together: edit a number, the command follows. */}
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
            <div className="space-y-2">
                <CommandBar segments={segments} />
                {otherSegments ? (
                    <div className="grid gap-1.5 pt-1">
                        <span className="text-xs text-muted-foreground">{t(telepyWay ? "sheet.compare.ssh" : "sheet.compare.telepy")}</span>
                        <InlineCommand segments={otherSegments} />
                    </div>
                ) : (
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
                        <span>{t("sheet.compare.telepyOnly")}</span>
                        {!telepyWay && <button type="button" onClick={() => actions.setMode("telepy")} className="text-primary underline underline-offset-2">{t("sheet.compare.useTelepy")}</button>}
                    </p>
                )}
                <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                    {next && (
                        <div className="flex gap-2">
                            <ArrowRight size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                            <div className="min-w-0 flex-1 space-y-2">{next}</div>
                        </div>
                    )}
                    {def.forwarding && (
                        !telepyWay && options.background && spec ? (
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
        </section>
    );

    return (
        <div className="space-y-4 animate-fade-in-up">
            <PageHeader
                icon={<SquareTerminal />}
                title={t("sheet.title")}
                description={t("sheet.subtitle")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => openWays("ways")}>
                            <Scale size={16} /> {t("sheet.ways.button")}
                        </Button>
                    </>
                }
            />

            <SheetSearchBox value={query} onChange={setQuery} />

            {topBar}

            {searching && boardTopic === null ? (
                <SheetResults query={query} topic={browseTopic} way={wayFilter} onWay={setWayFilter} tunnel={target.tunnel} account={account} onTask={pickTask} taskCommand={(id) => segmentsToString(buildSegments(id, paramsById[id], target, options))} onBack={leaveSearch} />
            ) : (
                <div className="@container">
                <div className="grid items-start gap-4 @[52rem]:grid-cols-[15rem_minmax(0,1fr)]">
                    {taskList}
                    {boardTopic !== null ? (
                        <TopicBoard
                            topic={boardTopic}
                            entries={SHEET_CATALOGUE}
                            topics={moreTopics.map((tp) => tp.id)}
                            way={wayFilter}
                            onWay={setWayFilter}
                            tunnel={target.tunnel}
                            account={account}
                            onTopic={browse}
                            onTask={pickTask}
                            onBack={leaveSearch}
                            onCompare={TOPIC_FAMILY[boardTopic] ? () => openWays(TOPIC_FAMILY[boardTopic]!) : undefined}
                        />
                    ) : (
                    <div className="min-w-0 space-y-3">
                        {taskSelect}
                        {commandCard}
                        {scene && (
                            <Disclosure icon={Route} title={t("sheet.more.scene")}>
                                <TunnelScene nodes={scene.nodes} links={scene.links} file={scene.file} caption={caption} />
                            </Disclosure>
                        )}
                        <Disclosure icon={Info} title={t("sheet.more.explain")}>
                            <div className="space-y-2">
                                <AnnotatedCommand segments={segments} />
                                <p className="text-xs text-muted-foreground">{t("sheet.more.explainHint")}</p>
                            </div>
                        </Disclosure>
                        {/* telepy 自己處理這些（等到接通、保持連線）；ssh 的跑法才有。/ telepy handles these itself; only the ssh ways have them. */}
                        {def.forwarding && !telepyWay && (
                            <Disclosure icon={SlidersHorizontal} title={t("sheet.more.options")}>
                                <div className="flex flex-col">
                                    <Switch size="sm" checked={options.background} onCheckedChange={(v) => setOptions((o) => ({ ...o, background: v }))}>{t("sheet.opt.background")}</Switch>
                                    <Switch size="sm" checked={options.keepAlive} onCheckedChange={(v) => setOptions((o) => ({ ...o, keepAlive: v }))}>{t("sheet.opt.keepAlive")}</Switch>
                                    <Switch size="sm" checked={options.exitOnFailure} onCheckedChange={(v) => setOptions((o) => ({ ...o, exitOnFailure: v }))}>{t("sheet.opt.exitOnFailure")}</Switch>
                                </div>
                            </Disclosure>
                        )}
                        <div className="flex flex-wrap gap-x-1 gap-y-1">
                            <Button variant="ghost" size="sm" onClick={() => setDialog("all")}>
                                <ListTree size={15} /> {t("sheet.allCommands")}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setDialog("tips")}>
                                <Lightbulb size={15} /> {t("sheet.more.tips")}
                            </Button>
                            {taskFamily && (
                                <Button variant="ghost" size="sm" onClick={() => openWays(taskFamily)}>
                                    <Scale size={15} /> {t("sheet.overlap.button")}
                                </Button>
                            )}
                        </div>
                        <TopicTiles className="@[52rem]:hidden" topics={moreTopics.map((tp) => ({ id: tp.id, count: tp.list.length }))} onTopic={browse} />
                    </div>
                    )}
                </div>
                </div>
            )}

            <Modal isOpen={dialog === "setup"} onClose={() => setDialog(null)} size="4xl" icon={<Settings2 />} title={t("sheet.ready.title")} description={t("sheet.setup.subtitle")}>
                <div className="space-y-4">
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
                </div>
            </Modal>
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
            <WaysDialog isOpen={dialog === "ways"} onClose={() => setDialog(null)} tab={waysTab} onTab={setWaysTab} entries={SHEET_CATALOGUE} onTask={pickTask} onTopic={browse} />
            <Modal isOpen={dialog === "directions"} onClose={() => setDialog(null)} size="3xl" icon={<Info />} title={t("fwdKinds.title")} description={t("sheet.group.whichHint")}>
                <ForwardKinds active={def.direction ?? null} values={forwardValues} titled={false} />
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
