"use client";

/**
 * 網路頁的「怎麼運作」：選一台裝置（和它後面的一台主機），畫出你的瀏覽器 ─ Telepy ─ 裝置 ─ 主機 這條路的真實狀態，再列出
 * 到那台主機的五條路（終端機、遠端桌面、網頁、你自己的指令、掃描）現在能不能走、不能的話為什麼；最後是掃描怎麼找到機器
 * （跟那台裝置上次掃描的數字）與裝置需要什麼。一開就選頁面上開著的那台主機。
 * The network page's "how it works": pick a device (and a host behind it) and see the real state of your browser ─
 * Telepy ─ device ─ host, then the five ways to that host (terminal, remote desktop, web page, your own commands,
 * scanning) — whether each works now and why not — and finally how a scan finds machines (with the device's last scan)
 * and what the device needs. It opens on the host the page has open.
 */
import React, { useState } from "react";
import { ArrowDownToLine, Globe, Monitor, Radar, Router, ScreenShare, Server, Terminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { NativeSelect } from "@/components/ui/native-select";
import { FlowLink, FlowNode, FlowNow, FlowPath, FlowSteps, StateLine } from "@/components/flow/PathFlow";
import { useFeatures } from "@/hooks/useFeatures";
import { useI18n } from "@/lib/i18n";
import { hostName, scanRunning } from "@/lib/lanConnect";
import { LANES, laneStates, pathStates, type Lane } from "@/lib/networkFlow";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

const LANE_ICON: Record<Lane, React.ReactNode> = {
    terminal: <Terminal size={16} />,
    desktop: <ScreenShare size={16} />,
    web: <Globe size={16} />,
    commands: <ArrowDownToLine size={16} />,
    scan: <Radar size={16} />,
};

const SCAN_STEPS = ["login", "networks", "discovery", "ports", "identify", "names"] as const;

export function NetworkInfoDialog({ isOpen, onClose, tunnels, startTunnel, startHost, isOnline }: {
    isOpen: boolean;
    onClose: () => void;
    tunnels: TopologyTunnel[];
    startTunnel: TopologyTunnel | null;
    startHost: LanHost | null;
    isOnline: (tn: TopologyTunnel) => boolean;
}) {
    return isOpen ? <NetworkInfo onClose={onClose} tunnels={tunnels} startTunnel={startTunnel} startHost={startHost} isOnline={isOnline} /> : null;
}

/** 每次打開都從頁面的選擇開始（key 由外層的開關重設）。/ Every opening starts from the page's selection. */
function NetworkInfo({ onClose, tunnels, startTunnel, startHost, isOnline }: { onClose: () => void; tunnels: TopologyTunnel[]; startTunnel: TopologyTunnel | null; startHost: LanHost | null; isOnline: (tn: TopologyTunnel) => boolean }) {
    const { t, locale } = useI18n();
    const { has } = useFeatures();
    const first = startTunnel ?? tunnels.find((x) => isOnline(x)) ?? tunnels[0] ?? null;
    const [tunnelId, setTunnelId] = useState<number | null>(first?.id ?? null);
    const [hostId, setHostId] = useState<number | null>(startHost && startHost.tunnel_id === first?.id ? startHost.id : null);
    const tn = tunnels.find((x) => x.id === tunnelId) ?? null;
    const host = tn?.hosts.find((h) => h.id === hostId) ?? null;
    const input = {
        host,
        device: tn ? { online: tn.online === null ? null : isOnline(tn), usernames: tn.usernames, can_scan: tn.can_scan } : null,
        features: { terminal: has("terminal"), remote_desktop: has("remote_desktop"), remote_browser: has("remote_browser"), network: has("network") },
    };
    const lanes = laneStates(input);
    const path = pathStates(input);
    const scan = tn?.scan ?? null;
    const fmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    const now = !tn
        ? t("network.flow.nowNone")
        : path.device === "failed"
            ? t("network.flow.nowOffline", { device: tn.name })
            : host
                ? t("network.flow.nowHost", { host: hostName(host), device: tn.name })
                : t("network.flow.nowDevice", { device: tn.name });

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            icon={<Router size={18} />}
            title={t("network.flow.title")}
            description={t("network.flow.desc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1.5 text-sm text-foreground">
                        <span>{t("network.flow.device")}</span>
                        <NativeSelect value={tunnelId ?? ""} onChange={(e) => { setTunnelId(Number(e.target.value)); setHostId(null); }} className="w-full">
                            {tunnels.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </NativeSelect>
                    </label>
                    <label className="space-y-1.5 text-sm text-foreground">
                        <span>{t("network.flow.host")}</span>
                        <NativeSelect value={hostId ?? ""} onChange={(e) => setHostId(e.target.value ? Number(e.target.value) : null)} className="w-full" disabled={!tn || tn.hosts.length === 0}>
                            <option value="">{t("network.flow.noHost")}</option>
                            {tn?.hosts.map((h) => <option key={h.id} value={h.id}>{hostName(h)} · {h.address}</option>)}
                        </NativeSelect>
                    </label>
                </div>

                <FlowNow failed={path.device === "failed"}>{now}</FlowNow>

                <FlowPath>
                    <FlowNode icon={Monitor} title={t("network.flow.you")} sub={t("network.flow.youSub")} state="ok" stateText={t("network.flow.here")} />
                    <FlowLink label={t("network.flow.linkHttps")} state="ok" />
                    <FlowNode brand title="Telepy" sub={t("network.flow.telepySub")} state={path.telepy} />
                    <FlowLink label={t("network.flow.linkTunnel")} state={path.tunnel} />
                    <FlowNode icon={Router} title={tn?.name ?? t("network.flow.device")} sub={t("network.flow.deviceSub")} state={path.device} stateText={path.device === "ok" ? t("network.web.flow.online") : path.device === "failed" ? t("network.web.flow.offline") : undefined} />
                    <FlowLink label={t("network.flow.linkLan")} state={path.lan} />
                    <FlowNode icon={Server} title={host ? hostName(host) : t("network.flow.host")} sub={host ? host.address : t("network.flow.pickHost")} state={path.host} stateText={host ? undefined : t("network.flow.notPicked")} />
                </FlowPath>

                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">{t("network.flow.lanesTitle")}</h3>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {LANES.map((lane) => (
                            <li key={lane} className="flex items-start gap-3 px-3 py-2.5">
                                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>{LANE_ICON[lane]}</span>
                                <span className="min-w-0 flex-1">
                                    <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                        <span className="text-sm text-foreground">{t(`network.flow.lane.${lane}` as TranslationKey)}</span>
                                        <StateLine state={lanes[lane].state} text={t(`network.flow.why.${lanes[lane].why}` as TranslationKey)} />
                                    </span>
                                    <span className="block text-xs leading-relaxed text-muted-foreground">{t(`network.flow.lane.${lane}How` as TranslationKey)}</span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="space-y-2">
                    <h3 className="text-sm text-foreground">{t("network.flow.scanTitle")}</h3>
                    <p className="text-xs text-muted-foreground">
                        {!scan
                            ? t("network.flow.scanNever")
                            : scanRunning(scan)
                                ? t("network.flow.scanRunning")
                                : scan.phase === "failed"
                                    ? t("network.flow.scanFailed", { error: scan.error ?? "" })
                                    : t("network.flow.scanLast", { when: scan.finished_at ? fmt.format(new Date(scan.finished_at.replace(" ", "T") + "Z")) : "—", networks: scan.networks.join(", ") || "—", hosts: scan.hosts_found })}
                    </p>
                    <FlowSteps
                        steps={SCAN_STEPS.map((s) => t(`network.flow.step.${s}` as TranslationKey))}
                        current={scan && scanRunning(scan) ? Math.max(1, SCAN_STEPS.indexOf(scan.phase === "connecting" ? "login" : (scan.phase as (typeof SCAN_STEPS)[number])) + 1) : 0}
                        done={!!scan && scan.phase === "done"}
                        failed={!!scan && scan.phase === "failed"}
                    />
                    <Callout tone="info">{t("network.flow.needs")}</Callout>
                </section>
            </div>
        </Modal>
    );
}
