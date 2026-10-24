"use client";

/**
 * 遠端桌面頁（`/tunnels/desktop?tunnel=<id>[&lanHost=<id>]`）：在瀏覽器裡看、操作裝置（或它區網裡主機）的
 * RDP / VNC 桌面。沒連線時是表單（含畫質預設）；連上後是畫面 + 工具列：延遲 / 串流狀態（點開看每一段）、
 * 螢幕選單（VNC 多螢幕只看一個）、鍵盤選單（送出文字 —— IME 的備援、Ctrl+Alt+Del、Ctrl 當 ⌘）、貼上、全螢幕、
 * 說明、中斷。「怎麼運作」（info）打開即時路徑圖，顯示現在在哪一段、卡在哪一段，連線中每段線標上往返時間。
 * Remote desktop page: a form while idle, the screen plus a toolbar once connected (latency / stream button,
 * screen menu, keyboard menu with the type-text fallback); the info button opens the live path diagram.
 */
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ClipboardPaste, Info, KeyRound, Keyboard, Maximize2, Minimize2, Monitor, MonitorX, Plus, RefreshCw, ScreenShare, TextCursorInput, Waypoints } from "lucide-react";
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
import { DesktopInfoDialog } from "@/components/desktop/DesktopInfoDialog";
import { DesktopStatsButton } from "@/components/desktop/DesktopStats";
import type { FlowContext } from "@/components/desktop/DesktopFlow";
import { useDesktopPage } from "@/hooks/useDesktopPage";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { desktopPorts, formatElapsed, isValidPort, type DesktopProtocol, type DesktopQuality } from "@/lib/desktop";
import { screenChoices, type ScreenChoice } from "@/lib/desktopScreens";
import { hostName } from "@/lib/lanConnect";
import type { TranslationKey } from "@/locales/en";

const CARD = "rounded-xl border border-border bg-card shadow-card";

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
    const { tunnels, loading, tunnel, host, form, phase, failure, session, connectedAt, endedNormally, address, stats, unstable, framebuffer, scale, screens, viewportId, ctrlAsCmd, pixelRatio } = state;
    const viewerRef = useRef<DesktopViewerHandle | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState("");
    const [typeOpen, setTypeOpen] = useState(false);
    const [typeText, setTypeText] = useState("");
    // 遠端複製的文字，綁在當時的 session 上（換 session 就不顯示）。/ Remote clipboard text, tied to its session.
    const [remoteClipState, setRemoteClipState] = useState<{ sid: string; text: string } | null>(null);
    const remoteClip = remoteClipState && session && remoteClipState.sid === session.session_id ? remoteClipState.text : null;
    const [fullscreen, setFullscreen] = useState(false);
    const [now, setNow] = useState(() => Date.now());
    // 螢幕配置（整個桌面以外的選項）。重算的時機：螢幕清單或畫面大小變了、選單打開時、偵測完兩秒後
    // （macOS 的排列靠畫面裡的黑色區域判斷，要等畫面畫出來）。計算讀 canvas，所以在事件 / 計時器裡做，不在 render 裡。
    // The screen choices. Recomputed when the list or framebuffer changes, when the menu opens and two seconds
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

    const chosen = choices.find((c) => c.id === viewportId) ?? null;
    const viewport = chosen?.viewport ?? null;
    const choiceLabel = (c: ScreenChoice) => (c.preset ? t(PRESET_KEY[c.preset]) : c.name);

    const clipboard = session?.clipboard ?? null;
    const ctx: FlowContext = useMemo(() => ({
        phase,
        failure,
        protocol: form.protocol,
        port: isValidPort(form.port) ? Number(form.port) : 0,
        deviceName: tunnel?.name ?? t("desktop.flow.device"),
        account: form.account,
        lanHost: host ? { name: hostName(host), address: host.address } : null,
        clipboard,
        savedLogin: !!state.savedLogin,
        stats,
    }), [phase, failure, form.protocol, form.port, form.account, tunnel, host, clipboard, t, state.savedLogin, stats]);

    const targetLabel = host ? `${hostName(host)} · ${address}` : t("desktop.targetDeviceShort", { address });
    const toggleFullscreen = () => {
        const el = wrapRef.current;
        if (!el) return;
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el.requestFullscreen?.().catch(() => undefined);
    };
    const onRemoteClipboard = (text: string) => {
        if (session) setRemoteClipState({ sid: session.session_id, text });
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
        viewerRef.current?.typeText(typeText);
        setTypeOpen(false);
        setTypeText("");
        showSuccess(t("desktop.typeText.sent"));
        viewerRef.current?.focus();
    };

    const infoButton = (
        <Button variant="outline" onClick={() => setInfoOpen(true)}>
            <Info size={16} /> {t("desktop.howItWorks")}
        </Button>
    );
    const connected = phase === "connected";
    const isDeviceDesktop = !!session && session.target.lan_host_id === null;

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader icon={<ScreenShare />} title={t("desktop.title")} description={t("desktop.description")} actions={!session && infoButton} />

            {session ? (
                <div ref={wrapRef} className={cn("flex flex-col overflow-hidden", fullscreen ? "h-full bg-black" : CARD)}>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
                        <StatusDot online={connected} />
                        <span className="min-w-0 truncate text-sm text-foreground" title={targetLabel}>{targetLabel}</span>
                        <Chip mono>{form.protocol.toUpperCase()}</Chip>
                        {connected && connectedAt && <Chip mono>{formatElapsed((now - connectedAt) / 1000)}</Chip>}
                        {connected && <DesktopStatsButton stats={stats} unstable={unstable} now={now} framebuffer={framebuffer} viewport={viewport} scale={scale} />}
                        <span className="flex-1" />
                        {session.protocol === "vnc" && (
                            <DropdownMenu onOpenChange={(open) => { if (open) recomputeChoices(); }}>
                                <DropdownMenuTrigger asChild>
                                    <Button size="sm" variant="ghost" disabled={!connected} title={t("desktop.screen.menu")}>
                                        <Monitor size={15} />
                                        <span className="hidden max-w-32 truncate sm:inline">{chosen ? choiceLabel(chosen) : t("desktop.screen.whole")}</span>
                                        <ChevronDown size={13} className="text-muted-foreground" aria-hidden />
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-64">
                                    <DropdownMenuLabel>{t("desktop.screen.menu")}</DropdownMenuLabel>
                                    <DropdownMenuRadioGroup value={chosen ? chosen.id : ""} onValueChange={(v) => { actions.setViewportId(v); viewerRef.current?.focus(); }}>
                                        <DropdownMenuRadioItem value="">
                                            <span className="flex-1">{t("desktop.screen.whole")}</span>
                                            {framebuffer && <span className="font-mono text-xs text-muted-foreground">{framebuffer.width}×{framebuffer.height}</span>}
                                        </DropdownMenuRadioItem>
                                        {choices.map((c) => (
                                            <DropdownMenuRadioItem key={c.id} value={c.id}>
                                                <span className="min-w-0 flex-1 truncate">{choiceLabel(c)}{c.primary ? ` · ${t("desktop.screen.primary")}` : ""}</span>
                                                <span className="font-mono text-xs text-muted-foreground">{c.viewport.width}×{c.viewport.height}</span>
                                            </DropdownMenuRadioItem>
                                        ))}
                                    </DropdownMenuRadioGroup>
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
                                <Button size="sm" variant="ghost" disabled={!connected} title={t("desktop.keyboard.menu")}>
                                    <Keyboard size={15} /> <span className="hidden md:inline">{t("desktop.keyboard.menu")}</span>
                                    <ChevronDown size={13} className="text-muted-foreground" aria-hidden />
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
                            <Button size="sm" variant="ghost" onClick={() => setPasteOpen(true)} disabled={!connected} title={t("desktop.pasteTitle")}>
                                <ClipboardPaste size={15} /> <span className="hidden md:inline">{t("desktop.paste")}</span>
                            </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={toggleFullscreen} title={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")} aria-label={fullscreen ? t("desktop.exitFullscreen") : t("desktop.fullscreen")}>
                            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setInfoOpen(true)} title={t("desktop.howItWorks")} aria-label={t("desktop.howItWorks")}>
                            <Info size={15} />
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => { viewerRef.current?.disconnect(); actions.stop(); }}>
                            <MonitorX size={15} /> {t("desktop.disconnect")}
                        </Button>
                    </div>
                    {remoteClip !== null && clipboard === "both" && (
                        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground">
                            <span className="shrink-0">{t("desktop.remoteClipboard")}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-foreground">{remoteClip}</span>
                            <CopyButton value={remoteClip} />
                        </div>
                    )}
                    <div className={cn("relative", fullscreen ? "flex-1" : "h-[calc(100dvh-15rem)] min-h-80")}>
                        <DesktopViewer
                            ref={viewerRef}
                            start={session}
                            viewport={viewport}
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
            ) : (
                <ConnectPanel state={state} actions={actions} onInfo={() => setInfoOpen(true)} />
            )}

            {!session && endedNormally && phase === "idle" && <Callout tone="info">{t("desktop.ended")}</Callout>}
            {!loading && tunnels.length === 0 && (
                <Callout tone="tip">
                    {t("desktop.noTunnels")}{" "}
                    <Link className="text-primary underline-offset-2 hover:underline" href="/tunnels/create"><Plus size={14} className="inline align-[-2px]" /> {t("desktop.addDevice")}</Link>
                </Callout>
            )}

            <DesktopInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} ctx={ctx} />
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

function ConnectPanel({ state, actions, onInfo }: { state: PageState; actions: PageActions; onInfo: () => void }) {
    const { t, tn } = useI18n();
    const { tunnels, loading, tunnel, host, online, form, phase, failure, canConnect, address, savedLogins, savedLogin, quality } = state;
    const portOk = isValidPort(form.port);
    const busy = phase === "starting";
    // 預熱畫面元件的 chunk（與填表並行）。/ Warm up the client chunk while the form is filled in.
    useEffect(() => { void loadGuacamole().catch(() => undefined); }, []);

    if (loading) return <div className={cn(CARD, "p-8 text-center text-sm text-muted-foreground")}>{t("common.loading")}</div>;
    if (tunnels.length === 0) return null;

    const protocolOptions: { value: DesktopProtocol; label: string }[] = [
        { value: "rdp", label: t("desktop.protocol.rdp") },
        { value: "vnc", label: t("desktop.protocol.vnc") },
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

            <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("desktop.field.device")} hint={tunnel && !online ? t("desktop.offline") : undefined}>
                    <NativeSelect value={tunnel ? String(tunnel.id) : ""} onChange={(e) => actions.setTunnel(Number(e.target.value))}>
                        {tunnels.map((tn) => (
                            <option key={tn.id} value={tn.id}>
                                {tn.name}{tn.online === false ? ` · ${t("desktop.offlineShort")}` : ""}
                            </option>
                        ))}
                    </NativeSelect>
                </Field>

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
                            const seen = desktopPorts(h.open_ports).map((d) => `${d.protocol.toUpperCase()} ${d.port}`).join(", ");
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

                <Field label={t("desktop.field.protocol")}>
                    <Segmented options={protocolOptions} value={form.protocol} onChange={actions.setProtocol} fullWidth aria-label={t("desktop.field.protocol")} />
                </Field>

                <Field label={t("desktop.field.port")} hint={t("desktop.field.portHint")} error={portOk ? undefined : t("desktop.field.portInvalid")}>
                    <Input inputMode="numeric" value={form.port} onChange={(e) => actions.update({ port: e.target.value.replace(/[^\d]/g, "") })} />
                </Field>

                <Field label={t("desktop.field.quality")} hint={t(QUALITY_HINT[quality])}>
                    <Segmented options={qualityOptions} value={quality} onChange={actions.setQuality} fullWidth aria-label={t("desktop.field.quality")} />
                </Field>

                {savedLogins.length > 0 && (
                    <Field label={t("desktop.field.saved")} hint={t("desktop.field.savedHint")}>
                        <NativeSelect value={form.savedId ? String(form.savedId) : ""} onChange={(e) => actions.update({ savedId: e.target.value ? Number(e.target.value) : null })}>
                            <option value="">{t("desktop.field.savedNone")}</option>
                            {savedLogins.map((c) => (
                                <option key={c.id} value={c.id}>{c.label}{c.login ? ` (${c.login})` : ""}</option>
                            ))}
                        </NativeSelect>
                    </Field>
                )}

                {savedLogin ? (
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

            {noAccounts && tunnel && <Callout tone="warning">{t("desktop.noAccounts", { name: tunnel.name })}</Callout>}

            <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={onInfo} className="flex min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
                    <Info size={14} className="shrink-0" aria-hidden />
                    <span className="truncate">{t("desktop.pathSummary", { device: tunnel?.name ?? "—", target: host ? address : t("desktop.targetDeviceShort", { address }) })}</span>
                </button>
                <Button type="submit" disabled={!canConnect || busy} className="sm:min-w-40">
                    <ScreenShare size={16} /> {busy ? t("desktop.connecting") : t("desktop.connect")}
                </Button>
            </div>
        </form>
    );
}
