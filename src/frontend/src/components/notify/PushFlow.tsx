"use client";

/**
 * 推播的說明圖：Telepy ─ 為這台裝置加密 ─ 推播服務（Google / Apple / Mozilla / Microsoft，看不到內容）─ 這台裝置 ─ 通知。
 * 各段照這台裝置最近一次送出亮起或斷掉（`lib/push.pushSpots`），下面列推播服務看得到 / 看不到什麼、什麼時候會停。
 * The push diagram: Telepy ─ encrypted for this device ─ the push service (Google / Apple / Mozilla / Microsoft, can't
 * read it) ─ this device ─ the notification. Each part lights or breaks by this device's last delivery
 * (`lib/push.pushSpots`); below, what the push service can and cannot see, and when pushes stop.
 */
import React from "react";
import { BellRing, Clock, CloudCog, PlugZap, Smartphone, Unplug } from "lucide-react";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { lastDelivery, pushSpots, type PushDevice, type PushStatus } from "@/lib/push";

/** 等待時間的字：馬上 / N 分鐘 / N 小時。/ A wait as words: right away / N minutes / N hours. */
export function useWaitLabel() {
    const { t } = useI18n();
    return (secs: number) => (secs <= 0 ? t("push.wait.now") : secs % 3600 === 0 ? t("push.wait.hours", { n: secs / 3600 }) : t("push.wait.minutes", { n: Math.round(secs / 60) }));
}

export function PushFlowDialog({ isOpen, onClose, device, on, status }: { isOpen: boolean; onClose: () => void; device: PushDevice | null; on: boolean; status?: PushStatus }) {
    const { t } = useI18n();
    const waitLabel = useWaitLabel();
    const last = device ? lastDelivery(device) : "none";
    const spots = pushSpots(on, last);
    const service = device?.service ? t(`push.service.${device.service}`) : t("push.flow.serviceAny");
    const now = !on ? "off" : last === "ok" ? "ok" : last === "failed" ? "failed" : "none";

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("push.flow.title")} description={t("push.flow.description")} icon={<BellRing />} size="5xl">
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode brand title="Telepy" sub={t("push.flow.telepySub")} state={spots.telepy} stateText={t(spots.telepy === "ok" ? "push.flow.ready" : "push.flow.idle")} />
                    <FlowLink compact label={t("push.flow.encrypted")} state={spots.telepy} />
                    <FlowNode icon={CloudCog} title={service} sub={t("push.flow.serviceSub")} state={spots.service} stateText={t(spots.service === "ok" ? "push.flow.carried" : spots.service === "failed" ? "push.flow.refused" : "push.flow.idle")} />
                    <FlowLink compact label={t("push.flow.delivers")} state={spots.service === "failed" ? "waiting" : spots.service} />
                    <FlowNode icon={Smartphone} title={t("push.flow.device")} sub={t("push.flow.deviceSub")} state={spots.device} stateText={t(spots.device === "ok" ? "push.flow.shown" : "push.flow.idle")} />
                </FlowPath>
                <FlowNow failed={now === "failed"}>{now === "failed" ? t("push.flow.now.failed", { error: device?.last_error ?? "" }) : t(`push.flow.now.${now}`)}</FlowNow>

                {/* 上線 / 離線：斷線 ─ 等這個人選的時間 ─ 還沒回來才推 ─ 回來推「恢復」。/ Status: down ─ the person's wait ─ still down → push ─ back → push. */}
                {status && (
                    <Section title={t("push.flow.statusTitle")} description={t("push.flow.statusDescription", { wait: waitLabel(status.effective), perHour: status.per_hour })}>
                        <FlowPath>
                            <FlowNode icon={Unplug} title={t("push.flow.drops")} state={on ? "ok" : "waiting"} stateText="0:00" />
                            <FlowLink compact label={t("push.flow.waits", { wait: waitLabel(status.effective) })} state={on ? "ok" : "waiting"} />
                            <FlowNode icon={Clock} title={t("push.flow.stillDown")} state={on ? "ok" : "waiting"} stateText={`+${waitLabel(status.effective)}`} />
                            <FlowLink compact label={t("push.flow.pushes")} state={on ? "ok" : "waiting"} />
                            <FlowNode icon={BellRing} title={t("push.flow.offlinePush")} state={on ? "ok" : "waiting"} stateText={t("push.flow.sent")} />
                            <FlowLink compact label={t("push.flow.later")} state={on ? "ok" : "waiting"} />
                            <FlowNode icon={PlugZap} title={t("push.flow.onlinePush")} state={on ? "ok" : "waiting"} stateText={t("push.flow.sent")} />
                        </FlowPath>
                    </Section>
                )}

                <div className="grid gap-5 md:grid-cols-2">
                    <Section title={t("push.flow.seesTitle")}>
                        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                            <li>{t("push.flow.sees1")}</li>
                            <li>{t("push.flow.sees2")}</li>
                        </ul>
                    </Section>
                    <Section title={t("push.flow.stopsTitle")}>
                        <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
                            <li>{t("push.flow.stops1")}</li>
                            <li>{t("push.flow.stops2")}</li>
                            <li>{t("push.flow.stops3")}</li>
                        </ul>
                    </Section>
                </div>
            </div>
        </Modal>
    );
}
