"use client";

/**
 * 主機面板的「注意這台」與「現在檢查」：鈴鐺開關（掃描發現它不見、回來或 port 變了就告訴你）、一行「最後看到 / 最後檢查」
 * 加「現在檢查」（它的 port、不掃整個網段），以及「提醒怎麼來」的路徑圖：掃描（手動 · 定時 · 檢查）─ 跟 Telepy 知道的比 ─
 * 兩種提醒各自給誰 ─ 你收到的方式（照你的通知偏好）。圖照這條隧道的排程、你的權限、你有沒有在注意這台點亮。
 * The host panel's "watch this machine" and "check now": a bell toggle (told when a scan finds it gone, back or with
 * other ports), a "last seen / last checked" line with "Check now" (its ports, no network sweep), and the "how alerts
 * reach you" path: scan (manual · scheduled · check) ─ compared with what Telepy knew ─ who each alert goes to ─ how you
 * hear it (your notification preferences). Lit from this tunnel's schedule, your permission and whether you watch it.
 */
import React, { useState } from "react";
import { ArrowLeftRight, Bell, BellOff, BellRing, Info, Loader2, Radar, RefreshCw, User } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Switch } from "@/components/ui/switch";
import { FlowLink, FlowNode, FlowPath, StateLine } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import { scanRunning } from "@/lib/lanConnect";
import { everyKey } from "@/lib/lanSchedule";
import { isOwn } from "@/lib/lanChanges";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/** 標題列的鈴鐺。/ The bell in the panel header. */
export function WatchButton({ host, onWatch }: { host: LanHost; onWatch: (h: LanHost, on: boolean) => Promise<boolean> }) {
    const { t } = useI18n();
    const [busy, setBusy] = useState(false);
    if (isOwn(host)) return null;
    const on = !!host.watched;
    const label = on ? t("network.watch.stop") : t("network.watch.start");
    return (
        <Button
            variant={on ? "secondary" : "ghost"}
            size="sm"
            className="h-8 shrink-0 gap-1.5 px-2"
            aria-pressed={on}
            title={label}
            disabled={busy}
            onClick={async () => {
                setBusy(true);
                await onWatch(host, !on);
                setBusy(false);
            }}
        >
            {busy ? <Loader2 size={15} className="animate-spin" /> : on ? <BellRing size={15} className="text-primary" /> : <Bell size={15} />}
            <span className="hidden @md:inline">{on ? t("network.watch.watching") : t("network.watch.watch")}</span>
        </Button>
    );
}

/** 這台能不能「現在檢查」（不行的原因）。/ Whether "check now" works for this host, else why not. */
function checkBlock(host: LanHost, tunnel: TopologyTunnel, online: boolean): TranslationKey | null {
    if (!tunnel.can_scan) return "network.check.managersOnly";
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(host.address)) return "network.checkAddress";
    if (!online) return "network.deviceOffline";
    return null;
}

/** 「最後看到 / 最後檢查」+「現在檢查」。/ "Last seen / last checked" plus "Check now". */
export function CheckRow({ host, tunnel, online, onCheck, onInfo }: { host: LanHost; tunnel: TopologyTunnel; online: boolean; onCheck: (h: LanHost) => Promise<string | null>; onInfo: () => void }) {
    const { t, locale } = useI18n();
    const now = useNow(30_000);
    const [error, setError] = useState<string | null>(null);
    if (isOwn(host)) return null;
    const checking = scanRunning(tunnel.scan) && tunnel.scan?.trigger === "check" && tunnel.scan.host_id === host.id;
    const otherScan = scanRunning(tunnel.scan) && !checking;
    const block = checkBlock(host, tunnel, online);
    const when = (iso: string | null | undefined) => (iso ? formatRelativeTime(iso, locale, now) : t("network.check.never"));
    return (
        <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="min-w-0 text-xs text-muted-foreground">
                    {t("network.check.seen", { when: when(host.last_seen) })}
                    {host.checked_at && host.checked_at !== host.last_seen && ` · ${t("network.check.checked", { when: when(host.checked_at) })}`}
                </p>
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-8 px-2" onClick={onInfo} title={t("network.alerts.how")} aria-label={t("network.alerts.how")}>
                        <Info size={15} />
                    </Button>
                    <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        disabled={!!block || checking || otherScan}
                        title={block ? t(block) : otherScan ? t("network.scanError.running") : t("network.check.hint")}
                        onClick={async () => {
                            setError(null);
                            setError(await onCheck(host));
                        }}
                    >
                        {checking ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />} {checking ? t("network.check.running") : t("network.check.now")}
                    </Button>
                </div>
            </div>
            {error && <Callout tone="danger">{error}</Callout>}
        </div>
    );
}

/**
 * 「提醒怎麼來」：掃描 ─ 比較 ─ 提醒 ─ 你，下面兩條線（新機器給 owner / Admin、注意的主機給注意它的人），各自說你在不在裡面，
 * 鈴鐺可以直接在這裡切。
 * "How alerts reach you": scan ─ compare ─ alert ─ you, then two lanes (new machines → owner / Admins, a watched host →
 * whoever watches it), each saying whether you're in it; the bell can be switched right here.
 */
export function LanAlertsInfoDialog({ isOpen, onClose, host, tunnel, onWatch }: { isOpen: boolean; onClose: () => void; host: LanHost; tunnel: TopologyTunnel; onWatch: (h: LanHost, on: boolean) => Promise<boolean> }) {
    const { t, locale } = useI18n();
    const now = useNow(30_000);
    if (!isOpen) return null;
    const s = tunnel.schedule ?? null;
    const key = s ? everyKey(s.every_secs) : null;
    const every = key ? t(`network.schedule.every.${key}` as TranslationKey) : null;
    const manager = tunnel.permission === "owner" || tunnel.permission === "admin";
    const watched = !!host.watched;
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            icon={<Bell size={18} />}
            title={t("network.alerts.title")}
            description={t("network.alerts.desc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode
                        icon={Radar}
                        title={t("network.alerts.scan")}
                        sub={s && every ? t("network.alerts.scanScheduled", { every, next: formatRelativeTime(s.next_at, locale, now) }) : t("network.alerts.scanManual")}
                        state={s ? "ok" : "waiting"}
                        stateText={s ? t("network.alerts.scheduleOn") : t("network.alerts.scheduleOff")}
                    />
                    <FlowLink label={t("network.alerts.compare")} state="ok" />
                    <FlowNode icon={ArrowLeftRight} title={t("network.alerts.compared")} sub={t("network.alerts.comparedSub")} state="ok" stateText={t("network.alerts.everyScan")} />
                    <FlowLink label={t("network.alerts.alert")} state={manager || watched ? "ok" : "waiting"} />
                    <FlowNode icon={User} title={t("network.alerts.you")} sub={t("network.alerts.youSub")} state={manager || watched ? "ok" : "waiting"} stateText={manager || watched ? t("network.alerts.youGet") : t("network.alerts.youNone")} />
                </FlowPath>

                <ul className="divide-y divide-border rounded-lg border border-border">
                    <li className="flex items-start gap-3 px-3 py-2.5">
                        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden><Radar size={16} /></span>
                        <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <span className="text-sm text-foreground">{t("network.alerts.newLane")}</span>
                                <StateLine state={manager ? "ok" : "waiting"} text={manager ? t("network.alerts.newYou") : t("network.alerts.newNotYou")} />
                            </span>
                            <span className="block text-xs leading-relaxed text-muted-foreground">{t("network.alerts.newHow")}</span>
                        </span>
                    </li>
                    <li className="flex items-start gap-3 px-3 py-2.5">
                        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-foreground" aria-hidden>{watched ? <BellRing size={16} /> : <BellOff size={16} />}</span>
                        <span className="min-w-0 flex-1">
                            <span className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <span className="text-sm text-foreground">{t("network.alerts.watchLane", { host: host.label || host.hostname || host.address })}</span>
                                <Switch size="sm" checked={watched} onCheckedChange={(on) => void onWatch(host, on)}>{watched ? t("network.watch.watching") : t("network.watch.watch")}</Switch>
                            </span>
                            <span className="block text-xs leading-relaxed text-muted-foreground">{t("network.alerts.watchHow")}</span>
                        </span>
                    </li>
                </ul>
                <Callout tone="info">{t("network.alerts.channels")}</Callout>
            </div>
        </Modal>
    );
}
