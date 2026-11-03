"use client";

/**
 * 「跟上次掃描比」的畫面：主機旁的安靜文字（閘道、新的、port 開關、沒看到）、主機面板最上面的提示、裝置卡的「上次掃描」
 * 一行（多久以前、網段、閘道、變化數量；點數量打開視窗），以及「變了什麼」視窗——前一次掃描 ─ 這一次 的路徑圖，下面三條
 * 線：新出現的、這次沒看到的、port 有變的，每台都能點開。
 * "Compared with the last scan": quiet text beside a host (gateway, new, ports opened / closed, not seen), the note at
 * the top of the host panel, the device card's "last scan" line (how long ago, networks, gateway, change counts; the
 * counts open the dialog), and the "what changed" dialog — previous scan ─ this one as a path, then three lanes: new,
 * not seen this time, ports changed, each host clickable.
 */
import React, { useState } from "react";
import { CalendarClock, EyeOff, ListPlus, Radar, Router, ArrowLeftRight, Bell, Repeat, StickyNote } from "lucide-react";
import { everyKey } from "@/lib/lanSchedule";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/relativeTime";
import { changeCounts, changeGroups, hostChange, isOwn, scanAge } from "@/lib/lanChanges";
import { hostName } from "@/lib/lanConnect";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { LanHost, TopologyTunnel } from "@/types/lan";

/** port 的 +/- 小字（開了 = 綠、關了 = 灰刪除線）。/ Ports opened (green) and closed (struck grey). */
export function PortDelta({ opened, closed, className }: { opened: number[]; closed: number[]; className?: string }) {
    const { t } = useI18n();
    if (opened.length === 0 && closed.length === 0) return null;
    return (
        <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 font-mono text-[0.6875rem]", className)}>
            {opened.map((p) => <span key={`o${p}`} className="text-success" title={t("network.change.opened", { port: p })}>+{p}</span>)}
            {closed.map((p) => <span key={`c${p}`} className="text-muted-foreground line-through" title={t("network.change.closed", { port: p })}>{p}</span>)}
        </span>
    );
}

/**
 * 主機旁的一段安靜文字：閘道、上次掃描新出現、port 開關、這次沒看到。都沒有就不畫。
 * Quiet text beside a host: gateway, new in the last scan, ports opened / closed, not seen this time.
 */
export function ChangeText({ host, className }: { host: LanHost; className?: string }) {
    const { t } = useI18n();
    const change = hostChange(host);
    const labels = host.labels ?? [];
    if (!host.gateway && !change && !host.watched && labels.length === 0 && !host.notes) return null;
    return (
        <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.6875rem]", className)}>
            {host.watched && <span className="inline-flex items-center gap-1 text-primary" title={t("network.watch.on")}><Bell size={11} aria-hidden />{t("network.watch.short")}</span>}
            {host.gateway && <span className="inline-flex items-center gap-1 text-foreground/75"><Router size={11} aria-hidden />{t("network.change.gateway")}</span>}
            {change === "new" && <span className="text-success">{t("network.change.new")}</span>}
            {change === "missing" && <span className="inline-flex items-center gap-1 text-warning"><EyeOff size={11} aria-hidden />{t("network.change.missing")}</span>}
            {host.since_last && change !== "missing" && <PortDelta opened={host.since_last.opened} closed={host.since_last.closed} />}
            {labels.map((l) => <span key={l} className="font-mono text-muted-foreground">#{l}</span>)}
            {host.notes && <span className="inline-flex items-center gap-1 text-muted-foreground" title={host.notes}><StickyNote size={11} aria-hidden />{t("network.noteTag")}</span>}
        </span>
    );
}

/** 主機面板最上面：這台在上次掃描怎麼了。/ The top of the host panel: what the last scan said about this host. */
export function HostChangeNote({ host }: { host: LanHost }) {
    const { t, locale } = useI18n();
    const change = hostChange(host);
    if (!change || isOwn(host)) return null;
    if (change === "missing") {
        return (
            <Callout tone="warning" title={t("network.change.missingTitle")}>
                {t("network.change.missingBody", { when: host.last_seen ? formatRelativeTime(host.last_seen, locale) : "—" })}
            </Callout>
        );
    }
    if (change === "new") return <Callout tone="info">{t("network.change.newBody")}</Callout>;
    return (
        <Callout tone="info">
            <span className="flex flex-wrap items-center gap-x-2">
                {t("network.change.portsBody")}
                <PortDelta opened={host.since_last?.opened ?? []} closed={host.since_last?.closed ?? []} className="text-xs" />
            </span>
        </Callout>
    );
}

/**
 * 裝置卡的「上次掃描」一行：多久以前（太久變警告色）、掃了哪些網段，以及變化數量（點了打開視窗）。沒掃過就不畫。
 * The device card's "last scan" line: how long ago (warning colour when old), which networks, and the change counts
 * (click to open the dialog). Nothing when never scanned.
 */
export function ScanLine({ tn, onOpenChanges }: { tn: TopologyTunnel; onOpenChanges: (tn: TopologyTunnel) => void }) {
    const { t, locale } = useI18n();
    // 每 30 秒更新「多久以前」。/ "How long ago" refreshes every 30 s.
    const now = useNow(30_000);
    const lan = tn.lan;
    const age = scanAge(lan?.scanned_at, now);
    if (!lan || !age) return null;
    const counts = changeCounts(lan.changes);
    return (
        <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            <p className={cn("flex flex-wrap items-center gap-x-1.5", age.stale && "text-warning")}>
                <CalendarClock size={12} className="shrink-0" aria-hidden />
                <span>{t("network.scanAge", { when: formatRelativeTime(lan.scanned_at!, locale, now) })}</span>
                {lan.networks.length > 0 && <span className="font-mono text-[0.6875rem] text-muted-foreground [overflow-wrap:anywhere]">{lan.networks.join(", ")}</span>}
                {age.stale && <span>· {t("network.scanStale")}</span>}
            </p>
            {counts && (
                <button type="button" onClick={() => onOpenChanges(tn)} className="flex flex-wrap items-center gap-x-2 rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" title={t("network.changes.open")}>
                    {counts.total === 0 ? (
                        <span>{t("network.changes.none")}</span>
                    ) : (
                        <>
                            {counts.new > 0 && <span className="text-success">{t("network.changes.newCount", { count: counts.new })}</span>}
                            {counts.gone > 0 && <span className="text-warning">{t("network.changes.goneCount", { count: counts.gone })}</span>}
                            {counts.changed > 0 && <span className="text-foreground/80">{t("network.changes.portsCount", { count: counts.changed })}</span>}
                        </>
                    )}
                    <span className="text-primary">{t("network.changes.see")}</span>
                </button>
            )}
        </div>
    );
}

/**
 * 裝置卡上「定時重掃」一行：每隔多久、下次什麼時候（上次失敗就變警告色）；能掃的人點了打開掃描視窗改它。
 * The device card's rescan line: how often and when next (warning colour after a failed run); managers click it to
 * open the scan dialog and change it.
 */
export function ScheduleLine({ tn, onOpen }: { tn: TopologyTunnel; onOpen?: () => void }) {
    const { t, locale } = useI18n();
    const now = useNow(30_000);
    const s = tn.schedule;
    if (!s) return null;
    const key = everyKey(s.every_secs);
    const every = key ? t(`network.schedule.every.${key}` as TranslationKey) : `${s.every_secs}s`;
    const text = (
        <>
            <Repeat size={12} className="shrink-0" aria-hidden />
            <span>{t("network.schedule.line", { every, next: formatRelativeTime(s.next_at, locale, now) })}</span>
            {s.last_error && <span>· {t("network.schedule.failedShort")}</span>}
        </>
    );
    const cls = cn("mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs", s.last_error ? "text-warning" : "text-muted-foreground");
    return onOpen ? (
        <button type="button" onClick={onOpen} className={cn(cls, "rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")} title={s.last_error ?? t("network.schedule.edit")}>
            {text}
        </button>
    ) : (
        <p className={cls} title={s.last_error ?? undefined}>{text}</p>
    );
}

type Lane = "new" | "gone" | "changed";

const LANE_ICON: Record<Lane, React.ReactNode> = {
    new: <ListPlus size={16} />,
    gone: <EyeOff size={16} />,
    changed: <ArrowLeftRight size={16} />,
};
const LANE_TONE: Record<Lane, string> = {
    new: "bg-success/12 text-success ring-success/20",
    gone: "bg-warning/12 text-warning ring-warning/20",
    changed: "bg-muted text-foreground ring-border",
};

/** 每條線先列這麼多台，其他按「再列」。/ Each lane shows this many before "show more". */
const LANE_SHOWN = 8;

function LaneList({ lane, items, onPick }: { lane: Lane; items: { address: string; host: LanHost | null; opened?: number[]; closed?: number[] }[]; onPick: (h: LanHost) => void }) {
    const { t } = useI18n();
    const [all, setAll] = useState(false);
    const shown = all ? items : items.slice(0, LANE_SHOWN);
    return (
        <section className="min-w-0 rounded-xl border border-border bg-card">
            <header className="flex items-center gap-2.5 border-b border-border px-3 py-2">
                <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg ring-1 ring-inset [&_svg]:size-3.5", LANE_TONE[lane])} aria-hidden>{LANE_ICON[lane]}</span>
                <span className="min-w-0 flex-1 text-sm text-foreground">{t(`network.changes.lane.${lane}` as TranslationKey)}</span>
                <span className="text-lg tabular-nums text-foreground">{items.length}</span>
            </header>
            {items.length === 0 ? (
                <p className="px-3 py-2.5 text-xs text-muted-foreground">{t(`network.changes.empty.${lane}` as TranslationKey)}</p>
            ) : (
                <ul className="divide-y divide-border">
                    {shown.map((x) => (
                        <li key={x.address}>
                            {x.host ? (
                                <button type="button" onClick={() => onPick(x.host!)} className="flex w-full min-w-0 flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                                    <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{hostName(x.host)}</span>
                                    {hostName(x.host) !== x.address && <span className="font-mono text-xs text-muted-foreground">{x.address}</span>}
                                    {x.opened && <PortDelta opened={x.opened} closed={x.closed ?? []} className="ml-auto" />}
                                </button>
                            ) : (
                                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-3 py-1.5">
                                    <span className="font-mono text-sm text-foreground">{x.address}</span>
                                    <span className="text-xs text-muted-foreground">{t("network.changes.removed")}</span>
                                    {x.opened && <PortDelta opened={x.opened} closed={x.closed ?? []} className="ml-auto" />}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {items.length > LANE_SHOWN && (
                <div className="border-t border-border px-3 py-1.5">
                    <button type="button" onClick={() => setAll((v) => !v)} className="text-xs text-primary hover:underline">
                        {all ? t("network.changes.fewer") : t("network.changes.more", { count: items.length - LANE_SHOWN })}
                    </button>
                </div>
            )}
        </section>
    );
}

/**
 * 「變了什麼」視窗：前一次掃描 ─ 比較 ─ 這一次（時間、網段、閘道），下面三條線各自列出主機，點一台就在頁面上打開它。
 * The "what changed" dialog: previous scan ─ compared ─ this scan (time, networks, gateway), then three lanes of
 * hosts; clicking one opens it on the page.
 */
export function ScanChangesDialog({ tn, onClose, onPickHost }: { tn: TopologyTunnel | null; onClose: () => void; onPickHost: (h: LanHost) => void }) {
    const { t, locale } = useI18n();
    if (!tn?.lan?.changes) return null;
    const lan = tn.lan;
    const changes = lan.changes!;
    const groups = changeGroups(changes, tn.hosts);
    const counts = changeCounts(changes)!;
    const when = lan.scanned_at ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(lan.scanned_at)) : "—";
    const pick = (h: LanHost) => {
        onPickHost(h);
        onClose();
    };
    return (
        <Modal
            isOpen
            onClose={onClose}
            size="4xl"
            icon={<Radar size={18} />}
            title={t("network.changes.title", { device: tn.name })}
            description={t("network.changes.desc")}
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={CalendarClock} title={t("network.changes.before")} sub={t("network.changes.beforeSub")} state="ok" stateText={t("network.changes.baseline")} />
                    <FlowLink label={t("network.changes.compared")} state="ok" />
                    <FlowNode
                        icon={Radar}
                        title={t("network.changes.after")}
                        sub={[when, lan.networks.join(", "), lan.gateway ? t("network.changes.gatewayIs", { gateway: lan.gateway }) : null].filter(Boolean).join(" · ")}
                        state="ok"
                        stateText={counts.total > 0 ? t("network.changes.total", { count: counts.total }) : t("network.changes.none")}
                    />
                </FlowPath>
                <div className="grid gap-3 md:grid-cols-3">
                    <LaneList lane="new" items={groups.new} onPick={pick} />
                    <LaneList lane="gone" items={groups.gone} onPick={pick} />
                    <LaneList lane="changed" items={groups.changed} onPick={pick} />
                </div>
                <Callout tone="info">{t("network.changes.how")}</Callout>
            </div>
        </Modal>
    );
}
