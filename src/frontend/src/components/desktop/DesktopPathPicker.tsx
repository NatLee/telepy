"use client";

/**
 * 遠端桌面頁的連線選擇器：路徑圖就是表單的前半——你的瀏覽器 ─ Telepy ─ 裝置（選裝置、選帳號）─ 桌面
 * （裝置自己或它區網裡的主機 + 協定 + 埠）。每一站的選項放在那一站的節點裡；線上 / 離線與延遲即時顯示。
 * 其餘欄位（畫質、剪貼簿、登入）留在下方的表單。
 * The desktop page's connect picker: the path diagram is the first half of the form — browser ─ Telepy ─ device
 * (device + account) ─ desktop (the device itself or a LAN host, plus protocol and port). Each choice sits inside
 * its node; online state and the RTT are live. The remaining fields (quality, clipboard, login) stay in the form.
 */
import React from "react";
import Link from "next/link";
import { Monitor, Route, Waypoints } from "lucide-react";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { BrowserNode, DeviceNode, NodeField, TelepyNode } from "@/components/flow/ConnectNodes";
import { useI18n } from "@/lib/i18n";
import { desktopPorts, isValidPort, type DesktopMode } from "@/lib/desktop";
import { hostName } from "@/lib/lanConnect";
import type { useDesktopPage } from "@/hooks/useDesktopPage";

type PageState = ReturnType<typeof useDesktopPage>["state"];
type PageActions = ReturnType<typeof useDesktopPage>["actions"];

const MODE_LABEL: Record<DesktopMode, string> = { rdp: "RDP", vnc: "VNC", rustdesk: "RustDesk" };

export function DesktopPathPicker({ state, actions, onCompare }: { state: PageState; actions: PageActions; onCompare: () => void }) {
    const { t } = useI18n();
    const { tunnels, tunnel, host, online, form, isRustDesk } = state;
    const portOk = isValidPort(form.port);
    const proto = MODE_LABEL[form.protocol];
    const protocolOptions: { value: DesktopMode; label: string }[] = [
        { value: "rdp", label: t("desktop.protocol.rdp") },
        { value: "vnc", label: t("desktop.protocol.vnc") },
        { value: "rustdesk", label: t("desktop.protocol.rustdesk") },
    ];
    const rtt = tunnel?.rtt_ms ?? null;

    return (
        <FlowPath>
            <BrowserNode sub={isRustDesk ? t("desktop.flow.rdb.youSub") : t("desktop.flow.youSub")} />
            <FlowLink label={t("flow.linkWeb")} state="ok" />
            <TelepyNode sub={isRustDesk ? t("desktop.flow.rdb.telepySub") : t("desktop.flow.telepySub", { protocol: proto })} />
            <FlowLink label={t("flow.linkTunnel")} state={tunnel ? (online ? "ok" : "failed") : "waiting"} note={online && typeof rtt === "number" ? `${Math.round(rtt)} ms` : undefined} />
            <DeviceNode
                tunnels={tunnels}
                tunnel={tunnel}
                onTunnel={actions.setTunnel}
                account={form.account}
                onAccount={(account) => actions.update({ account })}
                online={online}
                sub={t("desktop.flow.deviceSub")}
                accountHint={t("desktop.field.accountHint")}
                idPrefix="desk"
            />
            <FlowLink label={host ? t("desktop.flow.linkLan", { port: portOk ? form.port : "?" }) : t("desktop.flow.linkLocal", { port: portOk ? form.port : "?" })} state="waiting" />
            <FlowNode
                icon={Monitor}
                title={host ? hostName(host) : t("desktop.flow.deviceDesktop")}
                sub={host ? t("desktop.target.hintLan", { address: host.address }) : t("desktop.target.hintDevice")}
                state="waiting"
                stateText={t("connect.notYet")}
                wide
                control={
                    <div className="grid gap-2.5 sm:grid-cols-2 @3xl:grid-cols-1">
                        <NodeField
                            id="desk-target"
                            label={t("desktop.field.target")}
                            hint={tunnel && tunnel.hosts.length === 0 ? (
                                <Link className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline" href={`/tunnels/network?tunnel=${tunnel.id}`}>
                                    <Waypoints size={12} aria-hidden /> {t("desktop.findLan")}
                                </Link>
                            ) : undefined}
                            className="sm:col-span-2 @3xl:col-span-1"
                        >
                            <NativeSelect id="desk-target" value={host ? String(host.id) : ""} onChange={(e) => actions.setHost(e.target.value ? Number(e.target.value) : null)} disabled={!tunnel}>
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
                        </NodeField>
                        <NodeField
                            label={t("desktop.field.protocol")}
                            hint={
                                <button type="button" onClick={onCompare} className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline">
                                    <Route size={12} aria-hidden /> {t("desktop.ways.hint")}
                                </button>
                            }
                        >
                            <Segmented options={protocolOptions} value={form.protocol} onChange={actions.setProtocol} fullWidth size="sm" aria-label={t("desktop.field.protocol")} />
                        </NodeField>
                        <NodeField id="desk-port" label={t("desktop.field.port")} hint={portOk ? (isRustDesk ? t("desktop.field.rustdeskPortHint") : t("desktop.field.portHint")) : <span className="text-destructive">{t("desktop.field.portInvalid")}</span>}>
                            <Input id="desk-port" inputMode="numeric" value={form.port} onChange={(e) => actions.update({ port: e.target.value.replace(/[^\d]/g, "") })} aria-invalid={!portOk} className="font-mono" />
                        </NodeField>
                    </div>
                }
            />
        </FlowPath>
    );
}
