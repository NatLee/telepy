"use client";

/**
 * 「現在這裡在做什麼」的即時路徑圖：你的瀏覽器 ─ Telepy（guacd）─ 裝置（sshd）─ 桌面。
 * 每個節點與每段線依目前階段標成 待命 / 進行中 / 通了 / 卡在這；進行中的線有流動的虛線（減少動態時不動）。
 * 寬容器橫向、窄容器直向（container query）。下面的步驟清單跟著階段亮起目前那一步。
 * Live "what is happening here" path: your browser ─ Telepy (guacd) ─ device (sshd) ─ desktop. Every node and link
 * is waiting / active / ok / failed for the current phase; active links animate (not under reduced motion).
 * Horizontal in a wide container, vertical in a narrow one. The step list below highlights the current step.
 */
import React from "react";
import { CheckCircle2, CircleDashed, Laptop, Loader2, Monitor, Server, XCircle, type LucideIcon } from "lucide-react";
import { TelepyGlyph } from "@/components/brand/TelepyGlyph";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/hooks/useReducedMotion";
import { spotStates, type ClipboardPolicy, type DesktopFailure, type DesktopPhase, type DesktopProtocol, type FlowSpot, type SpotState } from "@/lib/desktop";
import type { TranslationKey } from "@/locales/en";

export interface FlowContext {
    phase: DesktopPhase;
    failure: DesktopFailure | null;
    protocol: DesktopProtocol;
    port: number;
    deviceName: string;
    /** 裝置那一跳的帳號。/ The device account for the hop. */
    account: string;
    /** null = 裝置自己。/ null = the device itself. */
    lanHost: { name: string; address: string } | null;
    clipboard: ClipboardPolicy | null;
}

const STATE_TEXT: Record<SpotState, TranslationKey> = {
    waiting: "desktop.flow.state.waiting",
    active: "desktop.flow.state.active",
    ok: "desktop.flow.state.ok",
    failed: "desktop.flow.state.failed",
};

const STATE_ICON: Record<SpotState, LucideIcon> = { waiting: CircleDashed, active: Loader2, ok: CheckCircle2, failed: XCircle };

const STATE_TONE: Record<SpotState, string> = {
    waiting: "text-muted-foreground",
    active: "text-primary",
    ok: "text-success",
    failed: "text-destructive",
};

const NODE_BORDER: Record<SpotState, string> = {
    waiting: "border-border",
    active: "border-primary/60",
    ok: "border-success/50",
    failed: "border-destructive/70",
};

function StateLine({ state }: { state: SpotState }) {
    const { t } = useI18n();
    const Icon = STATE_ICON[state];
    return (
        <span className={cn("inline-flex items-center gap-1 text-xs", STATE_TONE[state])}>
            <Icon size={13} className={state === "active" ? "animate-spin" : undefined} aria-hidden />
            {t(STATE_TEXT[state])}
        </span>
    );
}

function Node({ icon, brand, title, sub, state }: { icon?: LucideIcon; brand?: boolean; title: string; sub: string; state: SpotState }) {
    const Icon = icon;
    return (
        <li className={cn("flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-3 py-3 text-center @3xl:flex-1 @3xl:basis-0", NODE_BORDER[state])}>
            <span className={cn("grid size-10 place-items-center rounded-lg", brand ? "bg-brand-gradient text-white" : "bg-muted text-foreground")} aria-hidden>
                {brand ? <TelepyGlyph size={22} /> : Icon ? <Icon size={20} /> : null}
            </span>
            <span className="max-w-full truncate text-sm text-foreground" title={title}>{title}</span>
            <span className="text-xs leading-snug text-muted-foreground">{sub}</span>
            <StateLine state={state} />
        </li>
    );
}

function Link({ label, state, motion }: { label: string; state: SpotState; motion: boolean }) {
    const animate = motion && (state === "active" || state === "ok");
    const dash = state === "waiting" ? "4 5" : state === "failed" ? "2 6" : "7 5";
    const line = (vertical: boolean) => (
        <svg
            className={cn(vertical ? "h-10 w-3 @3xl:hidden" : "hidden h-3 w-full @3xl:block", STATE_TONE[state])}
            viewBox={vertical ? "0 0 6 100" : "0 0 100 6"}
            preserveAspectRatio="none"
            aria-hidden
        >
            <line x1={vertical ? 3 : 0} y1={vertical ? 0 : 3} x2={vertical ? 3 : 100} y2={vertical ? 100 : 3} stroke="currentColor" strokeWidth={2} strokeDasharray={dash} vectorEffect="non-scaling-stroke">
                {animate && <animate attributeName="stroke-dashoffset" values={state === "active" ? "24;0" : "48;0"} dur={state === "active" ? "0.8s" : "2s"} repeatCount="indefinite" />}
            </line>
        </svg>
    );
    return (
        <li className="flex min-w-0 flex-row items-center gap-3 px-6 @3xl:w-24 @3xl:shrink-0 @3xl:flex-col @3xl:gap-1 @3xl:px-1.5" aria-label={label}>
            {line(true)}
            {line(false)}
            <span className={cn("text-xs leading-tight @3xl:text-center", state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {state === "failed" && <XCircle size={12} className="mr-1 inline-block align-[-2px]" aria-hidden />}
                {label}
            </span>
        </li>
    );
}

/** 目前在做的那一步（0 = 還沒開始；1–4 對應步驟清單）。/ The step in progress (0 = not started). */
function currentStep(phase: DesktopPhase, failure: DesktopFailure | null): number {
    if (phase === "starting") return 1;
    if (phase === "connecting") return 3;
    if (phase === "connected") return 4;
    if (phase === "failed" && failure) {
        if (failure.at === "web") return 2;
        if (failure.at === "target") return 3;
        return 1;
    }
    return 0;
}

export function DesktopFlow({ ctx }: { ctx: FlowContext }) {
    const { t } = useI18n();
    const motion = !useReducedMotion();
    const s: Record<FlowSpot, SpotState> = spotStates(ctx.phase, ctx.failure);
    const proto = ctx.protocol === "rdp" ? "RDP" : "VNC";
    const target = ctx.lanHost ? `${ctx.lanHost.address}:${ctx.port}` : `127.0.0.1:${ctx.port}`;
    const step = currentStep(ctx.phase, ctx.failure);
    const steps: { key: TranslationKey; vars?: Record<string, string | number> }[] = [
        { key: "desktop.flow.step1", vars: { account: ctx.account || "?", device: ctx.deviceName, target } },
        { key: "desktop.flow.step2" },
        { key: "desktop.flow.step3", vars: { protocol: proto } },
        { key: "desktop.flow.step4" },
    ];
    const nowKey: TranslationKey =
        ctx.phase === "starting" ? "desktop.flow.now.starting"
            : ctx.phase === "connecting" ? "desktop.flow.now.connecting"
                : ctx.phase === "connected" ? "desktop.flow.now.connected"
                    : ctx.phase === "failed" ? "desktop.flow.now.failed"
                        : "desktop.flow.now.idle";

    return (
        <div className="space-y-5">
            <p className={cn("rounded-md border px-3 py-2 text-sm", ctx.phase === "failed" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-surface text-foreground")} role="status">
                {t(nowKey)}
                {ctx.phase === "failed" && ctx.failure && <span className="mt-0.5 block text-xs text-muted-foreground">{t(ctx.failure.key, ctx.failure.vars)}</span>}
            </p>

            <div className="@container">
                <ol className="flex flex-col items-stretch @3xl:flex-row @3xl:items-center">
                    <Node icon={Laptop} title={t("desktop.flow.you")} sub={t("desktop.flow.youSub")} state={s.browser} />
                    <Link label={t("desktop.flow.linkWeb")} state={s.web} motion={motion} />
                    <Node brand title="Telepy" sub={t("desktop.flow.telepySub", { protocol: proto })} state={s.telepy} />
                    <Link label={t("desktop.flow.linkTunnel")} state={s.tunnel} motion={motion} />
                    <Node icon={Server} title={ctx.deviceName} sub={t("desktop.flow.deviceSub")} state={s.device} />
                    <Link label={ctx.lanHost ? t("desktop.flow.linkLan", { port: ctx.port }) : t("desktop.flow.linkLocal", { port: ctx.port })} state={s.reach} motion={motion} />
                    <Node
                        icon={Monitor}
                        title={ctx.lanHost ? ctx.lanHost.name : t("desktop.flow.deviceDesktop")}
                        sub={t("desktop.flow.targetSub", { protocol: proto, address: target })}
                        state={s.target}
                    />
                </ol>
            </div>

            <ol className="space-y-2">
                {steps.map((st, i) => {
                    const n = i + 1;
                    const current = n === step;
                    const done = step > n || ctx.phase === "connected";
                    const failedHere = current && ctx.phase === "failed";
                    return (
                        <li
                            key={st.key}
                            className={cn(
                                "flex gap-3 rounded-md border px-3 py-2 text-sm leading-relaxed",
                                failedHere ? "border-destructive/50 bg-destructive/5" : current ? "border-primary/50 bg-primary/5" : "border-transparent",
                            )}
                            aria-current={current ? "step" : undefined}
                        >
                            <span
                                className={cn(
                                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums",
                                    failedHere ? "bg-destructive text-destructive-foreground" : done ? "bg-success text-success-foreground" : current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                                )}
                                aria-hidden
                            >
                                {n}
                            </span>
                            <span className={current || done ? "text-foreground" : "text-muted-foreground"}>{t(st.key, st.vars)}</span>
                        </li>
                    );
                })}
            </ol>

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{t("desktop.flow.noteCredentials")}</li>
                <li>{t(ctx.clipboard === "off" ? "desktop.flow.noteClipboardOff" : ctx.clipboard === "to_remote" ? "desktop.flow.noteClipboardToRemote" : "desktop.flow.noteClipboardBoth")}</li>
                <li>{t("desktop.flow.noteLogged")}</li>
                <li>{t("desktop.flow.noteDevice")}</li>
            </ul>
        </div>
    );
}
