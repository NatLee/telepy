"use client";

/**
 * 推播的說明圖：Telepy ─ 為這台裝置加密 ─ 推播服務（Google / Apple / Mozilla / Microsoft，看不到內容）─ 這台裝置 ─ 通知。
 * 各段照這台裝置最近一次送出亮起或斷掉（`lib/push.pushSpots`），下面列推播服務看得到 / 看不到什麼、什麼時候會停。
 * The push diagram: Telepy ─ encrypted for this device ─ the push service (Google / Apple / Mozilla / Microsoft, can't
 * read it) ─ this device ─ the notification. Each part lights or breaks by this device's last delivery
 * (`lib/push.pushSpots`); below, what the push service can and cannot see, and when pushes stop.
 */
import React from "react";
import { BellRing, CloudCog, Smartphone } from "lucide-react";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { Modal } from "@/components/ui/Modal";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { lastDelivery, pushSpots, type PushDevice } from "@/lib/push";

export function PushFlowDialog({ isOpen, onClose, device, on }: { isOpen: boolean; onClose: () => void; device: PushDevice | null; on: boolean }) {
    const { t } = useI18n();
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
