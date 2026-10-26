"use client";

/**
 * 「現在這裡在做什麼」的即時路徑圖：你的瀏覽器 ─ Telepy（guacd）─ 裝置（sshd）─ 桌面。
 * 每個節點與每段線依目前階段標成 待命 / 進行中 / 通了 / 卡在這；進行中的線有流動的虛線（減少動態時不動）。
 * 寬容器橫向、窄容器直向（container query）。下面的步驟清單跟著階段亮起目前那一步。積木在 components/flow/PathFlow。
 * Live "what is happening here" path: your browser ─ Telepy (guacd) ─ device (sshd) ─ desktop. Every node and link
 * is waiting / active / ok / failed for the current phase; active links animate (not under reduced motion).
 * Horizontal in a wide container, vertical in a narrow one. The step list below highlights the current step.
 * The building blocks live in components/flow/PathFlow.
 */
import React from "react";
import { Laptop, Monitor, Server } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { FlowLink, FlowNode, FlowNow, FlowPath, FlowSteps } from "@/components/flow/PathFlow";
import { spotStates, type ClipboardPolicy, type DesktopFailure, type DesktopMode, type DesktopPhase, type FlowSpot, type SpotState } from "@/lib/desktop";
import { formatMs, laggingHop, type StreamStats } from "@/lib/desktopStats";
import type { TranslationKey } from "@/locales/en";

export interface FlowContext {
    phase: DesktopPhase;
    failure: DesktopFailure | null;
    /** RDP / VNC 由 guacd 畫在瀏覽器裡；RustDesk 只轉發埠，桌面在 RustDesk app 裡。/ RustDesk is forwarded, not rendered. */
    protocol: DesktopMode;
    port: number;
    deviceName: string;
    /** 裝置那一跳的帳號。/ The device account for the hop. */
    account: string;
    /** null = 裝置自己。/ null = the device itself. */
    lanHost: { name: string; address: string } | null;
    /** 這個 session（或下一個）的剪貼簿方向。/ The clipboard direction of this (or the next) session. */
    clipboard: ClipboardPolicy | null;
    /** 管理員的上限把使用者的選擇收窄了。/ The site's limit narrowed the user's choice. */
    clipboardLimited?: boolean;
    /** 用憑證庫的登入（密碼只在伺服器上解開）。/ Using a saved login (unsealed on the server only). */
    savedLogin?: boolean;
    /** 連線中的串流統計：每段線標上往返時間，最慢的那段標黃。/ Live stats: a round trip on each link. */
    stats?: StreamStats | null;
    /** RustDesk 在瀏覽器裡連（核心在這個分頁，Telepy 中繼）而不是用 app。/ RustDesk in this tab through Telepy's relay, not the app. */
    inBrowser?: boolean;
}

/** 剪貼簿那一行說明：guacd（貼上按鈕、伺服器把關）或 RustDesk 核心（分頁有焦點時自動同步）。
 *  The clipboard note: guacd (Paste button, enforced on the server) or the RustDesk core (syncs while the tab is focused). */
function clipboardNote(clipboard: ClipboardPolicy | null, engine: "guacd" | "rustdesk"): TranslationKey {
    if (clipboard === "off") return "desktop.flow.noteClipboardOff";
    if (clipboard === "to_remote") return engine === "rustdesk" ? "desktop.flow.rdb.noteClipboardToRemote" : "desktop.flow.noteClipboardToRemote";
    return engine === "rustdesk" ? "desktop.flow.rdb.noteClipboard" : "desktop.flow.noteClipboardBoth";
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

/** 網頁內 RustDesk 的那一步（三步）。/ The in-browser RustDesk step (three steps). */
function currentRustDeskStep(phase: DesktopPhase, failure: DesktopFailure | null): number {
    if (phase === "starting") return 1;
    if (phase === "connecting") return 2;
    if (phase === "connected") return 3;
    if (phase === "failed" && failure) {
        if (failure.at === "web") return 2;
        if (failure.at === "target") return 3;
        return 1;
    }
    return 0;
}

export function DesktopFlow({ ctx }: { ctx: FlowContext }) {
    const { t } = useI18n();
    const s: Record<FlowSpot, SpotState> = spotStates(ctx.phase, ctx.failure);
    const rdBrowser = ctx.protocol === "rustdesk" && !!ctx.inBrowser;
    const rustdesk = ctx.protocol === "rustdesk" && !rdBrowser;
    const proto = ctx.protocol === "rdp" ? "RDP" : ctx.protocol === "vnc" ? "VNC" : "RustDesk";
    const target = ctx.lanHost ? `${ctx.lanHost.address}:${ctx.port}` : `127.0.0.1:${ctx.port}`;
    const step = rustdesk
        ? (ctx.phase === "idle" ? 0 : ctx.phase === "failed" && ctx.failure ? (ctx.failure.at === "web" ? 1 : 2) : ctx.phase === "connected" ? 3 : 2)
        : rdBrowser ? currentRustDeskStep(ctx.phase, ctx.failure) : currentStep(ctx.phase, ctx.failure);
    const steps: { key: TranslationKey; vars?: Record<string, string | number> }[] = rustdesk
        ? [
            { key: "desktop.flow.rd.step1", vars: { device: ctx.deviceName } },
            { key: "desktop.flow.rd.step2", vars: { account: ctx.account || "?", target } },
            { key: "desktop.flow.rd.step3" },
        ]
        : rdBrowser ? [
            { key: "desktop.flow.rdb.step1", vars: { account: ctx.account || "?", device: ctx.deviceName, target } },
            { key: "desktop.flow.rdb.step2" },
            { key: "desktop.flow.rdb.step3" },
        ]
        : [
            { key: "desktop.flow.step1", vars: { account: ctx.account || "?", device: ctx.deviceName, target } },
            { key: "desktop.flow.step2" },
            { key: "desktop.flow.step3", vars: { protocol: proto } },
            { key: "desktop.flow.step4" },
        ];
    const nowKey: TranslationKey = rustdesk
        ? (ctx.phase === "starting" || ctx.phase === "connecting" ? "desktop.flow.now.rd.starting"
            : ctx.phase === "connected" ? "desktop.flow.now.rd.connected"
                : ctx.phase === "failed" ? "desktop.flow.now.rd.failed"
                    : "desktop.flow.now.rd.idle")
        : ctx.phase === "starting" ? "desktop.flow.now.starting"
            : ctx.phase === "connecting" ? "desktop.flow.now.connecting"
                : ctx.phase === "connected" ? "desktop.flow.now.connected"
                    : ctx.phase === "failed" ? "desktop.flow.now.failed"
                        : "desktop.flow.now.idle";
    const stats = ctx.phase === "connected" ? ctx.stats ?? null : null;
    const where = stats ? laggingHop(stats) : null;
    const whereKey: TranslationKey | null = where === "web" ? "desktop.stats.where.web" : where === "tunnel" ? "desktop.stats.where.tunnel" : where === "browser" ? "desktop.stats.where.browser" : null;

    return (
        <div className="space-y-5">
            <FlowNow failed={ctx.phase === "failed"}>
                {t(nowKey)}
                {ctx.phase === "failed" && ctx.failure && <span className="mt-0.5 block text-xs text-muted-foreground">{t(ctx.failure.key, ctx.failure.vars)}</span>}
                {stats && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t("desktop.stats.flowLine", { frame: formatMs(stats.frameMs), fps: stats.fps })}
                        {whereKey && ` ${t(whereKey)}`}
                    </span>
                )}
            </FlowNow>

            <FlowPath>
                <FlowNode icon={Laptop} title={rustdesk ? t("desktop.flow.rd.you") : t("flow.you")} sub={rustdesk ? t("desktop.flow.rd.youSub") : rdBrowser ? t("desktop.flow.rdb.youSub") : t("desktop.flow.youSub")} state={s.browser} />
                <FlowLink label={rustdesk ? t("desktop.flow.rd.linkSsh") : t("flow.linkWeb")} state={s.web} note={stats ? formatMs(stats.netMs) : undefined} slow={where === "web"} />
                <FlowNode brand title="Telepy" sub={rustdesk ? t("desktop.flow.rd.telepySub") : rdBrowser ? t("desktop.flow.rdb.telepySub") : t("desktop.flow.telepySub", { protocol: proto })} state={s.telepy} />
                <FlowLink label={t("flow.linkTunnel")} state={s.tunnel} note={stats ? formatMs(stats.tunnelMs) : undefined} slow={where === "tunnel"} />
                <FlowNode icon={Server} title={ctx.deviceName} sub={t("desktop.flow.deviceSub")} state={s.device} />
                <FlowLink label={ctx.lanHost ? t("desktop.flow.linkLan", { port: ctx.port }) : t("desktop.flow.linkLocal", { port: ctx.port })} state={s.reach} />
                <FlowNode
                    icon={Monitor}
                    title={ctx.lanHost ? ctx.lanHost.name : t("desktop.flow.deviceDesktop")}
                    sub={rustdesk || rdBrowser ? t("desktop.flow.rd.targetSub", { address: target }) : t("desktop.flow.targetSub", { protocol: proto, address: target })}
                    state={s.target}
                />
            </FlowPath>

            <FlowSteps steps={steps.map((st) => t(st.key, st.vars))} current={step} done={ctx.phase === "connected"} failed={ctx.phase === "failed"} />

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                {rustdesk ? (
                    <>
                        <li>{t("desktop.flow.rd.notePrivate")}</li>
                        <li>{t("desktop.flow.rd.noteDirectIp")}</li>
                        <li>{t("desktop.flow.noteDevice")}</li>
                    </>
                ) : rdBrowser ? (
                    <>
                        <li>{t(ctx.savedLogin ? "desktop.flow.rdb.noteVault" : "desktop.flow.rdb.notePassword")}</li>
                        <li>{t("desktop.flow.rdb.noteEngine")}</li>
                        <li>{t(clipboardNote(ctx.clipboard, "rustdesk"))}{ctx.clipboardLimited && <> {t("desktop.flow.noteClipboardLimited")}</>}</li>
                        <li>{t("desktop.flow.rd.noteDirectIp")}</li>
                        <li>{t("desktop.flow.noteLogged")}</li>
                    </>
                ) : (
                    <>
                        <li>{t(ctx.savedLogin ? "desktop.flow.noteVault" : "desktop.flow.noteCredentials")}</li>
                        <li>{t(clipboardNote(ctx.clipboard, "guacd"))}{ctx.clipboardLimited && <> {t("desktop.flow.noteClipboardLimited")}</>}</li>
                        <li>{t("desktop.flow.noteLogged")}</li>
                        <li>{t("desktop.flow.noteDevice")}</li>
                        <li>{t("desktop.flow.noteIme")}</li>
                    </>
                )}
            </ul>
        </div>
    );
}
