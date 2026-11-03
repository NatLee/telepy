"use client";

/**
 * 「區網主機的網頁怎麼到你這裡？」：兩條直線路徑並排比較。
 * ① Telepy 的遠端瀏覽器：你的瀏覽器 ─畫面（VNC）─ Telepy（Chromium）─通道─ 裝置 ─ 主機:port。你只收到畫面。
 * ② 你自己的瀏覽器：你的電腦（`telepy forward` / `ssh -L`）─SSH─ Telepy ─通道─ 裝置 ─ 主機:port。網頁本身到你電腦。
 * 裝置在不在線決定通道那一段；主機那一段 Telepy 開了才知道。下面是兩條路的差別與 ② 的那一行指令。
 * "How does a LAN host's page reach you?": two straight paths side by side. ① Telepy's remote browser: only the
 * picture reaches you. ② Your own browser through `telepy forward` / `ssh -L`: the page itself reaches your
 * computer. The device's state lights the tunnel hop; the host hop is only known once opened. Below: how they differ
 * and the one command for ②.
 */
import React, { useState } from "react";
import { Globe, Laptop, Monitor, Router, Server } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { CopyButton } from "@/components/ui/CopyButton";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { forwardCommand, shortUrl, webLinks } from "@/lib/lanWeb";
import { hostName } from "@/lib/lanConnect";
import type { SpotState } from "@/lib/flow";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/** 兩條路的差別（每列：遠端瀏覽器 / 自己的瀏覽器）。/ How the two ways differ (each row: remote browser / own browser). */
const ROWS: { label: TranslationKey; remote: TranslationKey; own: TranslationKey }[] = [
    { label: "network.web.cmp.needs", remote: "network.web.cmp.needsRemote", own: "network.web.cmp.needsOwn" },
    { label: "network.web.cmp.reaches", remote: "network.web.cmp.reachesRemote", own: "network.web.cmp.reachesOwn" },
    { label: "network.web.cmp.files", remote: "network.web.cmp.filesRemote", own: "network.web.cmp.filesOwn" },
    { label: "network.web.cmp.yours", remote: "network.web.cmp.yoursRemote", own: "network.web.cmp.yoursOwn" },
    { label: "network.web.cmp.phone", remote: "network.web.cmp.phoneRemote", own: "network.web.cmp.phoneOwn" },
];

export function LanWebInfoDialog({ isOpen, onClose, host, tunnel, online, deviceUser }: {
    isOpen: boolean;
    onClose: () => void;
    host: LanHost;
    tunnel: TopologyTunnel;
    online: boolean;
    deviceUser: string | null;
}) {
    const { t } = useI18n();
    const links = webLinks(host);
    const [port, setPort] = useState<number>(links[0]?.port ?? 80);
    const tunnelState: SpotState = online ? "ok" : "failed";
    const target = `${host.address}:${port}`;
    const command = forwardCommand(tunnel.name, deviceUser, host.address, port);

    const lane = (own: boolean) => (
        <FlowPath>
            <FlowNode compact icon={own ? Laptop : Monitor} title={own ? t("network.web.flow.yourComputer") : t("network.web.flow.yourBrowser")} sub={own ? t("network.web.flow.yourComputerSub") : t("network.web.flow.yourBrowserSub")} state="ok" stateText={t("network.web.flow.you")} />
            <FlowLink compact label={own ? t("network.web.flow.linkSsh") : t("network.web.flow.linkPicture")} state="ok" />
            <FlowNode compact brand title="Telepy" sub={own ? t("network.web.flow.telepyGateway") : t("network.web.flow.telepyChromium")} state="ok" stateText={t("network.web.flow.ready")} />
            <FlowLink compact label={t("network.web.flow.linkTunnel")} state={tunnelState} />
            <FlowNode compact icon={Router} title={tunnel.name} sub={t("network.web.flow.deviceSub", { user: deviceUser ?? "—" })} state={tunnelState} stateText={online ? t("network.web.flow.online") : t("network.web.flow.offline")} />
            <FlowLink compact label={t("network.web.flow.linkLan")} state={online ? "waiting" : "failed"} />
            <FlowNode compact icon={Server} title={<span className="font-mono">{target}</span>} sub={hostName(host)} state="waiting" stateText={t("network.web.flow.notChecked")} />
        </FlowPath>
    );

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            size="3xl"
            icon={<Globe size={18} />}
            title={t("network.web.flow.title", { name: hostName(host) })}
            description={t("network.web.flow.desc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                {links.length > 1 && (
                    <label className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                        {t("network.web.flow.which")}
                        <NativeSelect value={String(port)} onChange={(e) => setPort(Number(e.target.value))} className="w-auto font-mono">
                            {links.map((l) => <option key={l.port} value={l.port}>{shortUrl(l.url)}</option>)}
                        </NativeSelect>
                    </label>
                )}
                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">① {t("network.web.flow.remoteTitle")}</h3>
                    <p className="text-xs text-muted-foreground">{t("network.web.flow.remoteDesc")}</p>
                    {lane(false)}
                </section>
                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">② {t("network.web.flow.ownTitle")}</h3>
                    <p className="text-xs text-muted-foreground">{t("network.web.flow.ownDesc")}</p>
                    {lane(true)}
                    <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                        <code className="min-w-0 flex-1 font-mono text-[0.8125rem] text-foreground [overflow-wrap:anywhere]">{command}</code>
                        <CopyButton value={command} />
                    </div>
                    <p className="text-xs text-muted-foreground">{t("network.web.flow.ownNote")}</p>
                </section>
                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">{t("network.web.cmp.title")}</h3>
                    {/* 寬的時候三欄表格，窄的時候每列疊起來。/ A three-column table when wide, stacked rows when narrow. */}
                    <div className="@container">
                        <dl className="divide-y divide-border rounded-lg border border-border text-sm">
                            <div className="hidden px-3 py-2 text-xs text-muted-foreground @xl:grid @xl:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,1fr)] @xl:gap-3">
                                <span />
                                <span>① {t("network.web.flow.remoteTitle")}</span>
                                <span>② {t("network.web.flow.ownTitle")}</span>
                            </div>
                            {ROWS.map((r) => (
                                <div key={r.label} className="grid gap-1 px-3 py-2 @xl:grid-cols-[minmax(0,9rem)_minmax(0,1fr)_minmax(0,1fr)] @xl:gap-3">
                                    <dt className="text-muted-foreground">{t(r.label)}</dt>
                                    <dd className="text-foreground"><span className="text-muted-foreground @xl:hidden">① </span>{t(r.remote)}</dd>
                                    <dd className="text-foreground"><span className="text-muted-foreground @xl:hidden">② </span>{t(r.own)}</dd>
                                </div>
                            ))}
                        </dl>
                    </div>
                </section>
            </div>
        </Modal>
    );
}
