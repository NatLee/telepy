"use client";

/**
 * 遠端瀏覽器的三個步驟站：①經由裝置開代理 ─ ②啟動 Chromium ─ ③在這裡顯示畫面。每站一樣的畫法：編號在圖示正上方，
 * 站名、一行說明；站與站之間一條直線，前一站做完就變綠。開始畫面上全灰（說明會怎麼走），按下開始後同一張圖移到啟動
 * 卡片裡、依實際步驟亮起來（轉圈 → 綠勾 / 紅叉）。圖下方置中一行：這次要開的網頁（port 名稱、網址或新分頁）和排隊的分頁數。
 * 一排只有三欄，手機上也放得下。
 * The remote browser's three step stations: ① open a proxy through the device ─ ② start Chromium ─ ③ show the picture
 * here. Every station is drawn the same way: the number right above the icon, a name and one line; a straight line
 * joins the stations and turns green once the one before is done. Grey on the start screen (how it will go); after Start
 * the same diagram sits in the starting card and lights up with the real steps (spinner → green tick / red cross). One
 * centred line below says what opens (a port's name, a URL or a new tab) and how many tabs are queued. Three columns
 * only, so it fits a phone too.
 */
import React from "react";
import { AlertTriangle, AppWindow, Check, Loader2, MonitorPlay, Route, X } from "lucide-react";
import type { BrowserStepId, startTarget } from "@/lib/browserStart";
import type { StepState } from "@/lib/progressSteps";
import type { TranslationKey } from "@/locales/en";
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

function Marker({ n, state }: { n: number; state: StepState }) {
    const { t } = useI18n();
    const base = "grid size-6 shrink-0 place-items-center rounded-full text-xs tabular-nums [&_svg]:size-3.5";
    if (state === "done") return <span className={cn(base, "bg-success text-success-foreground")} role="img" aria-label={t("steps.state.done")}><Check strokeWidth={3} /></span>;
    if (state === "active") return <span className={cn(base, "bg-card text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("steps.state.active")}><Loader2 className="animate-spin" /></span>;
    if (state === "failed") return <span className={cn(base, "bg-destructive text-destructive-foreground")} role="img" aria-label={t("steps.state.failed")}><X strokeWidth={3} /></span>;
    if (state === "warn") return <span className={cn(base, "bg-warning/15 text-warning ring-1 ring-inset ring-warning/60")} role="img" aria-label={t("steps.state.warn")}><AlertTriangle /></span>;
    return <span className={cn(base, "bg-card text-muted-foreground ring-1 ring-inset ring-border")} aria-hidden>{n}</span>;
}

const STATIONS: { id: BrowserStepId; icon: React.ElementType; sub: TranslationKey }[] = [
    { id: "proxy", icon: Route, sub: "browser.ports.pathVia" },
    { id: "browser", icon: AppWindow, sub: "browser.path.chromium" },
    { id: "stream", icon: MonitorPlay, sub: "browser.path.view" },
];

export function BrowserStartPath({ username, steps, target, queued = 0, className }: BrowserStartPathProps) {
    const { t } = useI18n();
    const state = (id: BrowserStepId): StepState => steps.find((s) => s.id === id)?.state ?? "waiting";

    let page: React.ReactNode;
    if (!target) page = t("browser.path.targetIdle");
    else if (target.kind === "newTab") page = t("browser.path.newTab");
    else if (target.kind === "port") page = <><span className="font-mono">:{target.port}</span>{target.name && <> {target.name}</>}</>;
    else page = <span className="font-mono">{target.text}</span>;

    return (
        <div className={cn("@container space-y-3", className)}>
            <ol aria-label={t("browser.path.aria")} className="grid grid-cols-3">
                {STATIONS.map(({ id, icon: Icon, sub }, i) => {
                    const s = state(id);
                    // 站與站之間的線：前一站做完就是綠的。/ The line between stations: green once the station before is done.
                    const before = i > 0 && state(STATIONS[i - 1].id) === "done";
                    const after = s === "done";
                    return (
                        <li key={id} className="relative flex min-w-0 flex-col items-center gap-1.5 text-center">
                            <Marker n={i + 1} state={s} />
                            <span className="relative flex w-full justify-center">
                                {/* 左右兩半條線對齊圖示的中線。/ Two half-lines on the icon's centre line. */}
                                {i > 0 && <span className={cn("absolute left-0 right-1/2 top-1/2 h-0.5 -translate-y-1/2", before ? "bg-success" : "bg-border")} aria-hidden />}
                                {i < STATIONS.length - 1 && <span className={cn("absolute left-1/2 right-0 top-1/2 h-0.5 -translate-y-1/2", after ? "bg-success" : "bg-border")} aria-hidden />}
                                <span
                                    className={cn(
                                        "relative grid size-10 place-items-center rounded-md border bg-card text-muted-foreground",
                                        s === "active" ? "border-warning/60 text-warning" : s === "done" ? "border-success/60 text-success" : s === "failed" ? "border-destructive/60 text-destructive" : "border-border",
                                    )}
                                >
                                    <Icon size={20} aria-hidden />
                                </span>
                            </span>
                            <span className="max-w-full break-words px-1 text-xs leading-snug text-balance text-foreground @sm:text-sm">{t(`browser.step.${id}` as TranslationKey, { username })}</span>
                            <span className="max-w-full break-words px-1 text-xs leading-snug text-muted-foreground">{t(sub, { username })}</span>
                        </li>
                    );
                })}
            </ol>
            <p className="text-center text-xs text-muted-foreground">
                <span>{t("browser.path.opens")}</span>{" "}
                <span className="text-foreground">{page}</span>
                {target && queued > 0 && <span> · {t("browser.path.queued", { count: queued })}</span>}
            </p>
        </div>
    );
}
