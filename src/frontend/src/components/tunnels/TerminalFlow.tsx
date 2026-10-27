"use client";

/**
 * 終端機的「現在這裡在做什麼」即時路徑圖：你的瀏覽器 ─ Telepy ─ 裝置 ─ shell（裝置自己的，或經裝置跳到的區網主機）。
 * 每個節點與每段線依目前分頁的階段標成 待命 / 進行中 / 通了 / 卡在這；兩段延遲（你↔Telepy、Telepy↔裝置）標在線上。
 * 選擇器頁（還沒連）也用同一張圖，階段是 idle。積木在 components/flow/PathFlow，純邏輯在 lib/terminalFlow。
 * The terminal's live "what is happening here" path: browser ─ Telepy ─ device ─ shell (on the device or on a LAN
 * host reached through it). Nodes and links follow the active tab's phase; both round trips sit on their links.
 * The picker page shows the same diagram in the idle phase. Blocks in components/flow/PathFlow, logic in lib/terminalFlow.
 */
import React from "react";
import { Laptop, Server, TerminalSquare } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { FlowLink, FlowNode, FlowNow, FlowPath, FlowSteps } from "@/components/flow/PathFlow";
import { terminalSpotStates, terminalStep, type TerminalFailure, type TerminalPhase } from "@/lib/terminalFlow";
import type { TranslationKey } from "@/locales/en";

export interface TerminalFlowContext {
    phase: TerminalPhase;
    failure: TerminalFailure | null;
    deviceName: string;
    /** 裝置上的帳號（區網主機時是跳板那一跳）。/ The device account (the jump hop for a LAN host). */
    account: string;
    /** null = shell 開在裝置上。`auth` = 那一跳怎麼登入，`savedLabel` = 用的存檔名稱。/ null = the shell runs on the device itself. */
    lanHost: { name: string; address: string; port: number; login: string; auth?: "telepy" | "prompt" | "credential"; savedLabel?: string | null } | null;
    /** 你 ↔ Telepy（WebSocket ping）。/ Browser ↔ Telepy. */
    youToServerMs?: number | null;
    /** Telepy ↔ 裝置（monitor 量的隧道延遲）。/ Telepy ↔ device (the monitor's tunnel RTT). */
    serverToDeviceMs?: number | null;
    /** 這條隧道會錄下終端機。/ This tunnel records terminal sessions. */
    recorded?: boolean;
}

const fmt = (ms: number | null | undefined) => (typeof ms === "number" ? `${Math.round(ms)} ms` : undefined);

export function TerminalFlow({ ctx }: { ctx: TerminalFlowContext }) {
    const { t } = useI18n();
    const lan = ctx.lanHost;
    const s = terminalSpotStates(ctx.phase, ctx.failure);
    const step = terminalStep(ctx.phase, ctx.failure, !!lan);
    const account = ctx.account || "?";
    const target = lan ? `${lan.address}:${lan.port}` : "";
    const steps: { key: TranslationKey; vars?: Record<string, string | number> }[] = lan
        ? [
            { key: "terminal.flow.step1", vars: { account, device: ctx.deviceName } },
            { key: "terminal.flow.step2", vars: { device: ctx.deviceName } },
            lan.auth === "prompt"
                ? { key: "terminal.flow.step3LanPrompt", vars: { target, login: lan.login || "?" } }
                : lan.auth === "credential"
                    ? { key: "terminal.flow.step3LanSaved", vars: { target, login: lan.login || "?", label: lan.savedLabel || "?" } }
                    : { key: "terminal.flow.step3Lan", vars: { target, login: lan.login || "?" } },
            { key: "terminal.flow.step4Lan" },
        ]
        : [
            { key: "terminal.flow.step1", vars: { account, device: ctx.deviceName } },
            { key: "terminal.flow.step2", vars: { device: ctx.deviceName } },
            { key: "terminal.flow.step3", vars: { account } },
        ];
    const nowKey: TranslationKey = ctx.phase === "connecting" ? "terminal.flow.now.connecting"
        : ctx.phase === "connected" ? "terminal.flow.now.connected"
            : ctx.phase === "ended" ? "terminal.flow.now.ended"
                : ctx.phase === "failed" ? "terminal.flow.now.failed"
                    : "terminal.flow.now.idle";

    return (
        <div className="space-y-5">
            <FlowNow failed={ctx.phase === "failed"}>
                {t(nowKey)}
                {ctx.phase === "failed" && ctx.failure && <span className="mt-0.5 block text-xs text-muted-foreground">{t(ctx.failure.key, ctx.failure.vars)}</span>}
            </FlowNow>

            <FlowPath>
                <FlowNode icon={Laptop} title={t("flow.you")} sub={t("terminal.flow.youSub")} state={s.browser} />
                <FlowLink label={t("flow.linkWeb")} state={s.web} note={ctx.phase === "connected" ? fmt(ctx.youToServerMs) : undefined} />
                <FlowNode brand title="Telepy" sub={t("terminal.flow.telepySub")} state={s.telepy} />
                <FlowLink label={t("flow.linkTunnel")} state={s.tunnel} note={ctx.phase === "connected" ? fmt(ctx.serverToDeviceMs) : undefined} />
                <FlowNode icon={Server} title={ctx.deviceName} sub={lan ? t("terminal.flow.deviceSubLan", { account }) : t("terminal.flow.deviceSub", { account })} state={s.device} />
                <FlowLink label={lan ? t("terminal.flow.linkLan", { port: lan.port }) : t("terminal.flow.linkShell")} state={s.reach} />
                <FlowNode
                    icon={lan ? Server : TerminalSquare}
                    title={lan ? lan.name : t("terminal.flow.shell")}
                    sub={lan ? t("terminal.flow.targetSubLan", { address: target, login: lan.login || "?" }) : t("terminal.flow.targetSub", { account })}
                    state={s.target}
                />
            </FlowPath>

            <FlowSteps steps={steps.map((st) => t(st.key, st.vars))} current={step} done={ctx.phase === "connected" || ctx.phase === "ended"} failed={ctx.phase === "failed"} />

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{t("terminal.flow.noteInstall")}</li>
                <li>{t("terminal.flow.noteKey")}</li>
                {lan && <li>{t("terminal.flow.noteLanHop")}</li>}
                <li>{t("terminal.flow.noteRules")}</li>
                <li>{t(ctx.recorded ? "terminal.flow.noteRecorded" : "terminal.flow.noteLogged")}</li>
            </ul>
        </div>
    );
}
