"use client";

/**
 * 遠端瀏覽器的路徑圖：要開的網頁 ─ 裝置 ─①SSH─ Chromium② ─③畫面─ 這個分頁。開始畫面上全灰（說明會怎麼走），按下開始後
 * 同一張圖移到啟動卡片裡、依實際步驟亮起來（轉圈 → 綠勾 / 紅叉），最左邊是這次選的網頁（port 名稱或新分頁）和排隊的分頁。
 * 寬的時候橫排，窄的時候直排；線都是直線。
 * The remote browser's path: the page to open ─ the device ─①SSH─ Chromium② ─③picture─ this tab. Grey on the start
 * screen (how it will go); after Start the same diagram sits in the starting card and lights up with the real steps
 * (spinner → green tick / red cross), with the chosen page (a port's name or a new tab) and any queued tabs on the left.
 * A row when wide, a column when narrow; straight lines only.
 */
import React from "react";
import { AlertTriangle, AppWindow, Check, Cpu, Globe, Loader2, MonitorPlay, X } from "lucide-react";
import type { BrowserStepId, startTarget } from "@/lib/browserStart";
import type { StepState } from "@/lib/progressSteps";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type Target = ReturnType<typeof startTarget>;

export interface BrowserStartPathProps {
    username: string;
    /** 三步的狀態（`browserSteps` 的結果）。/ The three steps' states (from `browserSteps`). */
    steps: { id: BrowserStepId; state: StepState }[];
    /** null = 還沒開始（開始畫面）。/ null = not started yet (the start screen). */
    target: Target | null;
    /** 等開好再開的分頁數。/ Tabs waiting for the browser to come up. */
    queued?: number;
    className?: string;
}

const LINE: Record<StepState, string> = {
    waiting: "bg-border",
    skipped: "bg-border",
    active: "bg-warning",
    done: "bg-success",
    warn: "bg-warning",
    failed: "bg-destructive",
};

function Marker({ n, state }: { n: number; state: StepState }) {
    const { t } = useI18n();
    const base = "relative z-10 grid size-5 shrink-0 place-items-center rounded-full text-[0.6875rem] tabular-nums [&_svg]:size-3";
    if (state === "done") return <span className={cn(base, "bg-success text-success-foreground")} role="img" aria-label={t("steps.state.done")}><Check strokeWidth={3} /></span>;
    if (state === "active") return <span className={cn(base, "bg-card text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("steps.state.active")}><Loader2 className="animate-spin" /></span>;
    if (state === "failed") return <span className={cn(base, "bg-destructive text-destructive-foreground")} role="img" aria-label={t("steps.state.failed")}><X strokeWidth={3} /></span>;
    if (state === "warn") return <span className={cn(base, "bg-warning/15 text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("steps.state.warn")}><AlertTriangle /></span>;
    return <span className={cn(base, "bg-card text-muted-foreground ring-1 ring-inset ring-border")} aria-hidden>{n}</span>;
}

function Node({ icon: Icon, name, sub, marker, tone }: { icon: React.ElementType; name: React.ReactNode; sub?: React.ReactNode; marker?: React.ReactNode; tone?: StepState }) {
    return (
        <li className="flex items-center gap-2.5 @xl:w-24 @xl:shrink-0 @xl:flex-col @xl:gap-1 @xl:text-center">
            <span
                className={cn(
                    "relative grid size-9 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground",
                    tone === "active" ? "border-warning/60 text-warning" : tone === "done" ? "border-success/60 text-success" : tone === "failed" ? "border-destructive/60 text-destructive" : "border-border",
                )}
            >
                <Icon size={18} aria-hidden />
                {marker && <span className="absolute -right-2 -top-2">{marker}</span>}
            </span>
            <span className="min-w-0">
                <span className="block text-sm text-foreground [overflow-wrap:anywhere]">{name}</span>
                {sub && <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{sub}</span>}
            </span>
        </li>
    );
}

/** 兩格之間的直線：可以帶一個步驟記號和一行「走的是什麼」。/ The straight link between two nodes, with an optional step marker and label. */
function Link({ state, marker, label }: { state: StepState; marker?: React.ReactNode; label?: React.ReactNode }) {
    return (
        <li aria-hidden={!label && !marker} className="relative flex min-h-8 items-center gap-2 py-1 pl-2 @xl:min-w-0 @xl:flex-1 @xl:flex-col @xl:gap-1 @xl:py-0 @xl:pl-0 @xl:pt-3.5">
            {/* 直排：左邊一條直線對齊格子中心；橫排：一條橫線在格子中線。/ Column: a vertical line on the nodes' centre; row: a horizontal one. */}
            <span className={cn("absolute bottom-0 left-[1.0625rem] top-0 w-0.5 @xl:hidden", LINE[state])} />
            <span className="relative hidden h-0.5 w-full @xl:block">
                <span className={cn("absolute inset-0", LINE[state])} />
            </span>
            {marker && <span className="relative @xl:absolute @xl:left-1/2 @xl:top-1 @xl:-translate-x-1/2">{marker}</span>}
            {!marker && <span className="size-5 shrink-0 @xl:hidden" />}
            {label && <span className="text-xs text-muted-foreground @xl:mt-1.5 @xl:text-center">{label}</span>}
        </li>
    );
}

export function BrowserStartPath({ username, steps, target, queued = 0, className }: BrowserStartPathProps) {
    const { t } = useI18n();
    const state = (id: BrowserStepId): StepState => steps.find((s) => s.id === id)?.state ?? "waiting";
    const proxy = state("proxy");
    const browser = state("browser");
    const stream = state("stream");

    let targetName: React.ReactNode;
    let targetSub: React.ReactNode = null;
    if (!target) {
        targetName = t("browser.path.target");
        targetSub = t("browser.path.targetIdle");
    } else if (target.kind === "newTab") {
        targetName = t("browser.path.newTab");
    } else if (target.kind === "port") {
        targetName = (
            <>
                <span className="font-mono">:{target.port}</span>
                {target.name && <> {target.name}</>}
            </>
        );
    } else {
        targetName = <span className="font-mono text-xs">{target.text}</span>;
    }
    if (target && queued > 0) targetSub = t("browser.path.queued", { count: queued });

    return (
        <div className={cn("@container", className)}>
            <ol aria-label={t("browser.path.aria")} className="flex flex-col @xl:flex-row @xl:items-start">
                <Node icon={Globe} name={targetName} sub={targetSub} />
                <Link state="waiting" label={target?.kind === "url" ? null : "localhost"} />
                <Node icon={Cpu} name={t("browser.path.device")} sub={username} />
                <Link state={proxy} marker={<Marker n={1} state={proxy} />} label={t("browser.ports.pathVia", { username })} />
                <Node icon={AppWindow} name="Chromium" sub={t("browser.path.chromium")} marker={<Marker n={2} state={browser} />} tone={browser} />
                <Link state={stream} marker={<Marker n={3} state={stream} />} label={t("browser.path.view")} />
                <Node icon={MonitorPlay} name={t("browser.path.tab")} tone={stream === "done" ? "done" : undefined} />
            </ol>
        </div>
    );
}
