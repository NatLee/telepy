"use client";

/**
 * 遠端桌面頁（`/tunnels/desktop?tunnel=<id>[&lanHost=<id>]`）：在瀏覽器裡看、操作裝置（或它區網裡主機）的
 * RDP / VNC 桌面。沒連線時是表單（含畫質預設）；連上後是畫面 + 工具列：延遲 / 串流狀態（點開看每一段）、
 * 螢幕選單（VNC：偵測到的螢幕、等分切法、自己框選的區域）、鍵盤選單（送出文字 —— IME 的備援、Ctrl+Alt+Del、
 * Ctrl 當 ⌘）、貼上、全螢幕、說明、中斷。「怎麼運作」（info）打開即時路徑圖，顯示現在在哪一段、卡在哪一段。
 * RustDesk 模式預設在瀏覽器裡連（RustDeskViewer：vendored 的 RustDesk 核心 + Telepy 的中繼；螢幕選單列對方回報的螢幕、
 * 畫質走 RustDesk 自己的設定），另可展開「用 RustDesk app」：從裝置探測 Direct IP 埠，給 `ssh -L` 指令。
 * Remote desktop page: a form while idle, the screen plus a toolbar once connected (latency / stream button,
 * screen menu with detected screens / even splits / a drag-selected area, keyboard menu); RustDesk connects in the
 * browser by default (RustDeskViewer), with the native-app path (port probe + ssh -L) behind a disclosure.
 * `?rustdesk=<id>`：用 Telepy 當 RustDesk 伺服器的裝置（沒有隧道），表單只剩密碼與畫質。/ A RustDesk-server device (no tunnel):
 * the form is just the password and the quality.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ClipboardPaste, Crop, ExternalLink, Info, KeyRound, Keyboard, Loader2, Maximize2, Minimize2, Monitor, MonitorSmartphone, MonitorX, Plus, RefreshCw, Route, ScreenShare, ShieldCheck, TextCursorInput, Waypoints, XCircle } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { Modal } from "@/components/ui/Modal";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/ui/CopyButton";
import { useToast } from "@/components/ui/Toast";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { DesktopViewer, loadGuacamole, type DesktopViewerHandle } from "@/components/desktop/DesktopViewer";
import { RustDeskViewer, type RustDeskQuality, type RustDeskViewerHandle } from "@/components/desktop/RustDeskViewer";
import { loadRustDeskCore } from "@/lib/rustdesk";
import { DesktopInfoDialog } from "@/components/desktop/DesktopInfoDialog";
import { ConnectionWaysDialog } from "@/components/desktop/ConnectionWays";
import { wayFor } from "@/lib/connectionWays";
import { DesktopStatsButton } from "@/components/desktop/DesktopStats";
import type { FlowContext } from "@/components/desktop/DesktopFlow";
import { CommandBar } from "@/components/cheatsheet/CommandView";
import { useDesktopPage } from "@/hooks/useDesktopPage";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { desktopPorts, formatElapsed, isValidPort, QUALITY_VALUES, RUSTDESK_PORT, type DesktopMode, type DesktopPhase, type DesktopQuality } from "@/lib/desktop";
import { screenChoices, splitChoices, type ScreenChoice } from "@/lib/desktopScreens";
import { buildSegments } from "@/lib/forwardRecipes";
import { hostName } from "@/lib/lanConnect";
import { deviceDetails, formatRustDeskId } from "@/lib/rustdeskDevices";
import type { TranslationKey } from "@/locales/en";

const CARD = "rounded-xl border border-border bg-card shadow-card";
/**
 * 工具列：手機上第一行是目標（名稱最多兩行）+「中斷連線」，第二行是只剩圖示的按鈕；寬螢幕照原本一路排下去。
 * The toolbar: on phones the first row holds the target (name up to two lines) and Disconnect, the second the
 * icon-only buttons; wider screens flow as before. 協定 chip 手機上不顯示（說明和延遲面板都有）。/ The protocol chip is
 * hidden on phones (the info dialog and the stats panel name it).
 */
const TOOLBAR = "flex flex-wrap items-center gap-x-1 gap-y-2 border-b border-border bg-card px-3 py-2 sm:gap-2";
const TOOLBAR_TARGET = "flex min-w-0 basis-full items-center gap-2 sm:basis-auto";
const TARGET_LABEL = "line-clamp-2 min-w-0 text-sm text-foreground [overflow-wrap:anywhere] sm:truncate";
const TOOL = "max-sm:has-[>svg]:px-1.5";
/**
 * 畫面框：RDP 的解析度跟著框走，所以照舊佔滿高度；VNC / RustDesk 的解析度固定，手機上框改成畫面的比例
 * （不再是高高的黑框中間一張小圖），最高不超過原本的高度。
 * The screen frame: RDP sizes the remote desktop to the frame, so it keeps the full height; VNC / RustDesk have a
 * fixed resolution, so on phones the frame takes the picture's shape instead of a tall black box around a small picture.
 */
const SCREEN_TALL = "h-[calc(100dvh-15rem)] min-h-80";
const SCREEN_FITTED = `${SCREEN_TALL} max-sm:aspect-(--screen-ratio) max-sm:h-auto max-sm:max-h-[calc(100dvh-15rem)] max-sm:min-h-0`;
const screenRatio = (size: { width: number; height: number } | null) =>
    ({ "--screen-ratio": size && size.width > 0 && size.height > 0 ? `${size.width} / ${size.height}` : "16 / 10" }) as React.CSSProperties;

const PRESET_KEY: Record<NonNullable<ScreenChoice["preset"]>, TranslationKey> = {
    left: "desktop.screen.preset.left",
    right: "desktop.screen.preset.right",
    top: "desktop.screen.preset.top",
    bottom: "desktop.screen.preset.bottom",
    third1: "desktop.screen.preset.third1",
    third2: "desktop.screen.preset.third2",
    third3: "desktop.screen.preset.third3",
};

const QUALITY_HINT: Record<DesktopQuality, TranslationKey> = {
    auto: "desktop.quality.hint.auto",
    speed: "desktop.quality.hint.speed",
    sharp: "desktop.quality.hint.sharp",
};

const MODE_LABEL: Record<DesktopMode, string> = { rdp: "RDP", vnc: "VNC", rustdesk: "RustDesk" };

const QUALITY_LABEL: Record<DesktopQuality, TranslationKey> = { auto: "desktop.quality.auto", speed: "desktop.quality.speed", sharp: "desktop.quality.sharp" };
/** Telepy 的畫質預設 → RustDesk 自己的畫質檔。/ Telepy's quality presets as RustDesk's own profiles. */
const RD_QUALITY: Record<DesktopQuality, RustDeskQuality> = { auto: "balanced", speed: "low", sharp: "best" };

export default function DesktopPage() {
    // useSearchParams 需要 Suspense 邊界。/ useSearchParams needs a Suspense boundary.
    return (
        <Suspense fallback={null}>
            <DesktopPageInner />
        </Suspense>
    );
}

function DesktopPageInner() {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const { state, actions } = useDesktopPage();
    const { tunnels, loading, tunnel, host, form, phase, failure, session, connectedAt, endedNormally, address, stats, unstable, framebuffer, scale, screens, viewportId, customArea, selecting, ctrlAsCmd, pixelRatio, isRustDesk, probeState, rdSession, rdInfo, rdPassword, quality, rdDevice, rdDevices, rdDevicesLoaded } = state;
    const viewerRef = useRef<DesktopViewerHandle | null>(null);
    const rdViewerRef = useRef<RustDeskViewerHandle | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);
    // 「比較連線方式」：RDP / VNC、RustDesk 經隧道、RustDesk 伺服器三條路的差別。/ The ways-to-connect comparison.
    const [waysOpen, setWaysOpen] = useState(false);
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const [typeOpen, setTypeOpen] = useState(false);
    const [typeText, setTypeText] = useState("");
    // 遠端複製的文字，綁在當時的 session 上（換 session 就不顯示）。/ Remote clipboard text, tied to its session.
    const [remoteClipState, setRemoteClipState] = useState<{ sid: string; text: string } | null>(null);
    const liveId = session?.session_id ?? rdSession?.session_id ?? null;
    const remoteClip = remoteClipState && liveId !== null && remoteClipState.sid === liveId ? remoteClipState.text : null;
    const [fullscreen, setFullscreen] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    // 偵測到的螢幕配置。重算的時機：螢幕清單或畫面大小變了、選單打開時、偵測完兩秒後
    // （macOS 的排列靠畫面裡的黑色區域判斷，要等畫面畫出來）。計算讀 canvas，所以在事件 / 計時器裡做，不在 render 裡。
    // The detected screens. Recomputed when the list or framebuffer changes, when the menu opens and two seconds
    // after detection (the black-area sampling needs a painted frame); it reads the canvas, so never during render.
    const [choices, setChoices] = useState<ScreenChoice[]>([]);
    const protocol = session?.protocol ?? null;
    const recomputeChoices = useCallback(() => {
        if (!framebuffer || protocol !== "vnc") {
            setChoices([]);
            return;
        }
        setChoices(screenChoices(screens.list, framebuffer, (x, y) => viewerRef.current?.isBlack(x, y) ?? false));
    }, [framebuffer, protocol, screens.list]);

    useEffect(() => {
        if (phase !== "connected") return;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [phase]);
    useEffect(() => {
        const onChange = () => setFullscreen(document.fullscreenElement === wrapRef.current && !!wrapRef.current);
        document.addEventListener("fullscreenchange", onChange);
        return () => document.removeEventListener("fullscreenchange", onChange);
    }, []);
    useEffect(() => {
        const soon = setTimeout(recomputeChoices, 0);
        const painted = setTimeout(recomputeChoices, 2000);
        return () => {
            clearTimeout(soon);
            clearTimeout(painted);
        };
    }, [recomputeChoices]);

    const splits = useMemo(() => (framebuffer && protocol === "vnc" ? splitChoices(framebuffer) : []), [framebuffer, protocol]);
    const chosen: ScreenChoice | null = viewportId === "custom"
        ? (customArea ? { id: "custom", name: t("desktop.screen.custom"), viewport: customArea } : null)
        : [...choices, ...splits].find((c) => c.id === viewportId) ?? null;
    const viewport = chosen?.viewport ?? null;
    const choiceLabel = (c: ScreenChoice) => (c.preset ? t(PRESET_KEY[c.preset]) : c.name);

    const clipboard = session?.clipboard ?? null;
    // RustDesk 用 app 的路（探測過、瀏覽器裡沒在連）：階段跟著探測；其餘都是瀏覽器 session 的階段。
    // The native-app path (probed, nothing connecting in the browser) follows the probe; everything else the session.
    const rdNative = !rdDevice && isRustDesk && phase === "idle" && !rdSession && probeState.state !== "idle";
    const flowPhase: DesktopPhase = rdNative
        ? (probeState.state === "checking" ? "starting" : probeState.state === "ok" ? "connected" : "failed")
        : phase;
    const flowFailure = rdNative ? probeState.failure : failure;
    const ctx: FlowContext = useMemo(() => ({
        phase: flowPhase,
        failure: flowFailure,
        inBrowser: !rdNative,
        protocol: form.protocol,
        port: isValidPort(form.port) ? Number(form.port) : 0,
        deviceName: tunnel?.name ?? t("desktop.flow.device"),
        account: form.account,
        lanHost: host ? { name: hostName(host), address: host.address } : null,
        clipboard,
        savedLogin: !!state.savedLogin,
        stats,
        idServer: rdDevice ? { deviceName: rdDevice.name, rustdeskId: formatRustDeskId(rdDevice.rustdesk_id) } : null,
    }), [flowPhase, flowFailure, rdNative, form.protocol, form.port, form.account, tunnel, host, clipboard, t, state.savedLogin, stats, rdDevice]);

    const targetLabel = rdDevice ? `${rdDevice.name} · ${formatRustDeskId(rdDevice.rustdesk_id)}` : host ? `${hostName(host)} · ${address}` : t("desktop.targetDeviceShort", { address });
    const toggleFullscreen = () => {
        const el = wrapRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen?.().catch(() => undefined);
    };
    const onRemoteClipboard = (text: string) => {
        if (liveId !== null) setRemoteClipState({ sid: liveId, text });
        void navigator.clipboard?.writeText(text).then(() => showSuccess(t("desktop.clipboardCopied"))).catch(() => undefined);
    };
    const sendPaste = () => {
        if (!pasteText) return;
        viewerRef.current?.sendClipboard(pasteText);
        setPasteOpen(false);
        setPasteText("");
        showSuccess(t("desktop.pasteSent"));
        viewerRef.current?.focus();
    };
    const sendTyped = () => {
        if (!typeText) return;
        (viewerRef.current ?? rdViewerRef.current)?.typeText(typeText);
        setTypeOpen(false);
        setTypeText("");
        showSuccess(t("desktop.typeText.sent"));
        // 對話框關掉後 Radix 會把焦點還給選單按鈕，所以晚一點再把焦點放回畫面。/ Radix returns focus to the menu trigger on close; refocus after that.
        setTimeout(() => (viewerRef.current ?? rdViewerRef.current)?.focus(), 150);
    };

    const disconnectButton = (ref: React.RefObject<{ disconnect: () => void } | null>, className: string) => (
        <Button size="sm" variant="destructive" className={className} onClick={() => { ref.current?.disconnect(); actions.stop(); }} title={t("desktop.disconnect")} aria-label={t("desktop.disconnect")}>
            <MonitorX size={15} /> <span className="hidden sm:inline">{t("desktop.disconnect")}</span>
        </Button>
    );
    const headerActions = (
        <>
            <Button variant="outline" onClick={() => setWaysOpen(true)}>
                <Route size={16} /> {t("desktop.ways.button")}
            </Button>
            <Button variant="outline" onClick={() => setInfoOpen(true)}>
                <Info size={16} /> {t("desktop.howItWorks")}
            </Button>
        </>
    );
    const currentWay = wayFor({ protocol: form.protocol, idServer: !!rdDevice });
    const connected = phase === "connected";
    const isDeviceDesktop = !!session && session.target.lan_host_id === null;
    // RustDesk：畫質預設換了就告訴核心（連上時套一次）。/ RustDesk: push the quality profile to the core (once on connect too).
    useEffect(() => {
        if (rdSession && connected) rdViewerRef.current?.setQuality(RD_QUALITY[quality]);
    }, [rdSession, connected, quality]);
    const rdCurrent = rdInfo?.displays[rdInfo.currentDisplay] ?? null;
    const rdDisplay = rdCurrent ? { width: rdCurrent.width, height: rdCurrent.height } : null;

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader icon={<ScreenShare />} title={t("desktop.title")} description={t("desktop.description")} actions={!session && !rdSession && headerActions} />

            {session ? (
                <div ref={wrapRef} className={cn("flex flex-col overflow-hidden", fullscreen ? "h-full bg-black" : CARD)}>
                    <div className={TOOLBAR}>
                        <div className={TOOLBAR_TARGET}>
                            <StatusDot online={connected} />
                            <span className={TARGET_LABEL} title={targetLabel}>{targetLabel}</span>
                            <Chip mono className="shrink-0 max-sm:hidden">{MODE_LABEL[form.protocol]}</Chip>
                            {connected && connectedAt && <Chip mono className="shrink-0">{formatElapsed((now - connectedAt) / 1000)}</Chip>}
                            {disconnectButton(viewerRef, "ml-auto shrink-0 sm:hidden")}
                        </div>
                        {connected && <DesktopStatsButton stats={stats} unstable={unstable} now={now} framebuffer={framebuffer} viewport={viewport} scale={scale} />}
                        <span className="flex-1" />
                        {session.protocol === "vnc" && (
                            <DropdownMenu onOpenChange={(open) => { if (open) recomputeChoices(); }}>
                                <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="ghost" className={TOOL} disabled={!connected || selecting} title={t("desktop.screen.menu")}>
                                        <Monitor size={15} />
                                        <span className="hidden max-w-32 truncate sm:inline">{chosen ? choiceLabel(chosen) : t("desktop.screen.whole")}</span>
                                        <ChevronDown size={13} className="hidden text-muted-foreground sm:block" aria-hidden />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-64">
                                    <DropdownMenuLabel>{t("desktop.screen.menu")}</DropdownMenuLabel>
                                    <DropdownMenuRadioGroup value={chosen ? chosen.id : ""} onValueChange={(v) => { actions.setViewportId(v); viewerRef.current?.focus(); }}>
                                        <DropdownMenuRadioItem value="">
                                            <span className="flex-1">{t("desktop.screen.whole")}</span>
                                            {framebuffer && <span className="font-mono text-xs text-muted-foreground">{framebuffer.width}×{framebuffer.height}</span>}
                                        </DropdownMenuRadioItem>
                                        {choices.some((c) => c.guessed) && (
                                            <DropdownMenuLabel className="text-xs text-muted-foreground">{t("desktop.screen.guessed")}</DropdownMenuLabel>
                                        )}
                                        {choices.map((c, i) => (
                                            <DropdownMenuRadioItem key={c.id} value={c.id}>
                                                <span className="min-w-0 flex-1 truncate">{c.guessed ? `${i + 1} · ` : ""}{choiceLabel(c)}{c.primary && !c.guessed ? ` · ${t("desktop.screen.primary")}` : ""}</span>
                                                {!c.guessed && <span className="font-mono text-xs text-muted-foreground">{c.viewport.width}×{c.viewport.height}</span>}
                                            </DropdownMenuRadioItem>
                                        ))}
                                        {customArea && (
                                            <DropdownMenuRadioItem value="custom">
                                                <span className="min-w-0 flex-1 truncate">{t("desktop.screen.custom")}</span>
                                                <span className="font-mono text-xs text-muted-foreground">{customArea.width}×{customArea.height}</span>
                                            </DropdownMenuRadioItem>
                                        )}
                                        {splits.length > 0 && (
                                            <>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuLabel className="text-xs text-muted-foreground">{t("desktop.screen.split")}</DropdownMenuLabel>
                                                {splits.map((c) => (
                                                    <DropdownMenuRadioItem key={c.id} value={c.id}>
                                                        <span className="min-w-0 flex-1 truncate">{choiceLabel(c)}</span>
                                                        <span className="font-mono text-xs text-muted-foreground">{c.viewport.width}×{c.viewport.height}</span>
                                                    </DropdownMenuRadioItem>
                                                ))}
                                            </>
                                        )}
                                    </DropdownMenuRadioGroup>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onSelect={() => actions.startSelecting()}>
                                        <Crop size={14} /> {customArea ? t("desktop.screen.adjustArea") : t("desktop.screen.selectArea")}
                                    </DropdownMenuItem>
                                    {customArea && (
                                        <DropdownMenuItem onSelect={() => actions.forgetArea()}>
                                            <XCircle size={14} /> {t("desktop.screen.forgetArea")}
                                        </DropdownMenuItem>
                                    )}
                                    {choices.length === 0 && screens.state !== "loading" && (
                                        <p className="px-2 py-1.5 text-xs text-muted-foreground">{isDeviceDesktop ? t("desktop.screen.single") : t("desktop.screen.lanNote")}</p>
                                    )}
                                    {screens.state === "loading" && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("desktop.screen.detecting")}</p>}
                                    {screens.state === "failed" && <p className="px-2 py-1.5 text-xs text-destructive">{t("desktop.screen.failed")}</p>}
                                    {isDeviceDesktop && (
                                        <>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem disabled={screens.state === "loading"} onSelect={() => void actions.detectScreens()}>
                                                <RefreshCw size={14} /> {t("desktop.screen.detect")}
                                            </DropdownMenuItem>
                                        </>
                                    )}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost" className={TOOL} disabled={!connected || selecting} title={t("desktop.keyboard.menu")}>
                                    <Keyboard size={15} /> <span className="hidden md:inline">{t("desktop.keyboard.menu")}</span>
                                    <ChevronDown size={13} className="hidden text-muted-foreground sm:block" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-72">
                                <DropdownMenuItem onSelect={() => setTypeOpen(true)}>
                                    <TextCursorInput size={14} /> {t("desktop.keyboard.typeText")}
                                </DropdownMenuItem>
                                {session.protocol === "rdp" && (
                                    <DropdownMenuItem onSelect={() => viewerRef.current?.sendCtrlAltDel()}>
                                        <Keyboard size={14} /> Ctrl+Alt+Del
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuCheckboxItem checked={ctrlAsCmd} onCheckedChange={(on) => actions.setCtrlMode(on ? "on" : "off")}>
                                    <span className="block">
                                        {t("desktop.keyboard.ctrlAsCmd")}
                                        <span className="block text-xs text-muted-foreground">{t("desktop.keyboard.ctrlAsCmdHint")}</span>
                                    </span>
                                </DropdownMenuCheckboxItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {clipboard !== "off" && (
                            <Button size="sm" variant="ghost" className={TOOL} onClick={() => setPasteOpen(true)} disabled={!connected || selecting} title={t("desktop.pasteTitle")}>
                                <ClipboardPaste size={15} /> <span className="hidden md:inline">{t("desktop.paste")}</span>
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" className={TOOL} onClick={toggleFullscreen} title={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")} aria-label={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")}>
                            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                        </Button>
                        <Button size="sm" variant="ghost" className={TOOL} onClick={() => setInfoOpen(true)} title={t("desktop.howItWorks")} aria-label={t("desktop.howItWorks")}>
                            <Info size={15} />
                        </Button>
                        {disconnectButton(viewerRef, "max-sm:hidden")}
                    </div>
                    {remoteClip !== null && clipboard === "both" && (
                        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
                            <span className="shrink-0">{t("desktop.remoteClipboard")}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{remoteClip}</span>
                            <CopyButton value={remoteClip} />
                        </div>
                    )}
                    <div className={cn("relative", fullscreen ? "flex-1" : session.protocol === "vnc" ? SCREEN_FITTED : SCREEN_TALL)} style={screenRatio(viewport ?? framebuffer)}>
                        <DesktopViewer
                            ref={viewerRef}
                            start={session}
                            viewport={viewport}
                            selecting={selecting}
                            onAreaSelected={actions.finishSelecting}
                            pixelRatio={pixelRatio}
                            ctrlAsCmd={ctrlAsCmd}
                            onConnected={actions.onConnected}
                            onEnded={actions.onEnded}
                            onRemoteClipboard={onRemoteClipboard}
                            onStats={actions.onStats}
                            onTunnelUnstable={actions.onTunnelUnstable}
                            onDisplaySize={actions.onDisplaySize}
                            onScale={actions.onScale}
                        />
                        {!connected && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-sm text-white">
                                <span className="size-8 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                                <span>{t("desktop.flow.now.connecting")}</span>
                                <Button size="sm" variant="secondary" onClick={() => setInfoOpen(true)}>
                                    <Info size={15} /> {t("desktop.whatsHappening")}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            ) : rdSession ? (
                <div ref={wrapRef} className={cn("flex flex-col overflow-hidden", fullscreen ? "h-full bg-black" : CARD)}>
                    <div className={TOOLBAR}>
                        <div className={TOOLBAR_TARGET}>
                            <StatusDot online={connected} />
                            <span className={TARGET_LABEL} title={targetLabel}>{targetLabel}</span>
                            <Chip mono className="shrink-0 max-sm:hidden">RustDesk</Chip>
                            {connected && connectedAt && <Chip mono className="shrink-0">{formatElapsed((now - connectedAt) / 1000)}</Chip>}
                            {disconnectButton(rdViewerRef, "ml-auto shrink-0 sm:hidden")}
                        </div>
                        {connected && <DesktopStatsButton stats={stats} unstable={unstable} now={now} framebuffer={rdDisplay} viewport={null} scale={null} engine="rustdesk" />}
                        <span className="flex-1" />
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost" className={TOOL} disabled={!connected} title={t("desktop.screen.menu")}>
                                    <Monitor size={15} />
                                    <span className="hidden max-w-32 truncate sm:inline">{rdInfo && rdInfo.displays.length > 1 ? t("desktop.screen.display", { n: rdInfo.currentDisplay + 1 }) : t("desktop.screen.whole")}</span>
                                    <ChevronDown size={13} className="hidden text-muted-foreground sm:block" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-64">
                                <DropdownMenuLabel>{t("desktop.screen.menu")}</DropdownMenuLabel>
                                {rdInfo && rdInfo.displays.length > 1 ? (
                                    <DropdownMenuRadioGroup value={String(rdInfo.currentDisplay)} onValueChange={(v) => { rdViewerRef.current?.switchDisplay(Number(v)); rdViewerRef.current?.focus(); }}>
                                        {rdInfo.displays.map((d, i) => (
                                            <DropdownMenuRadioItem key={i} value={String(i)}>
                                                <span className="min-w-0 flex-1 truncate">{t("desktop.screen.display", { n: i + 1 })}</span>
                                                <span className="font-mono text-xs text-muted-foreground">{d.width}×{d.height}</span>
                                            </DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
                                ) : (
                                    <p className="px-2 py-1.5 text-xs text-muted-foreground">{t("desktop.screen.single")}</p>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel className="text-xs text-muted-foreground">{t("desktop.field.quality")}</DropdownMenuLabel>
                                <DropdownMenuRadioGroup value={quality} onValueChange={(v) => actions.setQuality(v as DesktopQuality)}>
                                    {QUALITY_VALUES.map((q) => (
                                        <DropdownMenuRadioItem key={q} value={q}>{t(QUALITY_LABEL[q])}</DropdownMenuRadioItem>
                                    ))}
                                </DropdownMenuRadioGroup>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button size="sm" variant="ghost" className={TOOL} disabled={!connected} title={t("desktop.keyboard.menu")}>
                                    <Keyboard size={15} /> <span className="hidden md:inline">{t("desktop.keyboard.menu")}</span>
                                    <ChevronDown size={13} className="hidden text-muted-foreground sm:block" aria-hidden />
                                </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-72">
                                <DropdownMenuItem onSelect={() => setTypeOpen(true)}>
                                    <TextCursorInput size={14} /> {t("desktop.keyboard.typeText")}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => rdViewerRef.current?.sendCtrlAltDel()}>
                                    <Keyboard size={14} /> Ctrl+Alt+Del
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button size="sm" variant="ghost" className={TOOL} onClick={toggleFullscreen} title={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")} aria-label={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")}>
                            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                        </Button>
                        <Button size="sm" variant="ghost" className={TOOL} onClick={() => setInfoOpen(true)} title={t("desktop.howItWorks")} aria-label={t("desktop.howItWorks")}>
                            <Info size={15} />
                        </Button>
                        {disconnectButton(rdViewerRef, "max-sm:hidden")}
                    </div>
                    {remoteClip !== null && (
                        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
                            <span className="shrink-0">{t("desktop.remoteClipboard")}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{remoteClip}</span>
                            <CopyButton value={remoteClip} />
                        </div>
                    )}
                    <div className={cn("relative", fullscreen ? "flex-1" : SCREEN_FITTED)} style={screenRatio(rdDisplay)}>
                        <RustDeskViewer
                            ref={rdViewerRef}
                            start={rdSession}
                            password={rdPassword}
                            onConnected={actions.onConnected}
                            onEnded={actions.onEnded}
                            onPeerInfo={actions.onRdPeerInfo}
                            onStats={actions.onRdStats}
                            onRemoteClipboard={onRemoteClipboard}
                        />
                        {!connected && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center text-sm text-white">
                                <span className="size-8 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden />
                                <span>{t("desktop.flow.now.connecting")}</span>
                                <Button size="sm" variant="secondary" onClick={() => setInfoOpen(true)}>
                                    <Info size={15} /> {t("desktop.whatsHappening")}
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            ) : (
                <ConnectPanel state={state} actions={actions} onInfo={() => setInfoOpen(true)} onCompare={() => setWaysOpen(true)} />
            )}

            {!session && !rdSession && endedNormally && phase === "idle" && <Callout tone="info">{t("desktop.ended")}</Callout>}
            {!loading && rdDevicesLoaded && tunnels.length === 0 && rdDevices.length === 0 && (
                <Callout tone="tip">
                    {t("desktop.noTunnels")}{" "}
                    <Link className="text-primary underline-offset-2 hover:underline" href="/tunnels/create"><Plus size={14} className="inline align-[-2px]" /> {t("desktop.addDevice")}</Link>
                </Callout>
            )}

            <DesktopInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} ctx={ctx} onCompare={() => { setInfoOpen(false); setWaysOpen(true); }} />
            <ConnectionWaysDialog isOpen={waysOpen} onClose={() => setWaysOpen(false)} current={currentWay} />
            <Modal
                isOpen={pasteOpen}
                onClose={() => setPasteOpen(false)}
                title={t("desktop.pasteTitle")}
                description={t("desktop.pasteDescription")}
                icon={<ClipboardPaste />}
                size="lg"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setPasteOpen(false)}>{t("common.cancel")}</Button>
                        <Button onClick={sendPaste} disabled={!pasteText}>{t("desktop.pasteSend")}</Button>
                    </>
                }
            >
                <Textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6} autoFocus className="font-mono text-sm" aria-label={t("desktop.pasteTitle")} />
            </Modal>
            <Modal
                isOpen={typeOpen}
                onClose={() => setTypeOpen(false)}
                title={t("desktop.typeText.title")}
                description={t("desktop.typeText.description")}
                icon={<TextCursorInput />}
                size="lg"
                footer={
                    <>
                        <Button variant="outline" onClick={() => setTypeOpen(false)}>{t("common.cancel")}</Button>
                        <Button onClick={sendTyped} disabled={!typeText}>{t("desktop.typeText.send")}</Button>
                    </>
                }
            >
                <Textarea value={typeText} onChange={(e) => setTypeText(e.target.value)} rows={4} autoFocus className="text-sm" aria-label={t("desktop.typeText.title")} />
                <p className="mt-2 text-xs text-muted-foreground">{t("desktop.typeText.hint")}</p>
            </Modal>
        </div>
    );
}

type PageState = ReturnType<typeof useDesktopPage>["state"];
type PageActions = ReturnType<typeof useDesktopPage>["actions"];

/**
 * 「裝置」選單：有 Telepy 隧道的裝置，以及用 Telepy 當 RustDesk 伺服器的裝置（`rd:<id>`）。
 * The device picker: tunnelled devices plus RustDesk-server devices (`rd:<id>`).
 */
function DevicePicker({ state, actions }: { state: PageState; actions: PageActions }) {
    const { t } = useI18n();
    const { tunnels, tunnel, online, rdDevice, rdDevices } = state;
    const value = rdDevice ? `rd:${rdDevice.id}` : tunnel ? String(tunnel.id) : "";
    const onChange = (v: string) => (v.startsWith("rd:") ? actions.setRustDeskDevice(Number(v.slice(3))) : actions.setTunnel(Number(v)));
    const tunnelOptions = tunnels.map((tn) => (
        <option key={tn.id} value={tn.id}>
            {tn.name}{tn.online === false ? ` · ${t("desktop.offlineShort")}` : ""}
        </option>
    ));
    const rdOptions = rdDevices.map((d) => (
        <option key={`rd:${d.id}`} value={`rd:${d.id}`}>
            {d.name} · {formatRustDeskId(d.rustdesk_id)}{d.online ? "" : ` · ${t("desktop.offlineShort")}`}
        </option>
    ));
    const hint = rdDevice ? (rdDevice.online ? undefined : t("desktop.rdServer.offline", { name: rdDevice.name })) : tunnel && !online ? t("desktop.offline") : undefined;
    return (
        <Field label={t("desktop.field.device")} hint={hint}>
            <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
                {tunnels.length > 0 && rdDevices.length > 0 ? (
                    <>
                        <optgroup label={t("desktop.field.groupTunnels")}>{tunnelOptions}</optgroup>
                        <optgroup label={t("desktop.field.groupRustDesk")}>{rdOptions}</optgroup>
                    </>
                ) : (
                    <>
                        {tunnelOptions}
                        {rdOptions}
                    </>
                )}
            </NativeSelect>
        </Field>
    );
}

/**
 * 用 Telepy 當 RustDesk 伺服器的裝置：只要密碼與畫質；連線端對端加密。
 * A device that uses Telepy as its RustDesk server: just the password and the quality; end-to-end encrypted.
 */
function RustDeskServerForm({ state, actions, onInfo }: { state: PageState; actions: PageActions; onInfo: () => void }) {
    const { t } = useI18n();
    const { rdDevice, form, phase, failure, canConnect, quality } = state;
    const busy = phase === "starting";
    if (!rdDevice) return null;
    const qualityOptions: { value: DesktopQuality; label: string }[] = [
        { value: "auto", label: t("desktop.quality.auto") },
        { value: "speed", label: t("desktop.quality.speed") },
        { value: "sharp", label: t("desktop.quality.sharp") },
    ];
    const details = deviceDetails(rdDevice);
    return (
        <form
            className={cn(CARD, "space-y-5 p-4 sm:p-6")}
            onSubmit={(e) => {
                e.preventDefault();
                if (canConnect) void actions.connect();
            }}
        >
            {failure && phase === "failed" && (
                <Callout tone="danger">
                    <p>{t(failure.key, failure.vars)}</p>
                    <button type="button" onClick={onInfo} className="mt-1 text-sm text-destructive underline underline-offset-2">
                        {t("desktop.showWhere")}
                    </button>
                </Callout>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                <DevicePicker state={state} actions={actions} />
                <div className="flex min-w-0 items-start gap-3 rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
                    <MonitorSmartphone size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                        <p className="text-foreground">
                            <span className="text-muted-foreground">{t("desktop.rdServer.id")} </span>
                            <span className="tabular-nums">{formatRustDeskId(rdDevice.rustdesk_id)}</span>
                        </p>
                        {details && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{details}</p>}
                        <Link href="/tunnels/rustdesk" prefetch={false} className="text-xs text-primary underline-offset-2 hover:underline">{t("desktop.rdServer.manage")}</Link>
                    </div>
                </div>
                <Field label={t("desktop.field.rdPassword")} hint={t("desktop.rdServer.passwordHint")}>
                    <Input type="password" value={form.password} onChange={(e) => actions.update({ password: e.target.value })} autoComplete="off" />
                </Field>
                <Field label={t("desktop.field.quality")} hint={t("desktop.rustdesk.qualityHint")}>
                    <Segmented options={qualityOptions} value={quality} onChange={actions.setQuality} fullWidth aria-label={t("desktop.field.quality")} />
                </Field>
            </div>
            <Callout tone="info" icon={<ShieldCheck size={17} className="mt-0.5 shrink-0" aria-hidden />}>{t("desktop.rdServer.intro")}</Callout>
            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={onInfo} className="flex min-w-0 items-start gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
                    <Info size={14} className="mt-px shrink-0" aria-hidden />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{t("desktop.rdServer.pathSummary", { name: rdDevice.name })}</span>
                </button>
                <Button type="submit" disabled={!canConnect || busy} className="sm:min-w-40">
                    <ScreenShare size={16} /> {busy ? t("desktop.connecting") : t("desktop.rustdesk.connectBrowser")}
                </Button>
            </div>
        </form>
    );
}

function ConnectPanel({ state, actions, onInfo, onCompare }: { state: PageState; actions: PageActions; onInfo: () => void; onCompare: () => void }) {
    const { t, tn } = useI18n();
    const { tunnels, loading, tunnel, host, form, phase, failure, canConnect, address, savedLogins, savedLogin, quality, isRustDesk, rdDevice, rdDevices } = state;
    const portOk = isValidPort(form.port);
    const busy = phase === "starting";
    // 預熱畫面元件的 chunk（與填表並行）；RustDesk 是 vendored 的核心。/ Warm up the viewer chunk (the RustDesk core in that mode).
    useEffect(() => { void (isRustDesk || rdDevice ? loadRustDeskCore() : loadGuacamole()).catch(() => undefined); }, [isRustDesk, rdDevice]);

    if (loading) return <div className={cn(CARD, "p-8 text-center text-sm text-muted-foreground")}>{t("common.loading")}</div>;
    if (rdDevice) return <RustDeskServerForm state={state} actions={actions} onInfo={onInfo} />;
    if (tunnels.length === 0 && rdDevices.length === 0) return null;

    const protocolOptions: { value: DesktopMode; label: string }[] = [
        { value: "rdp", label: t("desktop.protocol.rdp") },
        { value: "vnc", label: t("desktop.protocol.vnc") },
        { value: "rustdesk", label: t("desktop.protocol.rustdesk") },
    ];
    const qualityOptions: { value: DesktopQuality; label: string }[] = [
        { value: "auto", label: t("desktop.quality.auto") },
        { value: "speed", label: t("desktop.quality.speed") },
        { value: "sharp", label: t("desktop.quality.sharp") },
    ];
    const noAccounts = !!tunnel && tunnel.usernames.length === 0;

    return (
        <form
            className={cn(CARD, "space-y-5 p-4 sm:p-6")}
            onSubmit={(e) => {
                e.preventDefault();
                if (canConnect) void actions.connect();
            }}
        >
            {failure && phase === "failed" && (
                <Callout tone="danger">
                    <p>{t(failure.key, failure.vars)}</p>
                    <button type="button" onClick={onInfo} className="mt-1 text-sm text-destructive underline underline-offset-2">
                        {t("desktop.showWhere")}
                    </button>
                </Callout>
            )}

            {/* 欄寬一定要 minmax(0,…)：RustDesk 的 ssh 指令很長，不然會把整張表單撐出手機畫面。/ minmax(0,…) keeps the long ssh command from widening the form past a phone screen. */}
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                <DevicePicker state={state} actions={actions} />

                <Field
                    label={t("desktop.field.target")}
                    hint={
                        host ? t("desktop.target.hintLan", { address: host.address }) : (
                            <>
                                {t("desktop.target.hintDevice")}{" "}
                                {tunnel && tunnel.hosts.length === 0 && (
                                    <Link className="text-primary underline-offset-2 hover:underline" href={`/tunnels/network?tunnel=${tunnel.id}`}>
                                        <Waypoints size={12} className="inline align-[-1px]" /> {t("desktop.findLan")}
                                    </Link>
                                )}
                            </>
                        )
                    }
                >
                    <NativeSelect value={host ? String(host.id) : ""} onChange={(e) => actions.setHost(e.target.value ? Number(e.target.value) : null)} disabled={!tunnel}>
                        <option value="">{t("desktop.target.device")}</option>
                        {tunnel?.hosts.map((h) => {
                            const seen = desktopPorts(h.open_ports).map((d) => `${MODE_LABEL[d.protocol]} ${d.port}`).join(", ");
                            return (
                                <option key={h.id} value={h.id}>
                                    {hostName(h)}{hostName(h) !== h.address ? ` (${h.address})` : ""}{seen ? ` · ${seen}` : ""}
                                </option>
                            );
                        })}
                    </NativeSelect>
                </Field>

                <Field label={t("desktop.field.account")} hint={t("desktop.field.accountHint")}>
                    <NativeSelect value={form.account} onChange={(e) => actions.update({ account: e.target.value })} disabled={!tunnel || noAccounts}>
                        {noAccounts && <option value="">—</option>}
                        {tunnel?.usernames.map((u) => <option key={u} value={u}>{u}</option>)}
                    </NativeSelect>
                </Field>

                <Field
                    label={t("desktop.field.protocol")}
                    hint={
                        <button type="button" onClick={onCompare} className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                            <Route size={12} aria-hidden /> {t("desktop.ways.hint")}
                        </button>
                    }
                >
                    <Segmented options={protocolOptions} value={form.protocol} onChange={actions.setProtocol} fullWidth aria-label={t("desktop.field.protocol")} />
                </Field>

                <Field label={t("desktop.field.port")} hint={isRustDesk ? t("desktop.field.rustdeskPortHint") : t("desktop.field.portHint")} error={portOk ? undefined : t("desktop.field.portInvalid")}>
                    <Input inputMode="numeric" value={form.port} onChange={(e) => actions.update({ port: e.target.value.replace(/[^\d]/g, "") })} />
                </Field>

                <Field label={t("desktop.field.quality")} hint={isRustDesk ? t("desktop.rustdesk.qualityHint") : t(QUALITY_HINT[quality])}>
                    <Segmented options={qualityOptions} value={quality} onChange={actions.setQuality} fullWidth aria-label={t("desktop.field.quality")} />
                </Field>

                {savedLogins.length > 0 && (
                    <Field label={t("desktop.field.saved")} hint={t(isRustDesk ? "desktop.field.savedHintRd" : "desktop.field.savedHint")}>
                        <NativeSelect value={form.savedId ? String(form.savedId) : ""} onChange={(e) => actions.update({ savedId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">{t("desktop.field.savedNone")}</option>
                            {savedLogins.map((c) => (
                                <option key={c.id} value={c.id}>{c.label}{c.login ? ` (${c.login})` : ""}</option>
                            ))}
                        </NativeSelect>
                    </Field>
                )}

                {isRustDesk ? (
                    <>
                        {savedLogin ? (
                            <div className="flex flex-col justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-sm">
                                <span className="flex flex-wrap items-center gap-2 text-foreground">
                                    <KeyRound size={15} className="text-muted-foreground" aria-hidden />
                                    <span>{tn("desktop.savedUsesRd", { label: <strong>{savedLogin.label}</strong> })}</span>
                                </span>
                                <span className="text-xs text-muted-foreground">{t("desktop.savedNoteRd")}</span>
                                <button type="button" onClick={() => void actions.forgetSaved(savedLogin.id)} className="self-start text-xs text-destructive underline-offset-2 hover:underline">
                                    {t("desktop.savedForget")}
                                </button>
                            </div>
                        ) : (
                            <Field label={t("desktop.field.rdPassword")} hint={t("desktop.field.rdPasswordHint")}>
                                <Input type="password" value={form.password} onChange={(e) => actions.update({ password: e.target.value })} autoComplete="off" />
                            </Field>
                        )}
                        {!savedLogin && (
                            <label className="flex items-start gap-2 self-center text-sm text-foreground">
                                <input type="checkbox" className="mt-1 size-4 accent-primary" checked={form.save} onChange={(e) => actions.update({ save: e.target.checked })} />
                                <span>
                                    {t("desktop.saveLogin")}
                                    <span className="block text-xs text-muted-foreground">{t("desktop.saveLoginHintRd")}</span>
                                </span>
                            </label>
                        )}
                        {!savedLogin && form.save && (
                            <Field label={t("desktop.saveLabel")} addon={t("common.optional")}>
                                <Input value={form.saveLabel} onChange={(e) => actions.update({ saveLabel: e.target.value })} placeholder={`RustDesk@${host ? host.address : tunnel?.name ?? ""}`} maxLength={100} />
                            </Field>
                        )}
                        <div className="sm:col-span-2">
                            <RustDeskPanel state={state} actions={actions} />
                        </div>
                    </>
                ) : savedLogin ? (
                    <div className="flex flex-col justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2.5 text-sm sm:col-span-2">
                        <span className="flex flex-wrap items-center gap-2 text-foreground">
                            <KeyRound size={15} className="text-muted-foreground" aria-hidden />
                            <span>{tn("desktop.savedUses", { label: <strong>{savedLogin.label}</strong>, login: <code className="font-mono text-xs">{savedLogin.login || "—"}{savedLogin.domain ? ` @ ${savedLogin.domain}` : ""}</code> })}</span>
                        </span>
                        <span className="text-xs text-muted-foreground">{t("desktop.savedNote")}</span>
                        <button type="button" onClick={() => void actions.forgetSaved(savedLogin.id)} className="self-start text-xs text-destructive underline-offset-2 hover:underline">
                            {t("desktop.savedForget")}
                        </button>
                    </div>
                ) : (
                    <>
                    <Field label={form.protocol === "rdp" ? t("desktop.field.login") : t("desktop.field.loginVnc")} addon={form.protocol === "vnc" ? t("common.optional") : undefined}>
                        <Input value={form.login} onChange={(e) => actions.update({ login: e.target.value })} autoComplete="off" autoCapitalize="off" spellCheck={false} />
                    </Field>

                    <Field label={t("desktop.field.password")} hint={t("desktop.credentialsNote")}>
                        <Input type="password" value={form.password} onChange={(e) => actions.update({ password: e.target.value })} autoComplete="off" />
                    </Field>

                    {form.protocol === "rdp" && (
                        <Field label={t("desktop.field.domain")} addon={t("common.optional")}>
                            <Input value={form.domain} onChange={(e) => actions.update({ domain: e.target.value })} autoComplete="off" autoCapitalize="off" spellCheck={false} />
                        </Field>
                    )}
                        <label className="flex items-start gap-2 text-sm text-foreground sm:col-span-2">
                            <input type="checkbox" className="mt-1 size-4 accent-primary" checked={form.save} onChange={(e) => actions.update({ save: e.target.checked })} />
                            <span>
                                {t("desktop.saveLogin")}
                                <span className="block text-xs text-muted-foreground">{t("desktop.saveLoginHint")}</span>
                            </span>
                        </label>
                        {form.save && (
                            <Field label={t("desktop.saveLabel")} addon={t("common.optional")}>
                                <Input value={form.saveLabel} onChange={(e) => actions.update({ saveLabel: e.target.value })} placeholder={`${form.login || form.protocol.toUpperCase()}@${host ? host.address : tunnel?.name ?? ""}`} maxLength={100} />
                            </Field>
                        )}
                    </>
                )}
            </div>

            {noAccounts && tunnel && <Callout tone="warning">{t(isRustDesk ? "desktop.rustdesk.noAccounts" : "desktop.noAccounts", { name: tunnel.name })}</Callout>}

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={onInfo} className="flex min-w-0 items-start gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
                    <Info size={14} className="mt-px shrink-0" aria-hidden />
                    <span className="min-w-0 [overflow-wrap:anywhere]">{t("desktop.pathSummary", { device: tunnel?.name ?? "—", target: host ? address : t("desktop.targetDeviceShort", { address }) })}</span>
                </button>
                <Button type="submit" disabled={!canConnect || busy} className="sm:min-w-40">
                    <ScreenShare size={16} /> {busy ? t("desktop.connecting") : isRustDesk ? t("desktop.rustdesk.connectBrowser") : t("desktop.connect")}
                </Button>
            </div>
        </form>
    );
}

/**
 * RustDesk 的說明與「用 app」的路（收起）：從裝置檢查 Direct IP 埠、跑 ssh -L、用 app 連 127.0.0.1。指令和命令表同一套產生器。
 * The RustDesk notes plus the native-app path behind a disclosure: probe the port from the device, run ssh -L,
 * connect the app to 127.0.0.1. The command comes from the same generator as the command sheet.
 */
function RustDeskPanel({ state, actions }: { state: PageState; actions: PageActions }) {
    const { t, tn } = useI18n();
    const { tunnel, host, form, address, probeState, connectTarget, canProbe } = state;
    const [open, setOpen] = useState(false);
    const probing = probeState.state === "checking";
    const port = isValidPort(form.port) ? form.port : String(RUSTDESK_PORT);
    const params = { lanHost: host ? host.address : "localhost", remotePort: port, localPort: port };
    const segments = connectTarget ? buildSegments("rustdesk", params, connectTarget, { background: false, keepAlive: true, exitOnFailure: false }) : null;
    const appAddr = port === String(RUSTDESK_PORT) ? "127.0.0.1" : `127.0.0.1:${port}`;
    const sheetHref = tunnel ? `/tunnels/cheatsheet?tunnel=${tunnel.id}&recipe=rustdesk&lanHost=${encodeURIComponent(params.lanHost)}&remotePort=${port}&localPort=${port}` : "/tunnels/cheatsheet";
    const code = (s: string) => <code className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[0.9em] text-foreground ring-1 ring-border">{s}</code>;
    const stepClass = "flex gap-3 text-sm leading-relaxed";
    const num = (n: number, done?: boolean) => (
        <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-xs tabular-nums", done ? "bg-success text-success-foreground" : "bg-muted text-muted-foreground")} aria-hidden>{n}</span>
    );

    return (
        <div className="space-y-4">
            <Callout tone="info">
                <p>{t("desktop.rustdesk.intro")}</p>
                <p className="mt-1">{t("desktop.rustdesk.step1")}</p>
            </Callout>
            <div className="rounded-md border border-border bg-surface">
                <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm text-foreground">
                    <ChevronDown size={15} className={cn("shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
                    <span className="flex-1">{t("desktop.rustdesk.app")}</span>
                </button>
                {open && (
                    <div className="space-y-4 border-t border-border px-3 py-3">
                        <p className="text-sm text-muted-foreground">{t("desktop.rustdesk.appIntro")}</p>
                        <ol className="space-y-3">
                            <li className={stepClass}>
                                {num(1, probeState.state === "ok")}
                                <span className="min-w-0 flex-1 space-y-2 text-foreground">
                                    <span className="block">{t("desktop.rustdesk.step2")}</span>
                                    <Button type="button" size="sm" variant="outline" disabled={!canProbe} onClick={() => void actions.runProbe()}>
                                        {probing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {probing ? t("desktop.rustdesk.checking") : t("desktop.rustdesk.check")}
                                    </Button>
                                    {probeState.state === "ok" && (
                                        <span className="flex items-center gap-1.5 text-success"><CheckCircle2 size={15} aria-hidden /> {t("desktop.rustdesk.reachable", { address })}</span>
                                    )}
                                    {probeState.state === "failed" && probeState.failure && (
                                        <span className="flex items-start gap-1.5 text-destructive"><XCircle size={15} className="mt-0.5 shrink-0" aria-hidden /> <span>{t(probeState.failure.key, probeState.failure.vars)}</span></span>
                                    )}
                                </span>
                            </li>
                            <li className={stepClass}>
                                {num(2)}
                                <span className="min-w-0 flex-1 space-y-2 text-foreground">
                                    <span className="block">{t("desktop.rustdesk.step3")}</span>
                                    {segments ? <CommandBar segments={segments} /> : <span className="block text-xs text-muted-foreground">{t("common.loading")}</span>}
                                    <Link href={sheetHref} prefetch={false} className="inline-flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline">
                                        <ExternalLink size={12} aria-hidden /> {t("desktop.rustdesk.sheetLink")}
                                    </Link>
                                </span>
                            </li>
                            <li className={stepClass}>{num(3)}<span className="text-foreground">{tn("desktop.rustdesk.step4", { addr: code(appAddr) })}</span></li>
                        </ol>
                    </div>
                )}
            </div>
        </div>
    );
}
