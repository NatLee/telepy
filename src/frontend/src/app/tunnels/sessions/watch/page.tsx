"use client";

/**
 * 看別人的網頁終端機（`?shell=<id>`，從即時 session 頁的「看」進來）：唯讀的 xterm（照那個 session 的大小，太寬就縮小），
 * 上面一排狀態與按鈕：申請打字 / 撤回 / 交回、owner 與 ADMIN 可以直接接手；info 按鈕打開即時說明圖。
 * Watching someone's web terminal (`?shell=<id>`, from the live sessions page's Watch): a read-only xterm at the
 * session's size (scaled down to fit), with the state and the control buttons above; the info button opens the live
 * explainer.
 */
import React, { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import "xterm/css/xterm.css";
import { ArrowLeft, Eye, Hand, Info, Keyboard, Undo2, Video, Zap } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip } from "@/components/ui/section";
import { WatchInfoDialog } from "@/components/watch/WatchInfoDialog";
import { useTerminalWatch } from "@/hooks/useTerminalWatch";
import { useI18n } from "@/lib/i18n";
import { controller, watchCloseReason, watcherNames, watchPhase } from "@/lib/terminalWatch";
import type { TranslationKey } from "@/locales/en";

const CLOSED_TEXT: Record<ReturnType<typeof watchCloseReason>, TranslationKey> = {
    ended: "watch.closed.ended",
    gone: "watch.closed.gone",
    refused: "watch.closed.refused",
    stepUp: "watch.closed.stepUp",
    endedBy: "watch.closed.endedBy",
    signedOut: "watch.closed.signedOut",
    dropped: "watch.closed.dropped",
};

function WatchInner() {
    const { t } = useI18n();
    const params = useSearchParams();
    const shell = params.get("shell");
    // 從管理區的全站即時連線來的，就回那裡。/ Opened from the admin section's live sessions: go back there.
    const backTo = params.get("from") === "admin" ? "/tunnels/admin/sessions" : "/tunnels/sessions";
    const { hostRef, ...w } = useTerminalWatch(shell);
    const [info, setInfo] = useState(false);
    const [confirmForce, setConfirmForce] = useState(false);
    const frameRef = React.useRef<HTMLDivElement | null>(null);
    const [box, setBox] = useState({ scale: 1, height: 0 });

    // 太寬就整個縮小（跟錄影播放器一樣）。/ Scale the whole screen down when it is too wide (like the cast player).
    useEffect(() => {
        const frame = frameRef.current;
        const host = hostRef.current;
        if (!frame || !host) return;
        const ro = new ResizeObserver(() => {
            const scale = Math.min(1, frame.clientWidth / (host.scrollWidth || 1));
            setBox({ scale, height: host.scrollHeight * scale });
        });
        ro.observe(frame);
        ro.observe(host);
        return () => ro.disconnect();
    }, [hostRef, w.start]);

    const user = w.start?.user.username ?? "";
    const phase = watchPhase({ open: w.open, closeCode: w.closed?.code ?? null, detached: w.detached, control: w.control });
    const typing = controller(w.watchers);
    const others = watcherNames({ type: "watchers", watchers: w.watchers?.watchers.filter((x) => x.id !== w.start?.you) ?? [], control: null });
    const where = w.start ? (w.start.lan_host ? `${w.start.account} → ${w.start.lan_host}` : w.start.account) : "";

    if (!shell) {
        return <Callout tone="warning">{t("watch.noShell")}</Callout>;
    }

    return (
        <div className="flex flex-col gap-4 animate-fade-in-up">
            <PageHeader
                icon={<Eye />}
                title={user ? t("watch.title", { user }) : t("watch.titleLoading")}
                description={w.start ? t("watch.subtitle", { tunnel: w.start.tunnel.name, account: where }) : t("watch.subtitleLoading")}
                actions={
                    <>
                        <Button variant="outline" onClick={() => setInfo(true)}>
                            <Info size={16} /> {t("watch.howItWorks")}
                        </Button>
                        <Button variant="ghost" asChild>
                            <Link href={`${backTo}${w.start ? `?tunnel=${w.start.tunnel.id}` : ""}`}>
                                <ArrowLeft size={16} /> {t("watch.back")}
                            </Link>
                        </Button>
                    </>
                }
            />

            {w.closed ? (
                <Callout tone={w.closed.code === 4004 ? "danger" : "info"} title={t("watch.closed.title")}>
                    {t(CLOSED_TEXT[watchCloseReason(w.closed.code, w.closed.reason)], { by: w.closed.reason || "?" })}
                    {watchCloseReason(w.closed.code, w.closed.reason) === "dropped" && (
                        <Button size="sm" variant="outline" className="mt-2 block" onClick={w.actions.reconnect}>
                            {t("watch.reconnect")}
                        </Button>
                    )}
                </Callout>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    {w.control === "granted" ? (
                        <Chip tone="primary"><Keyboard /> {t("watch.youType")}</Chip>
                    ) : w.control === "requested" ? (
                        <Chip tone="warning"><Hand /> {t("watch.waitingFor", { user })}</Chip>
                    ) : (
                        <Chip><Eye /> {t("watch.readOnly")}</Chip>
                    )}
                    {typing && w.control !== "granted" && <Chip tone="primary">{t("watch.typingNow", { user: typing.username })}</Chip>}
                    {w.detached && <Chip tone="warning">{t("watch.detached", { user })}</Chip>}
                    {w.start?.recorded && <Chip><Video /> {t("watch.recorded")}</Chip>}
                    {others.length > 0 && <Chip>{t("watch.alsoWatching", { names: others.join(", ") })}</Chip>}
                    {w.size && <Chip mono>{`${w.size.cols}×${w.size.rows}`}</Chip>}
                    <span className="ml-auto flex flex-wrap gap-2">
                        {w.control === "none" && (
                            <Button size="sm" onClick={w.actions.request} disabled={!w.open}>
                                <Hand size={15} /> {t("watch.request")}
                            </Button>
                        )}
                        {w.control === "requested" && (
                            <Button size="sm" variant="outline" onClick={w.actions.release}>
                                <Undo2 size={15} /> {t("watch.withdraw")}
                            </Button>
                        )}
                        {w.control === "granted" && (
                            <Button size="sm" variant="outline" onClick={w.actions.release}>
                                <Undo2 size={15} /> {t("watch.giveBack")}
                            </Button>
                        )}
                        {w.start?.can_force && w.control !== "granted" && (
                            <Button size="sm" variant="outline" onClick={() => setConfirmForce(true)} disabled={!w.open}>
                                <Zap size={15} /> {t("watch.force")}
                            </Button>
                        )}
                    </span>
                </div>
            )}

            {w.command && !w.closed && (
                <Callout tone="warning">{t("watch.commandPending", { command: w.command.command ?? "" })}</Callout>
            )}

            <div ref={frameRef} className="overflow-hidden rounded-xl border border-border p-2" style={{ background: w.look.scheme.theme.background }}>
                <div style={{ transform: `scale(${box.scale})`, transformOrigin: "top left", height: box.scale < 1 ? box.height : undefined }}>
                    <div ref={hostRef} className="inline-block" />
                </div>
                {!w.start && !w.closed && <p className="p-4 text-sm text-muted-foreground">{t("watch.connecting")}</p>}
            </div>
            <p className="text-xs text-muted-foreground">{w.control === "granted" ? t("watch.footControl", { user }) : t("watch.footReadOnly", { user: user || "?" })}</p>

            <WatchInfoDialog
                isOpen={info}
                onClose={() => setInfo(false)}
                ctx={{ phase, user, account: w.start?.account ?? null, device: w.start?.tunnel.name ?? null, recorded: w.start ? w.start.recorded : null }}
            />
            <ConfirmDialog
                isOpen={confirmForce}
                onClose={() => setConfirmForce(false)}
                onConfirm={() => {
                    w.actions.force();
                    setConfirmForce(false);
                }}
                title={t("watch.forceTitle")}
                message={t("watch.forceMessage", { user })}
                confirmText={t("watch.force")}
            />
        </div>
    );
}

export default function WatchPage() {
    return (
        <Suspense>
            <WatchInner />
        </Suspense>
    );
}
