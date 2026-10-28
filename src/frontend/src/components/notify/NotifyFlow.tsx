"use client";

/**
 * 「怎麼運作」：一個事件經過哪幾層才決定要不要提示 —— 事件（誰會收到）─ 網站預設（強制 / 開 / 關）─ 我的預設 ─
 * 這條隧道 ─ 結果。選事件、管道、隧道，各層照目前的真實設定亮起來，決定的那一層標「由這層決定」，其他層標「被蓋過」/
 * 「跟隨預設」/「略過（強制）」。狀態全部來自純函式 `notifyFlow`。管理員頁的版本，後兩層是「每個人的」。
 * "How it works": the layers an event passes before it shows — event (who receives it) ─ site default (enforced /
 * on / off) ─ my default ─ this tunnel ─ the result. Pick an event, channel and tunnel; each layer lights up from
 * the real settings and the deciding one is marked. State comes from the pure `notifyFlow`. On the admin page the
 * later two layers are "each person's".
 */
import React, { useMemo, useState } from "react";
import { Bell, BellRing, BellOff, Globe, Info, Lock, Network, User } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { Callout } from "@/components/ui/callout";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { AUDIENCE_KEY, EVENT_KEYS, GROUP_KEY, GROUP_ORDER } from "@/lib/webhooks";
import { groupEvents, notifyFlow, type FlowLayer, type MuteScope, type NotifyChannel, type NotifyEvent, type NotifyMute } from "@/lib/notifyPrefs";
import type { TranslationKey } from "@/locales/en";

const ROLE_KEY: Record<FlowLayer["role"], TranslationKey> = {
    decides: "notifyPrefs.flow.role.decides",
    overridden: "notifyPrefs.flow.role.overridden",
    unset: "notifyPrefs.flow.role.unset",
    skipped: "notifyPrefs.flow.role.skipped",
};

const SUMMARY_KEY: Record<string, TranslationKey> = {
    builtin: "notifyPrefs.flow.sum.builtin",
    site: "notifyPrefs.flow.sum.site",
    mine: "notifyPrefs.flow.sum.mine",
    locked: "notifyPrefs.flow.sum.locked",
    muted: "notifyPrefs.flow.sum.muted",
};

export function NotifyFlowDialog({ isOpen, onClose, events, mutes = [], admin = false, initialEvent }: {
    isOpen: boolean;
    onClose: () => void;
    events: NotifyEvent[];
    mutes?: NotifyMute[];
    /** 管理員頁：後兩層是每個人的。/ The admin page: the later layers belong to each person. */
    admin?: boolean;
    initialEvent?: string;
}) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("notifyPrefs.flow.title")}
            description={t("notifyPrefs.flow.description")}
            icon={<Info />}
            size="5xl"
            footer={<Button type="button" onClick={onClose}>{t("common.close")}</Button>}
        >
            {isOpen && <NotifyFlow events={events} mutes={mutes} admin={admin} initialEvent={initialEvent} />}
        </Modal>
    );
}

export function NotifyFlow({ events, mutes, admin, initialEvent }: { events: NotifyEvent[]; mutes: NotifyMute[]; admin: boolean; initialEvent?: string }) {
    const { t } = useI18n();
    const [event, setEvent] = useState(() => initialEvent ?? events.find((e) => e.event === "tunnel.host_key_changed")?.event ?? events[0]?.event ?? "");
    const ev = events.find((e) => e.event === event) ?? events[0];
    const [chosenChannel, setChannel] = useState<NotifyChannel>("toast");
    // 這個事件沒有選到的管道就換成它有的。/ Fall back to a channel the event has.
    const channel: NotifyChannel = ev && !ev.channels.includes(chosenChannel) ? ev.channels[0] : chosenChannel;
    // 隧道：沒靜音的、我真的靜音的，或兩個範例。/ Tunnel: an unmuted one, my real mutes, or two examples.
    const [tunnel, setTunnel] = useState("");
    const mute: MuteScope | null = useMemo(() => {
        if (tunnel === "ex:all") return "all";
        if (tunnel === "ex:status") return "status";
        if (tunnel.startsWith("m:")) return mutes.find((m) => `m:${m.tunnel_id}` === tunnel)?.scope ?? null;
        return null;
    }, [tunnel, mutes]);
    if (!ev) return null;

    const f = notifyFlow(ev, channel, mute);
    const label = (e: NotifyEvent) => (EVENT_KEYS[e.event] ? t(EVENT_KEYS[e.event].label) : e.event);
    const channelLabel = t(channel === "toast" ? "notifyPrefs.channel.toast" : "notifyPrefs.channel.desktop");
    const value = (v: FlowLayer["value"]) =>
        v === "on" ? t("notifyPrefs.flow.v.on") : v === "off" ? t("notifyPrefs.flow.v.off") : v === "muted" ? t("notifyPrefs.flow.v.muted") : v === "locked" ? t("notifyPrefs.chip.locked") : t("notifyPrefs.flow.v.unset");
    // 每層：值放在 sub，角色（由這層決定 / 被蓋過 / 跟隨預設 / 略過）放在狀態列。
    // Each layer: its value in `sub`, its role (decides / overridden / follows default / skipped) in the state line.
    const roleText = (l: FlowLayer, overrides = false) => (l.role === "decides" && overrides ? t("notifyPrefs.chip.overrides") : t(ROLE_KEY[l.role]));
    const layerState = (l: FlowLayer) => (l.role === "decides" ? "ok" : "waiting") as "ok" | "waiting";
    const linkState = f.result.on ? "ok" : "waiting";
    const short = "@3xl:w-8";

    return (
        <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
                <Field label={t("notifyPrefs.flow.event")}>
                    <NativeSelect value={ev.event} onChange={(e) => setEvent(e.target.value)}>
                        {groupEvents(events, GROUP_ORDER).map((g) => (
                            <optgroup key={g.group} label={t(GROUP_KEY[g.group])}>
                                {g.events.map((e) => <option key={e.event} value={e.event}>{label(e)}</option>)}
                            </optgroup>
                        ))}
                    </NativeSelect>
                </Field>
                <Field label={t("notifyPrefs.flow.channel")}>
                    <Segmented
                        fullWidth
                        size="sm"
                        options={ev.channels.map((c) => ({ value: c, label: t(c === "toast" ? "notifyPrefs.channel.toast" : "notifyPrefs.channel.desktop") }))}
                        value={channel}
                        onChange={setChannel}
                        aria-label={t("notifyPrefs.flow.channel")}
                    />
                </Field>
                <Field label={t("notifyPrefs.flow.tunnel")}>
                    <NativeSelect value={tunnel} onChange={(e) => setTunnel(e.target.value)} disabled={!ev.tunnel}>
                        <option value="">{t("notifyPrefs.flow.anyTunnel")}</option>
                        {mutes.map((m) => (
                            <option key={m.tunnel_id} value={`m:${m.tunnel_id}`}>
                                {m.tunnel_name} · {t(m.scope === "all" ? "notifyPrefs.muteAll" : "notifyPrefs.muteStatus")}
                            </option>
                        ))}
                        <option value="ex:status">{t("notifyPrefs.flow.exampleStatus")}</option>
                        <option value="ex:all">{t("notifyPrefs.flow.exampleAll")}</option>
                    </NativeSelect>
                </Field>
            </div>

            <FlowPath stretch>
                <FlowNode
                    icon={Bell}
                    title={label(ev)}
                    sub={<>{t("notifyPrefs.flow.receivers")}: {t(AUDIENCE_KEY[ev.audience])}</>}
                    state="ok"
                    stateText={channelLabel}
                />
                <FlowLink label="" state={linkState} className={short} />
                <FlowNode
                    icon={Globe}
                    title={t("notifyPrefs.flow.site")}
                    sub={
                        <span className="flex flex-col items-center gap-1">
                            {f.site.value === "locked" ? (
                                <Chip><Lock /> {t("notifyPrefs.chip.locked")}</Chip>
                            ) : (
                                <span className="text-foreground">{f.site.value === null ? t("notifyPrefs.flow.v.builtin") : value(f.site.value)}</span>
                            )}
                            <span>{ev.locked ? t("notifyPrefs.flow.v.cannot") : t("notifyPrefs.flow.v.mayChange")}</span>
                        </span>
                    }
                    state={layerState(f.site)}
                    stateText={roleText(f.site)}
                />
                <FlowLink label="" state={linkState} className={short} />
                <FlowNode
                    icon={User}
                    title={t(admin ? "notifyPrefs.flow.mineAdmin" : "notifyPrefs.flow.mine")}
                    sub={admin ? undefined : <span className={f.mine.value ? "text-foreground" : undefined}>{value(f.mine.value)}</span>}
                    state={layerState(f.mine)}
                    stateText={roleText(f.mine, true)}
                />
                <FlowLink label="" state={linkState} className={short} />
                <FlowNode
                    icon={Network}
                    title={t(admin ? "notifyPrefs.flow.thisTunnelAdmin" : "notifyPrefs.flow.thisTunnel")}
                    sub={<span className={f.tunnel.value === "muted" ? "text-foreground" : undefined}>{ev.tunnel ? (f.tunnel.value === "muted" ? t("notifyPrefs.flow.v.muted") : t("notifyPrefs.flow.v.notMuted")) : "—"}</span>}
                    state={layerState(f.tunnel)}
                    stateText={roleText(f.tunnel)}
                />
                <FlowLink label="" state={linkState} className={short} />
                <FlowNode
                    icon={f.result.on ? BellRing : BellOff}
                    title={f.result.on ? t("notifyPrefs.flow.shown") : t("notifyPrefs.flow.hidden")}
                    sub={channelLabel}
                    state={f.result.on ? "ok" : "waiting"}
                    stateText={f.result.on ? t("notifyPrefs.flow.v.on") : t("notifyPrefs.flow.v.off")}
                />
            </FlowPath>

            <p className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground" role="status">
                {t(SUMMARY_KEY[f.result.source])}
            </p>
            {channel === "desktop" && <Callout tone="info">{t("notifyPrefs.flow.desktopNote")}</Callout>}
            {admin && <p className="text-xs text-muted-foreground">{t("notifyPrefs.flow.adminNote")}</p>}
        </div>
    );
}
