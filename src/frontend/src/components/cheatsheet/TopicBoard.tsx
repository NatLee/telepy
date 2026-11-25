"use client";

/**
 * 指令速查「telepy CLI 還能做的事」的主題頁：不是一串字，而是——這個主題的一句話、一張直線路徑圖（這類指令從哪裡
 * 出發、經過 Telepy 的哪一段、到哪裡；埠轉發用它自己的三條方向圖），再來每個範例一列：指令的圖示、標題、
 * telepy / ssh 哪個做得到、說明，以及直接可以複製的彩色指令（多行的範例畫成有順序的步驟）。
 * 窄螢幕沒有左邊的清單：這裡自己帶「回到任務」與主題下拉；`TopicTiles` 是窄螢幕進到主題的那組圖示磚。
 * A topic of "More with the telepy CLI" on the command sheet, drawn instead of listed: the topic's sentence, one
 * straight path diagram (where such a command starts, which part of Telepy it goes through, where it ends; port
 * forwarding uses its own three-direction diagram), then a row per example: the command's icon, its title, which of
 * telepy / ssh can do it, the note, and the coloured command ready to copy (several lines = ordered steps).
 * Narrow screens have no list on the left, so this carries its own "Back to tasks" and topic select; `TopicTiles`
 * is the set of icon tiles that leads into a topic there.
 */
import React from "react";
import Link from "next/link";
import {
    Activity,
    AppWindow,
    ArrowLeft,
    ArrowRight,
    ArrowRightLeft,
    BookOpen,
    Braces,
    Clapperboard,
    Download,
    FileCog,
    Files,
    FolderSync,
    Globe,
    HardDrive,
    KeyRound,
    Keyboard,
    Laptop,
    List,
    LogIn,
    LogOut,
    MonitorPlay,
    Network,
    Play,
    Radar,
    Router,
    Scale,
    Server,
    SquareTerminal,
    Stethoscope,
    Terminal,
    UserRound,
    Users,
    Workflow,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import { CommandLine, ExampleOutput } from "@/components/cli/CliBlocks";
import { WayMarks } from "@/components/cheatsheet/WayMarks";
import { ForwardKinds } from "@/components/flow/ForwardKinds";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { FlagText } from "@/components/ui/flag-text";
import { NativeSelect } from "@/components/ui/native-select";
import { useI18n } from "@/lib/i18n";
import { invokedCommands, topicIntro } from "@/lib/cliGuide";
import { fillTunnel, type CatalogueEntry, type Way } from "@/lib/sheetCatalogue";
import { SPOT_TITLE, TOPIC_SCENES, fillAccount, topicWhat, type SceneSpot } from "@/lib/topicScenes";
import type { CliTopicId } from "@/lib/cliExamples.gen";
import type { RecipeId } from "@/lib/forwardRecipes";
import type { TranslationKey } from "@/locales/en";
import { cn } from "@/lib/utils";

const CARD = "rounded-xl border border-border bg-card shadow-card";
const topicLabel = (id: CliTopicId) => `cli.topic.${id}` as TranslationKey;

/** 主題的圖示（左邊清單、圖示磚、對照表共用）。/ A topic's icon (shared by the list, the tiles and the comparison table). */
export const TOPIC_ICON: Record<CliTopicId, LucideIcon> = {
    everyday: Terminal,
    forward: ArrowRightLeft,
    many: Server,
    files: Files,
    sessions: MonitorPlay,
    toolbox: Wrench,
    network: Radar,
    ci: Workflow,
    setup: LogIn,
};

const SPOT_ICON: Record<Exclude<SceneSpot, "telepy">, LucideIcon> = { you: Laptop, ci: Workflow, device: HardDrive, devices: Server, lan: Router };

/** 範例的圖示：看它第一個呼叫的 telepy 子指令。/ An example's icon, from the first telepy subcommand it calls. */
const COMMAND_ICON: Record<string, LucideIcon> = {
    ls: List,
    status: Activity,
    ssh: Terminal,
    keys: KeyRound,
    config: FileCog,
    forward: ArrowRightLeft,
    vpn: Network,
    exec: Play,
    cp: Files,
    scp: Files,
    rsync: FolderSync,
    sftp: Files,
    sessions: Users,
    recordings: Clapperboard,
    snippets: Wrench,
    run: Play,
    lan: Radar,
    proxy: Globe,
    browse: AppWindow,
    api: Braces,
    login: LogIn,
    whoami: UserRound,
    doctor: Stethoscope,
    completions: Keyboard,
    update: Download,
    examples: BookOpen,
    logout: LogOut,
};

/** 範例第一個呼叫的 telepy 子指令（沒有就空字串）。/ The first telepy subcommand an example calls ("" when none). */
const firstCommand = (lines: readonly string[]): string => lines.flatMap((l) => invokedCommands(l))[0] ?? "";

/** 主題的路徑圖。/ The topic's path diagram. */
function TopicPath({ topic }: { topic: CliTopicId }) {
    const { t } = useI18n();
    if (topic === "forward") return <ForwardKinds titled={false} />;
    const scene = TOPIC_SCENES[topic];
    return (
        <FlowPath>
            {scene.nodes.map((n, i) => (
                <React.Fragment key={i}>
                    {i > 0 && <FlowLink label={t(scene.links[i - 1])} state="ok" />}
                    {n.spot === "telepy" ? (
                        <FlowNode brand title="Telepy" sub={t(n.sub)} plain />
                    ) : (
                        <FlowNode icon={SPOT_ICON[n.spot]} title={t(SPOT_TITLE[n.spot])} sub={t(n.sub)} plain />
                    )}
                </React.Fragment>
            ))}
        </FlowPath>
    );
}

function Example({ entry, tunnel, account }: { entry: CatalogueEntry; tunnel: string; account: string | null }) {
    const { t } = useI18n();
    const Icon = COMMAND_ICON[firstCommand(entry.lines)] ?? SquareTerminal;
    const lines = fillAccount(fillTunnel(entry.lines, tunnel), account);
    return (
        <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 px-4 py-3.5">
            <span className="grid size-9 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>
                <Icon size={18} />
            </span>
            <div className="min-w-0 self-center">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h3 className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{t(entry.title)}</h3>
                        <WayMarks ways={entry.ways} />
                    </div>
                    {entry.note && <p className="text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]"><FlagText text={t(entry.note)} /></p>}
            </div>
            {/* 指令：窄的時候佔整列（圖示那一欄不留白），寬的時候對齊標題。/ The commands: the full row when narrow (no blank icon column), under the title when wide. */}
            <div className="col-span-2 mt-2 min-w-0 @[52rem]:col-span-1 @[52rem]:col-start-2">
                {lines.length === 1 ? (
                    <CommandLine value={lines[0]} />
                ) : (
                    // 多行 = 有順序的幾步：左邊一條直線串起編號。/ Several lines are ordered steps: numbers on one straight rail.
                    <ol className="space-y-1.5">
                        {lines.map((l, i) => (
                            <li key={i} className="relative grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2">
                                {i < lines.length - 1 && <span className="absolute bottom-[-0.375rem] left-[0.625rem] top-7 w-px bg-border" aria-hidden />}
                                <span className="mt-2 grid size-5 place-items-center rounded-full bg-muted text-xs tabular-nums text-muted-foreground" aria-hidden>{i + 1}</span>
                                <CommandLine value={l} />
                            </li>
                        ))}
                    </ol>
                )}
                <ExampleOutput output={entry.output} className="mt-2" />
            </div>
        </li>
    );
}

export type BoardWay = Way | "all";

export interface TopicBoardProps {
    topic: CliTopicId;
    entries: CatalogueEntry[];
    topics: readonly CliTopicId[];
    way: BoardWay;
    onWay: (w: BoardWay) => void;
    /** 填進範例的通道名稱與帳號。/ The tunnel name and account filled into the examples. */
    tunnel: string;
    account: string | null;
    onTopic: (id: CliTopicId) => void;
    onTask: (id: RecipeId) => void;
    onBack: () => void;
    /** 這個主題的工具跟別的工具重疊時：打開「差在哪」。/ When this topic's tools overlap with others: opens the comparison. */
    onCompare?: () => void;
}

export function TopicBoard({ topic, entries, topics, way, onWay, tunnel, account, onTopic, onTask, onBack, onCompare }: TopicBoardProps) {
    const { t } = useI18n();
    const headId = React.useId();
    const Icon = TOPIC_ICON[topic];
    const inTopic = entries.filter((e) => e.topic === topic);
    const tasks = inTopic.filter((e) => e.kind === "task");
    const examples = inTopic.filter((e) => e.kind === "example");
    const shown = examples.filter((e) => way === "all" || e.ways.includes(way));
    const intro = topicIntro(topic);
    const filters: { value: BoardWay; label: string }[] = [
        { value: "all", label: t("sheet.search.filterAll") },
        { value: "telepy", label: "telepy" },
        { value: "ssh", label: "ssh" },
    ];
    const anyPlaceholder = shown.some((e) => fillAccount(fillTunnel(e.lines, tunnel), account).some((l) => /<[^<>\s]+>/.test(l)));
    return (
        <div className="min-w-0 space-y-3">
            {/* 窄螢幕：回到任務 + 換主題。/ Narrow screens: back to the tasks, and the topic select. */}
            <div className="flex flex-wrap items-center gap-2 @[52rem]:hidden">
                <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
                    <ArrowLeft size={15} /> {t("sheet.topic.back")}
                </Button>
                <NativeSelect className="h-9 min-w-0 flex-1 basis-40" aria-label={t("cli.ex.topic")} value={topic} onChange={(e) => onTopic(e.target.value as CliTopicId)}>
                    {topics.map((id) => (
                        <option key={id} value={id}>{t(topicLabel(id))}</option>
                    ))}
                </NativeSelect>
            </div>

            <section className={cn(CARD, "min-w-0 space-y-4 p-4 sm:p-5")} aria-labelledby={headId}>
                <header className="flex items-start gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>
                        <Icon size={20} />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                        <h2 id={headId} className="text-lg font-semibold tracking-tight text-foreground">{t(topicLabel(topic))}</h2>
                        <p className="text-sm leading-relaxed text-muted-foreground"><FlagText text={t(topicWhat(topic))} /></p>
                    </div>
                    {onCompare && (
                        <Button variant="ghost" size="sm" onClick={onCompare} className="hidden shrink-0 @[40rem]:inline-flex">
                            <Scale size={15} /> {t("sheet.overlap.button")}
                        </Button>
                    )}
                </header>
                <TopicPath topic={topic} />
                {onCompare && (
                    <Button variant="ghost" size="sm" onClick={onCompare} className="-ml-2 @[40rem]:hidden">
                        <Scale size={15} /> {t("sheet.overlap.button")}
                    </Button>
                )}
                {intro && <p className="text-sm leading-relaxed text-muted-foreground"><FlagText text={t(intro)} /></p>}
                {tasks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-border pt-3">
                        <span className="mr-1 text-xs text-muted-foreground">{t("sheet.topic.fillable")}</span>
                        {tasks.map((e) => (
                            <Button key={e.id} variant="ghost" size="sm" onClick={() => onTask(e.recipe!)} className="h-auto min-h-8 whitespace-normal py-1 text-left text-primary">
                                {t(e.title)} <ArrowRight size={14} className="shrink-0" />
                            </Button>
                        ))}
                    </div>
                )}
            </section>

            <section className={cn(CARD, "min-w-0")} aria-label={t("sheet.topic.examples")}>
                <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border px-4 py-2.5">
                    <p role="status" className="text-sm text-muted-foreground">{t("sheet.topic.count", { count: shown.length })}</p>
                    <div role="group" aria-label={t("sheet.search.filterLabel")} className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
                        {filters.map((f) => (
                            <button
                                key={f.value}
                                type="button"
                                aria-pressed={way === f.value}
                                onClick={() => onWay(f.value)}
                                className={cn("rounded-md px-2.5 py-1 text-xs transition-colors", f.value !== "all" && "font-mono", way === f.value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </header>
                {shown.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted-foreground">{t("sheet.topic.noneSsh")}</p>
                ) : (
                    <ul className="divide-y divide-border">
                        {shown.map((e) => <Example key={e.id} entry={e} tunnel={tunnel} account={account} />)}
                    </ul>
                )}
                <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                    <span>{anyPlaceholder ? t("sheet.search.fillHint") : ""}</span>
                    <Link href="/tunnels/cli?tab=examples" prefetch={false} className="underline underline-offset-2 hover:text-foreground">{t("sheet.search.openCli")}</Link>
                </footer>
            </section>
        </div>
    );
}

/** 窄螢幕進到主題的圖示磚（寬螢幕是左邊清單裡的那幾列）。/ The icon tiles that lead into a topic on narrow screens (wide ones use the rows in the list). */
export function TopicTiles({ topics, onTopic, className }: { topics: { id: CliTopicId; count: number }[]; onTopic: (id: CliTopicId) => void; className?: string }) {
    const { t } = useI18n();
    const headId = React.useId();
    return (
        <section className={cn(CARD, "space-y-3 p-4", className)} aria-labelledby={headId}>
            <div className="space-y-1">
                <h2 id={headId} className="text-sm text-foreground">{t("sheet.ways.more")}</h2>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("sheet.ways.moreHint")}</p>
            </div>
            <ul className="grid grid-cols-2 gap-2 @[34rem]:grid-cols-3">
                {topics.map((tp) => {
                    const Icon = TOPIC_ICON[tp.id];
                    return (
                        <li key={tp.id} className="min-w-0">
                            <button type="button" onClick={() => onTopic(tp.id)} className="flex h-full w-full min-w-0 flex-col items-start gap-2 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                <span className="flex w-full items-center justify-between gap-2">
                                    <span className="grid size-8 place-items-center rounded-lg bg-muted text-foreground" aria-hidden><Icon size={16} /></span>
                                    <span className="text-xs tabular-nums text-muted-foreground">{tp.count}</span>
                                </span>
                                <span className="min-w-0 max-w-full text-sm leading-snug text-foreground [overflow-wrap:anywhere]">{t(topicLabel(tp.id))}</span>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
