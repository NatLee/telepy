"use client";

/**
 * 「連到 Telepy 的方式」的說明：你的電腦 → Telepy（①，這個對話框選的）與裝置 → Telepy（②，建立通道時選的）是兩條各自的
 * 連線，在 Telepy 會合。上方是即時的路徑圖（你目前的選擇、這台 / 這些裝置的通道實際走哪種），中間是 ① 的兩種方式（可以
 * 直接改），下面是 ① 和建立通道的那條 SSH 對照。
 * The "how you reach Telepy" explainer: your computer → Telepy (①, chosen in this dialog) and device → Telepy (②,
 * chosen when the tunnel was created) are separate connections that meet at Telepy. A live path diagram (your current
 * choice, how the device's / devices' tunnels actually came in), the two ways for ① (switchable here), and ① compared
 * with the tunnel's own SSH.
 */
import React from "react";
import { Boxes, Check, Cpu, Laptop, Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useHttps } from "@/components/tunnels/TransportVisibility";
import { COMPARE_ROWS, deviceCounts, deviceLinkState, deviceLinkText, laptopAddress, type DeviceSide, type LaptopTransport } from "@/lib/transportInfo";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    choice: LaptopTransport;
    /** 有就在卡片上放「改用這個方式」。/ When given, each card offers "use this way". */
    onChoose?: (v: LaptopTransport) => void;
    server: { host: string; port: string } | null;
    wsUrl: string | null;
    /** 一台（單台的 SSH config）或勾選的那些（多台）。/ One device (single config) or the ticked ones (bulk). */
    devices: DeviceSide[];
    /** 一台時的名稱。/ The device's name when there is one. */
    deviceName?: string;
}

const WAYS: { id: LaptopTransport; title: TranslationKey; what: TranslationKey; when: TranslationKey; needs: TranslationKey }[] = [
    { id: "ssh", title: "config.transportSsh", what: "config.ti.sshWhat", when: "config.ti.sshWhen", needs: "config.ti.sshNeeds" },
    { id: "auto", title: "config.transportAuto", what: "config.ti.autoWhat", when: "config.ti.autoWhen", needs: "config.ti.autoNeeds" },
    { id: "websocket", title: "config.transportWeb", what: "config.ti.webWhat", when: "config.ti.webWhen", needs: "config.ti.webNeeds" },
];

export function TransportInfoDialog({ isOpen, onClose, choice, onChoose, server, wsUrl, devices, deviceName }: Props) {
    const { t, tn } = useI18n();
    const https = useHttps();
    const counts = deviceCounts(devices);
    const linkState = deviceLinkState(counts);
    const many = devices.length !== 1;
    const deviceText = deviceLinkText(counts).map((p) => t(p.key, { count: p.count })).join(" · ");
    const code = (s: string) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground [overflow-wrap:anywhere]">{s}</code>;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("config.ti.title")} description={t("config.ti.subtitle")} size="4xl">
            <div className="space-y-6 text-sm">
                <figure className="space-y-3" aria-label={t("config.ti.mapAria")}>
                    <FlowPath>
                        <FlowNode icon={Laptop} title={t("config.map.you")} sub="~/.ssh/config" stateText={t("config.ti.youState")} />
                        <FlowLink label={`① ${t("config.ti.linkMine")}`} note={t(choice === "websocket" ? "config.ti.noteWeb" : choice === "auto" ? "config.ti.noteAuto" : "config.ti.noteSsh")} state="active" />
                        <FlowNode brand title="Telepy" sub={server?.host ?? "—"} state="ok" stateText={t("config.ti.meet")} />
                        <FlowLink label={`② ${t("config.ti.linkDevice")}`} state={linkState} />
                        <FlowNode
                            icon={many ? Boxes : Cpu}
                            title={many ? t("config.bulk.mapDevices", { count: devices.length }) : deviceName || t("config.block.device")}
                            sub={deviceText}
                            state={linkState}
                            stateText={
                                many
                                    ? t("config.bulk.mapOnline", { online: counts.ssh + counts.web + counts.unknown, count: devices.length })
                                    : t(linkState === "ok" ? "config.state.online" : "config.state.offline")
                            }
                        />
                    </FlowPath>
                    <Callout tone="info" icon={<Lock />}>{t("config.ti.inside")}</Callout>
                </figure>

                <section className="space-y-3">
                    <h3 className="text-base text-foreground">{t("config.ti.waysTitle")}</h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {WAYS.map((w) => {
                            const chosen = w.id === choice;
                            return (
                                <div key={w.id} className={cn("flex min-w-0 flex-col gap-2 rounded-xl border p-3", chosen ? "border-primary/50 bg-primary/[0.04]" : "border-border")}>
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <span className="text-foreground">{t(w.title)}</span>
                                        {chosen ? (
                                            <Chip tone="success"><Check />{t("config.ti.chosen")}</Chip>
                                        ) : (
                                            onChoose && <Button type="button" size="sm" variant="outline" onClick={() => onChoose(w.id)}>{t("config.ti.useThis")}</Button>
                                        )}
                                    </div>
                                    <p>{code(`ssh → ${laptopAddress(w.id, server, wsUrl)}`)}</p>
                                    <p className="text-foreground/85">{t(w.what)}</p>
                                    <p className="text-muted-foreground">{t(w.when)}</p>
                                    <p className="text-xs text-muted-foreground">{w.id !== "ssh" ? tn(w.needs, { path: code("~/.ssh/telepy-ws.py") }) : t(w.needs)}</p>
                                </div>
                            );
                        })}
                    </div>
                    {!https && <Callout tone="warning">{t("wizard.seen.http")}</Callout>}
                </section>

                <section className="space-y-3">
                    <h3 className="text-base text-foreground">{t("config.ti.compareTitle")}</h3>
                    {/* 窄的時候每列的標題獨佔一行、兩欄並排在下面；夠寬才是三欄表格（同 TransportVisibility）。
                        Narrow: each row's label on its own line, the two columns below; a three-column table when wide. */}
                    <div className="@container">
                        <table role="table" className="block w-full border-collapse text-xs leading-relaxed @md:table">
                            <thead role="rowgroup" className="block @md:table-header-group">
                                <tr role="row" className="grid grid-cols-2 @md:table-row">
                                    <td className="hidden w-[22%] @md:table-cell" />
                                    <th role="columnheader" scope="col" className="bg-primary/[0.06] px-2 py-1.5 text-left align-bottom font-normal text-foreground">① {t("config.ti.colMine")}</th>
                                    <th role="columnheader" scope="col" className="px-2 py-1.5 text-left align-bottom font-normal text-muted-foreground">② {t("config.ti.colDevice")}</th>
                                </tr>
                            </thead>
                            <tbody role="rowgroup" className="block @md:table-row-group">
                                {COMPARE_ROWS.map((row) => (
                                    <tr key={row.label} role="row" className="grid grid-cols-2 border-t border-border @md:table-row">
                                        <th role="rowheader" scope="row" className="col-span-2 pt-2 pr-2 text-left align-top font-normal text-muted-foreground @md:py-2">{t(row.label)}</th>
                                        <td role="cell" className="bg-primary/[0.06] px-2 py-2 align-top text-foreground/85">{t(row.mine)}</td>
                                        <td role="cell" className="px-2 py-2 align-top text-foreground/85">{t(row.device)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-muted-foreground">{t("config.ti.independent")}</p>
                </section>
            </div>
        </Modal>
    );
}
