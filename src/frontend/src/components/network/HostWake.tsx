"use client";

/**
 * 主機面板的 Wake-on-LAN：知道 MAC 的機器有一行「喚醒」，結果寫在下面（用什麼送的、送到哪個廣播位址、接著怎麼確認），說明鈕
 * 打開路徑圖：你 ─ Telepy ─ 裝置（跑 wakeonlan / etherwake / python3 / PowerShell）─ 廣播 UDP 9 ─ 這台機器，照上一次喚醒的
 * 結果點亮，下面列出裝置依序會試哪些工具、哪一個用上了。
 * The host panel's Wake-on-LAN: machines with a known MAC get a "Wake" row with the result below it (what sent it,
 * which broadcast address, how to confirm); the info button opens the path: you ─ Telepy ─ device (runs wakeonlan /
 * etherwake / python3 / PowerShell) ─ broadcast UDP 9 ─ this machine, lit by the last attempt, then the tools the device
 * tries in order and which one worked.
 */
import React, { useState } from "react";
import { Info, Loader2, Monitor, Power, Router, Server } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { isOwn } from "@/lib/lanChanges";
import { cn } from "@/lib/utils";
import type { WakeResult } from "@/hooks/useNetworkPage";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/** 裝置依序試的工具（跟後端 `lan::wake::posix_command` 一樣的順序）。/ The tools the device tries, in the backend's order. */
export const WAKE_TOOLS = ["wakeonlan", "etherwake", "ether-wake", "python3", "powershell"] as const;

function wakeBlock(host: LanHost, tunnel: TopologyTunnel, online: boolean): TranslationKey | null {
    if (tunnel.usernames.length === 0) return "network.noDeviceUser";
    if (!online) return "network.deviceOffline";
    return null;
}

export function WakeRow({ host, tunnel, online, onWake }: { host: LanHost; tunnel: TopologyTunnel; online: boolean; onWake: (h: LanHost) => Promise<WakeResult> }) {
    const { t } = useI18n();
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<WakeResult | null>(null);
    const [info, setInfo] = useState(false);
    if (isOwn(host) || !host.mac) return null;
    const block = wakeBlock(host, tunnel, online);
    return (
        <div className="space-y-2 rounded-lg border border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-muted-foreground">
                    {t("network.wake.title")} · <span className="font-mono">{host.mac}</span>
                </p>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setInfo(true)} title={t("network.wake.how")} aria-label={t("network.wake.how")}>
                        <Info size={15} />
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={!!block || busy}
                        title={block ? t(block) : t("network.wake.hint")}
                        onClick={async () => {
                            setBusy(true);
                            setResult(await onWake(host));
                            setBusy(false);
                        }}
                    >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : <Power size={15} />} {t("network.wake.button")}
                    </Button>
                </div>
            </div>
            {result?.ok && <Callout tone="tip">{t(result.broadcast ? "network.wake.sentTo" : "network.wake.sent", { tool: result.tool, broadcast: result.broadcast ?? "" })}</Callout>}
            {result && !result.ok && <Callout tone="danger">{result.error}</Callout>}
            <WakeInfoDialog isOpen={info} onClose={() => setInfo(false)} host={host} tunnel={tunnel} online={online} result={result} />
        </div>
    );
}

export function WakeInfoDialog({ isOpen, onClose, host, tunnel, online, result }: { isOpen: boolean; onClose: () => void; host: LanHost; tunnel: TopologyTunnel; online: boolean; result: WakeResult | null }) {
    const { t } = useI18n();
    if (!isOpen) return null;
    const sent = result?.ok ? result : null;
    const failed = result && !result.ok;
    const used = sent ? sent.tool.replace(/^sudo /, "") : null;
    const name = host.label || host.hostname || host.address;
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            icon={<Power size={18} />}
            title={t("network.wake.infoTitle")}
            description={t("network.wake.infoDesc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Monitor} title={t("network.flow.you")} sub={t("network.wake.youSub")} state="ok" />
                    <FlowLink label={t("network.wake.linkSsh")} state={online ? "ok" : "failed"} />
                    <FlowNode
                        icon={Router}
                        title={tunnel.name}
                        sub={used ? t("network.wake.ranWith", { tool: sent!.tool }) : t("network.wake.deviceSub")}
                        state={!online || failed ? "failed" : sent ? "ok" : "waiting"}
                        stateText={!online ? t("network.web.flow.offline") : failed ? t("network.wake.notSent") : sent ? t("network.wake.sentShort") : undefined}
                    />
                    <FlowLink label={sent?.broadcast ? t("network.wake.linkBroadcastTo", { broadcast: sent.broadcast }) : t("network.wake.linkBroadcast")} state={sent ? "ok" : "waiting"} />
                    <FlowNode icon={Server} title={name} sub={host.mac ?? ""} state={sent ? "active" : "waiting"} stateText={sent ? t("network.wake.starting") : undefined} />
                </FlowPath>
                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">{t("network.wake.toolsTitle")}</h3>
                    <ol className="divide-y divide-border rounded-lg border border-border">
                        {WAKE_TOOLS.map((tool, i) => (
                            <li key={tool} className={cn("flex items-start gap-3 px-3 py-2", used === tool && "bg-success/[0.06]")}>
                                <span className="mt-0.5 font-mono text-xs text-muted-foreground">{i + 1}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-baseline gap-x-2">
                                        <code className="font-mono text-sm text-foreground">{tool}</code>
                                        {used === tool && <span className="text-xs text-success">{t("network.wake.usedThis")}</span>}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">{t(`network.wake.tool.${tool.replace("-", "_")}` as TranslationKey)}</span>
                                </span>
                            </li>
                        ))}
                    </ol>
                </section>
                <Callout tone="info">{t("network.wake.needs")}</Callout>
            </div>
        </Modal>
    );
}
