"use client";

/**
 * 「看別人的終端機」說明圖：他們的瀏覽器 ─ Telepy ─ 裝置 一條線，你的瀏覽器（在看）從 Telepy 往下接一條分支；
 * 依現在的情境（看 / 申請打字 / 一起打字 / 他們斷線 / 結束）標每一站，下面四件事：能不能打字、誰會知道、錄不錄、
 * 裝置只看到一個登入。直線與直角，寬的時候分支在 Telepy 正下方，窄的時候同一張圖縮成圖示 + 名稱。
 * The watch explainer: their browser ─ Telepy ─ device on one line, your (watching) browser on a branch straight down
 * from Telepy; every spot follows the live phase. Below: can you type, who is told, what is recorded, and that the
 * device sees one login. Straight lines and right angles only.
 */
import React from "react";
import { Bell, Eye, Keyboard, Laptop, MonitorSmartphone, Server, Video, Users } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { FlowNow, STATE_TONE, StateLine } from "@/components/flow/PathFlow";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { useI18n } from "@/lib/i18n";
import type { SpotState } from "@/lib/flow";
import { watchSpots, type WatchPhase } from "@/lib/terminalWatch";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

export interface WatchFlowContext {
    phase: WatchPhase;
    /** 被看的人；沒有 = 通用說明（即時 session 頁）。/ The watched user; none = the generic explainer. */
    user?: string | null;
    account?: string | null;
    device?: string | null;
    /** null = 不知道（通用說明）。/ null = unknown (generic). */
    recorded?: boolean | null;
}

const NODE_BORDER: Record<SpotState, string> = {
    waiting: "border-border",
    active: "border-primary/60",
    ok: "border-success/50",
    failed: "border-destructive/70",
};

function Node({ icon, brand, title, sub, state, className }: { icon?: React.ReactNode; brand?: boolean; title: string; sub?: string; state: SpotState; className?: string }) {
    return (
        <div className={cn("flex min-w-0 flex-col items-center gap-1 rounded-xl border bg-card px-2 py-2.5 text-center", NODE_BORDER[state], className)}>
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg @xl:size-10", brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
                {brand ? <TelepyGlyph size={18} /> : icon}
            </span>
            <span className="max-w-full break-words text-xs leading-tight text-foreground @xl:text-sm" title={title}>{title}</span>
            {sub && <span className="hidden text-xs leading-snug text-muted-foreground @xl:block">{sub}</span>}
            <StateLine state={state} className="hidden @md:inline-flex" />
        </div>
    );
}

/** 直線一段（橫或直）；`double` = 隧道 / SSH 那種雙線。/ One straight segment, horizontal or vertical. */
function Line({ state, vertical, double }: { state: SpotState; vertical?: boolean; double?: boolean }) {
    const motion = !useReducedMotion();
    const dash = state === "waiting" ? "4 5" : state === "failed" ? "2 6" : "7 5";
    const animate = motion && (state === "active" || state === "ok");
    const coords = (offset: number) => (vertical ? { x1: 3 + offset, y1: 0, x2: 3 + offset, y2: 100 } : { x1: 0, y1: 3 + offset, x2: 100, y2: 3 + offset });
    return (
        <svg className={cn(vertical ? "h-10 w-3" : "h-3 w-full", STATE_TONE[state])} viewBox={vertical ? "0 0 6 100" : "0 0 100 6"} preserveAspectRatio="none" aria-hidden>
            {(double ? [-1.5, 1.5] : [0]).map((o) => (
                <line key={o} {...coords(o)} stroke="currentColor" strokeWidth={double ? 1.5 : 2} strokeDasharray={double ? undefined : dash} vectorEffect="non-scaling-stroke">
                    {animate && !double && <animate attributeName="stroke-dashoffset" values="48;0" dur="2s" repeatCount="indefinite" />}
                </line>
            ))}
        </svg>
    );
}

const NOW: Record<WatchPhase, TranslationKey> = {
    connecting: "watch.flow.now.connecting",
    watching: "watch.flow.now.watching",
    requested: "watch.flow.now.requested",
    control: "watch.flow.now.control",
    detached: "watch.flow.now.detached",
    ended: "watch.flow.now.ended",
    refused: "watch.flow.now.refused",
};

const KEYS_TEXT: Record<"off" | "asking" | "on", TranslationKey> = {
    off: "watch.flow.keysOff",
    asking: "watch.flow.keysAsking",
    on: "watch.flow.keysOn",
};

export function WatchFlow({ ctx }: { ctx: WatchFlowContext }) {
    const { t } = useI18n();
    const s = watchSpots(ctx.phase);
    const user = ctx.user || t("watch.flow.someone");
    const account = ctx.account || t("watch.flow.anAccount");
    const facts: { icon: React.ReactNode; key: TranslationKey; vars?: Record<string, string>; lit?: boolean }[] = [
        { icon: <Keyboard size={15} />, key: KEYS_TEXT[s.yourKeys], vars: { user }, lit: s.yourKeys !== "off" },
        { icon: <Bell size={15} />, key: "watch.flow.factTold", vars: { user } },
        {
            icon: <Video size={15} />,
            key: ctx.recorded === true ? "watch.flow.factRecorded" : ctx.recorded === false ? "watch.flow.factNotRecorded" : "watch.flow.factMaybeRecorded",
        },
        { icon: <Users size={15} />, key: "watch.flow.factOneLogin", vars: { account } },
    ];
    return (
        <div className="space-y-5">
            <FlowNow failed={ctx.phase === "refused"}>{t(NOW[ctx.phase], { user })}</FlowNow>

            {/* 上排：他們 ─ Telepy ─ 裝置；Telepy 正下方往下一條線到你。/ Top row, then a branch straight down from Telepy. */}
            <div className="@container">
                <div className="grid grid-cols-[minmax(0,1fr)_2.5rem_minmax(0,1fr)_2.5rem_minmax(0,1fr)] items-center @xl:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)_6rem_minmax(0,1fr)]">
                    <Node icon={<Laptop size={18} />} title={t("watch.flow.their", { user })} sub={t("watch.flow.theirSub")} state={s.theirBrowser} />
                    <div className="flex flex-col items-center gap-1 px-1">
                        <Line state={s.theirLink} />
                        <span className="hidden text-center text-xs leading-tight text-muted-foreground @xl:block">{t("watch.flow.linkTheirs")}</span>
                    </div>
                    <Node brand title="Telepy" sub={t("watch.flow.telepySub")} state={s.telepy} />
                    <div className="flex flex-col items-center gap-1 px-1">
                        <Line state={s.deviceLink} double />
                        <span className="hidden text-center text-xs leading-tight text-muted-foreground @xl:block">{t("watch.flow.linkDevice", { account })}</span>
                    </div>
                    <Node icon={<Server size={18} />} title={ctx.device || t("watch.flow.device")} sub={t("watch.flow.deviceSub", { account })} state={s.device} />

                    <div className="col-start-3 flex items-center justify-center gap-2">
                        <Line state={s.yourLink} vertical />
                        <span className={cn("text-xs leading-tight", s.yourKeys === "on" ? "text-primary" : "text-muted-foreground")}>
                            {s.yourKeys === "on" ? t("watch.flow.linkYoursControl") : s.yourKeys === "asking" ? t("watch.flow.linkYoursAsking") : t("watch.flow.linkYours")}
                        </span>
                    </div>
                    <Node
                        icon={s.yourKeys === "on" ? <Keyboard size={18} /> : <Eye size={18} />}
                        title={t("watch.flow.you")}
                        sub={t(s.yourKeys === "on" ? "watch.flow.youSubControl" : "watch.flow.youSub")}
                        state={s.yourBrowser}
                        className="col-start-3"
                    />
                </div>
            </div>

            <ul className="space-y-2 border-t border-border pt-4 text-sm">
                {facts.map((f) => (
                    <li key={f.key} className={cn("flex gap-2.5 rounded-md border px-3 py-2", f.lit ? "border-primary/40 bg-primary/5 text-foreground" : "border-transparent text-muted-foreground")}>
                        <span className="mt-0.5 shrink-0" aria-hidden>{f.icon}</span>
                        <span>{t(f.key, f.vars)}</span>
                    </li>
                ))}
                <li className="flex gap-2.5 px-3 text-muted-foreground">
                    <MonitorSmartphone size={15} className="mt-0.5 shrink-0" aria-hidden />
                    <span>{t("watch.flow.factWho")}</span>
                </li>
            </ul>
        </div>
    );
}
