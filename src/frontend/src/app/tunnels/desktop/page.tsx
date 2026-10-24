"use client";

/**
 * 遠端桌面頁（`/tunnels/desktop?tunnel=<id>[&lanHost=<id>]`）：在瀏覽器裡看、操作裝置（或它區網裡主機）的
 * RDP / VNC 桌面。沒連線時是表單；連上後是畫面 + 工具列（貼上、Ctrl+Alt+Del、全螢幕、說明、中斷）。
 * 「怎麼運作」（info）打開即時路徑圖，顯示現在在哪一段、卡在哪一段。
 * Remote desktop page: a form while idle, the screen plus a toolbar once connected; the info button opens the live
 * path diagram that shows what is happening and where it stopped.
 */
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ClipboardPaste, Info, Keyboard, Maximize2, Minimize2, MonitorX, Plus, ScreenShare, Waypoints } from "lucide-react";
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
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { DesktopViewer, loadGuacamole, type DesktopViewerHandle } from "@/components/desktop/DesktopViewer";
import { DesktopInfoDialog } from "@/components/desktop/DesktopInfoDialog";
import type { FlowContext } from "@/components/desktop/DesktopFlow";
import { useDesktopPage } from "@/hooks/useDesktopPage";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { desktopPorts, formatElapsed, isValidPort, type DesktopProtocol } from "@/lib/desktop";
import { hostName } from "@/lib/lanConnect";

const CARD = "rounded-xl border border-border bg-card shadow-card";

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
    const { tunnels, loading, tunnel, host, form, phase, failure, session, connectedAt, endedNormally, address } = state;
    const viewerRef = useRef<DesktopViewerHandle | null>(null);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const [infoOpen, setInfoOpen] = useState(false);
    const [pasteOpen, setPasteOpen] = useState(false);
    const [pasteText, setPasteText] = useState("");
    // 遠端複製的文字，綁在當時的 session 上（換 session 就不顯示）。/ Remote clipboard text, tied to its session.
    const [remoteClipState, setRemoteClipState] = useState<{ sid: string; text: string } | null>(null);
    const remoteClip = remoteClipState && session && remoteClipState.sid === session.session_id ? remoteClipState.text : null;
    const [fullscreen, setFullscreen] = useState(false);
    const [now, setNow] = useState(() => Date.now());

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
    }), [phase, failure, form.protocol, form.port, form.account, tunnel, host, clipboard, t]);

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

    const infoButton = (
        <Button variant="outline" onClick={() => setInfoOpen(true)}>
            <Info size={16} /> {t("desktop.howItWorks")}
        </Button>
    );

    return (
        <div className="animate-fade-in-up space-y-6">
            <PageHeader icon={<ScreenShare />} title={t("desktop.title")} description={t("desktop.description")} actions={!session && infoButton} />

            {session ? (
                <div ref={wrapRef} className={cn("flex flex-col overflow-hidden", fullscreen ? "h-full bg-black" : CARD)}>
                    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2">
                        <StatusDot online={phase === "connected"} />
                        <span className="min-w-0 truncate text-sm text-foreground" title={targetLabel}>{targetLabel}</span>
                        <Chip mono>{form.protocol.toUpperCase()}</Chip>
                        {phase === "connected" && connectedAt && <Chip mono>{formatElapsed((now - connectedAt) / 1000)}</Chip>}
                        <span className="flex-1" />
                        {clipboard !== "off" && (
                            <Button size="sm" variant="ghost" onClick={() => setPasteOpen(true)} disabled={phase !== "connected"} title={t("desktop.pasteTitle")}>
                                <ClipboardPaste size={15} /> <span className="hidden sm:inline">{t("desktop.paste")}</span>
                            </Button>
                        )}
                        {form.protocol === "rdp" && (
                            <Button size="sm" variant="ghost" onClick={() => viewerRef.current?.sendCtrlAltDel()} disabled={phase !== "connected"} title={t("desktop.ctrlAltDel")}>
                                <Keyboard size={15} /> <span className="hidden md:inline">Ctrl+Alt+Del</span>
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
                        <DesktopViewer ref={viewerRef} start={session} onConnected={actions.onConnected} onEnded={actions.onEnded} onRemoteClipboard={onRemoteClipboard} />
                        {phase !== "connected" && (
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
        </div>
    );
}

type PageState = ReturnType<typeof useDesktopPage>["state"];
type PageActions = ReturnType<typeof useDesktopPage>["actions"];

function ConnectPanel({ state, actions, onInfo }: { state: PageState; actions: PageActions; onInfo: () => void }) {
    const { t } = useI18n();
    const { tunnels, loading, tunnel, host, online, form, phase, failure, canConnect, address } = state;
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
