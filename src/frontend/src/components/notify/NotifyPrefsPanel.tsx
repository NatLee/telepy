"use client";

/**
 * 偏好設定的「通知」分頁：這個瀏覽器的桌面通知開關、每個事件 × 管道的矩陣（我的預設，蓋在網站預設上）、靜音的隧道。
 * 資訊按鈕打開「怎麼運作」圖。
 * The Preferences "Notifications" tab: this browser's desktop switch, the event × channel matrix (my defaults over
 * the site defaults) and the muted tunnels. The info button opens the "How it works" diagram.
 */
import React, { useState } from "react";
import { Bell, BellOff, BellRing, Info, VolumeX } from "lucide-react";
import { Section, Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/Toast";
import { useDesktopNotifyPref } from "@/hooks/useDesktopNotifications";
import { useNotifyPrefs } from "@/hooks/useNotifyPrefs";
import { useI18n } from "@/lib/i18n";
import type { NotifyChannel, NotifyEvent } from "@/lib/notifyPrefs";
import { NotifyMatrix } from "./NotifyMatrix";
import { NotifyFlowDialog } from "./NotifyFlow";

export function NotifyPrefsPanel() {
    const { t } = useI18n();
    const { showError } = useToast();
    const { prefs, setMine, setMute } = useNotifyPrefs();
    const [desktopNotify, setDesktopNotify] = useDesktopNotifyPref();
    const [problem, setProblem] = useState<"denied" | "unsupported" | null>(null);
    const [flowOpen, setFlowOpen] = useState(false);

    const changeDesktop = async (value: "on" | "off") => {
        const r = await setDesktopNotify(value === "on");
        setProblem(r === "denied" || r === "unsupported" ? r : null);
    };
    const fail = (e: unknown) => {
        const code = (e as { code?: string })?.code;
        showError(code === "locked" ? t("notifyPrefs.lockedError") : t("notifyPrefs.saveFailed", { error: e instanceof Error ? e.message : "" }));
    };
    const change = (ev: NotifyEvent, channel: NotifyChannel, value: boolean | null) => {
        setMine([{ event: ev.event, channel, value }]).catch(fail);
    };
    const reset = (ev: NotifyEvent) => {
        setMine(ev.channels.map((channel) => ({ event: ev.event, channel, value: null }))).catch(fail);
    };

    return (
        <div className="space-y-6">
            {/* 桌面通知（每台瀏覽器）/ Desktop notifications (per browser) */}
            <Section icon={<Bell />} title={t("prefs.desktopNotify")} description={t("prefs.desktopNotifyDescription")}>
                <Segmented
                    fullWidth
                    options={[
                        { value: "off" as const, label: t("prefs.desktopNotifyOff"), icon: <BellOff size={15} /> },
                        { value: "on" as const, label: t("prefs.desktopNotifyOn"), icon: <Bell size={15} /> },
                    ]}
                    value={desktopNotify ? "on" : "off"}
                    onChange={(v) => void changeDesktop(v)}
                    aria-label={t("prefs.desktopNotify")}
                />
                {problem === "unsupported" && <Callout tone="warning">{t("prefs.desktopNotifyUnsupported")}</Callout>}
                {problem === "denied" && <Callout tone="warning">{t("prefs.desktopNotifyDenied")}</Callout>}
            </Section>

            <Section
                icon={<BellRing />}
                title={t("notifyPrefs.matrixTitle")}
                description={t("notifyPrefs.matrixDescription")}
                action={
                    <Button type="button" size="sm" variant="outline" onClick={() => setFlowOpen(true)} disabled={!prefs}>
                        <Info size={14} /> {t("notifyPrefs.howItWorks")}
                    </Button>
                }
            >
                {!desktopNotify && <Callout tone="info">{t("notifyPrefs.desktopOffNote")}</Callout>}
                {prefs ? (
                    <NotifyMatrix mode="mine" events={prefs.events} onChange={change} onReset={reset} />
                ) : (
                    <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
                )}
            </Section>

            <Section icon={<VolumeX />} title={t("notifyPrefs.mutesTitle")} description={t("notifyPrefs.mutesDescription")}>
                {prefs && prefs.mutes.length === 0 && <p className="text-sm text-muted-foreground">{t("notifyPrefs.mutesEmpty")}</p>}
                {prefs && prefs.mutes.length > 0 && (
                    <ul className="divide-y divide-border rounded-xl border border-border">
                        {prefs.mutes.map((m) => (
                            <li key={m.tunnel_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.tunnel_name}</span>
                                <Chip>{t(m.scope === "all" ? "notifyPrefs.muteAll" : "notifyPrefs.muteStatus")}</Chip>
                                <Button type="button" size="sm" variant="ghost" onClick={() => setMute(m.tunnel_id, m.tunnel_name, null).catch(fail)}>
                                    {t("notifyPrefs.unmute")}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            {prefs && <NotifyFlowDialog isOpen={flowOpen} onClose={() => setFlowOpen(false)} events={prefs.events} mutes={prefs.mutes} />}
        </div>
    );
}
