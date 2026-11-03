"use client";

/**
 * 通道詳細資訊的「連線方式」分頁：上半是這台裝置怎麼連 Telepy——現在的狀況一句話、兩條路的圖（照實際連線點亮：自動卻
 * 走網頁 port = SSH port 那條畫成被擋）、擁有者 / Admin 可以直接在這裡選三種方式之一再按「改成…」（開切換對話框跑
 * 先接上再拆舊的）；下半是「裝置上的安裝」。以前這些藏在「裝置」分頁的最下面，一般人找不到。
 * The tunnel details' "How it connects" tab: how the device reaches Telepy — one status line, the two-lane diagram lit
 * by the live connection (automatic on the web port = the SSH lane drawn blocked), and for owners / Admins the three
 * ways right here with a "Switch to …" button (the switch dialog runs make-before-break); below it "On the device".
 * These used to sit at the bottom of the Device tab, where people did not find them.
 */
import React, { useState } from "react";
import { Info, Loader2, RefreshCw, Route } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Section } from "@/components/ui/section";
import { DeviceInstallSection, SwitchDialog } from "@/components/tunnels/DeviceInstall";
import { WayChoiceCards, WayInInfoDialog, WayInLanes } from "@/components/tunnels/WayIn";
import { useHttps } from "@/components/tunnels/TransportVisibility";
import { useDeviceInstall } from "@/hooks/useDeviceInstall";
import { WAY_IN_KEY, canSwitch, type WayInSetup } from "@/lib/deviceInstall";
import { liveTransport, wayInOf } from "@/lib/devicePlatforms";
import { isReinstall, switchBlockKey, wayPicture } from "@/lib/wayIn";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { Tunnel } from "@/types/tunnel";

const VIA_LABEL: Record<"ssh" | "wss" | "ws", TranslationKey> = { ssh: "platforms.via.ssh", wss: "platforms.via.wss", ws: "platforms.via.ws" };

interface Props {
    tunnel: Pick<Tunnel, "id" | "host_friendly_name" | "way_in" | "endpoint">;
    /** 這一頁正在看（打開時才讀裝置上的安裝）。/ This tab is showing (the install view is read only then). */
    active: boolean;
    /** 擁有者或 Admin：能換、看得到裝置上的安裝。/ Owner or Admin: may switch and sees the install section. */
    manager: boolean;
    onChanged?: () => void;
}

export function ConnectionTab({ tunnel, active, manager, onChanged }: Props) {
    const { t } = useI18n();
    const https = useHttps();
    // 上半的換方式與下半的「裝置上的安裝」共用一份資料，裝置只盤點一次。/ One view for both halves; one survey.
    const d = useDeviceInstall(manager ? tunnel.id : null, active, manager, onChanged);
    const [choice, setChoice] = useState<WayInSetup | null>(null);
    const [switchOpen, setSwitchOpen] = useState(false);
    const [compareOpen, setCompareOpen] = useState(false);

    const setup = tunnel.way_in?.setup ?? null;
    const seen = wayInOf(tunnel, https);
    const picture = wayPicture(setup, seen);
    const via = seen ? t(VIA_LABEL[seen.via]) : "";
    const v = d.view;
    const current = v?.switch?.way_in ?? setup;
    const switchable = !!v && canSwitch(v);
    const busy = d.renaming || d.surveying;
    const openSwitch = (w: WayInSetup) => {
        setChoice(w);
        setSwitchOpen(true);
    };

    return (
        <div className="space-y-6">
            <Section
                icon={<Route />}
                title={t("wayIn.tab.title")}
                wrapTitle
                description={t("wayIn.tab.description")}
                action={
                    // 手機上只留圖示，標題和說明才不會被擠成一條窄欄。/ Icon only on phones, so the title keeps its width.
                    <Button type="button" size="sm" variant="ghost" onClick={() => setCompareOpen(true)} title={t("wayIn.compareButton")} aria-label={t("wayIn.compareButton")}>
                        <Info size={14} /> <span className="hidden sm:inline">{t("wayIn.compareButton")}</span>
                    </Button>
                }
            >
                {/* 兩行「標籤 值」，窄的時候自然換行（固定兩欄在手機放大時會把值切成半個字）。
                    Two "label value" lines that wrap when narrow (fixed columns cut the value mid-word on a zoomed phone). */}
                <dl className="space-y-1.5 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        <dt className="text-muted-foreground">{t("wayIn.tab.setup")}</dt>
                        <dd className="text-foreground">{setup ? t(WAY_IN_KEY[setup]) : t("deviceInstall.switch.wayUnknown")}</dd>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5">
                        <dt className="text-muted-foreground">{t("wayIn.tab.now")}</dt>
                        <dd className={cn("min-w-0", picture?.status === "wayIn.now.liveFallback" ? "text-warning" : picture?.status === "wayIn.now.offline" ? "text-muted-foreground" : "text-foreground")}>
                            {t(picture?.status ?? "wayIn.now.never", { via })}
                        </dd>
                    </div>
                </dl>
                {picture?.differs && setup && <Callout tone="info">{t("wayIn.now.differs", { setup: t(WAY_IN_KEY[setup]), via })}</Callout>}
                {picture && <WayInLanes way={picture.way} blocked={picture.blocked} sshPort={v?.server_port} />}

                {/* 換：擁有者 / Admin 直接在這裡選。/ Switching: owners / Admins pick right here. */}
                {/* 卡片裡的下半段：細線拉到卡片兩邊，看得出「現在」和「改成」是兩件事。
                    The card's lower part: the hairline runs edge to edge, so "right now" and "change it" read as two things. */}
                {manager ? (
                    <div className="-mx-4 space-y-3 border-t border-border px-4 pt-4 sm:-mx-5 sm:px-5">
                        <div>
                            <p className="text-sm text-foreground">{t("wayIn.tab.change")}</p>
                            <p className="text-xs text-muted-foreground">{t("wayIn.tab.changeHint")}</p>
                        </div>
                        {!v ? (
                            d.error ? (
                                <Callout tone="danger">{d.error}</Callout>
                            ) : (
                                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                                    <Loader2 size={14} className="animate-spin" /> {t("common.loading")}
                                </p>
                            )
                        ) : switchable ? (
                            <>
                                <WayChoiceCards value={choice} current={current} onChange={setChoice} disabled={!v.online || busy} />
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                    <Button type="button" onClick={() => choice && openSwitch(choice)} disabled={!choice || !v.online || busy} className="h-auto min-h-9 max-w-full py-1.5 whitespace-normal">
                                        <Route size={15} />
                                        {choice ? t(isReinstall(choice, current) ? "deviceInstall.switch.reinstall" : "deviceInstall.switch.startTo", { way: t(WAY_IN_KEY[choice]) }) : t("deviceInstall.switch.pickFirst")}
                                    </Button>
                                    {!v.online && <span className="text-xs text-muted-foreground">{t("wayIn.tab.offline")}</span>}
                                </div>
                            </>
                        ) : (
                            <Callout tone="info">
                                <p>{t(switchBlockKey(v.switch?.blocker))}</p>
                                {(v.switch?.blocker === "not_surveyed" || v.switch?.blocker === "no_process") && (
                                    <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => void d.survey()} disabled={!v.online || busy}>
                                        {d.surveying ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t("deviceInstall.check")}
                                    </Button>
                                )}
                            </Callout>
                        )}
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">{t("wayIn.tab.managersOnly")}</p>
                )}
            </Section>

            {manager && <DeviceInstallSection d={d} tunnelId={tunnel.id} deviceName={tunnel.host_friendly_name} />}

            {v && (
                <SwitchDialog
                    isOpen={switchOpen}
                    onClose={() => {
                        setSwitchOpen(false);
                        d.resetRename();
                    }}
                    view={v}
                    live={liveTransport(tunnel)}
                    steps={d.steps}
                    running={d.renaming}
                    report={d.report}
                    choice={choice}
                    onChoose={setChoice}
                    onStart={(w) => void d.switchTransport(w)}
                    onCompare={() => setCompareOpen(true)}
                    deviceName={tunnel.host_friendly_name}
                />
            )}
            {compareOpen && (
                <WayInInfoDialog
                    isOpen
                    onClose={() => setCompareOpen(false)}
                    current={current}
                    sshPort={v?.server_port}
                    deviceName={tunnel.host_friendly_name}
                    onPick={
                        switchable && v?.online && !busy
                            ? (w) => {
                                  setCompareOpen(false);
                                  openSwitch(w);
                              }
                            : undefined
                    }
                />
            )}
        </div>
    );
}
