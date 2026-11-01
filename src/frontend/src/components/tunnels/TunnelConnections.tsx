/**
 * 通道詳細資訊裡的「連線紀錄」：24 小時 / 7 天在線率、最近 24 小時每小時一格的長條，以及最近幾次連線
 * （時間、多久、來源 IP——IP 只有能登入裝置的人看得到）。參考 Cloudflare Tunnel 的 connectors 與狀態頁。
 * gateway 只看到內部位址（埠轉發、Docker、代理把來源換掉了）時，顯示裝置在那次連線自己回報的公網 IP，並註明 gateway
 * 看到什麼；「為什麼是內部位址？」打開說明圖。
 * "Connections" in the tunnel details: 24 h / 7 day uptime, one bar per hour for the last 24 hours and the latest
 * sessions (when, how long, source IP — only for people who can log in to the device). Behind an internal peer (a port
 * forward, Docker or a proxy replaced the source) the row shows the public IP the device reported during that
 * connection and notes what the gateway saw; "Why an internal address?" opens the diagram.
 */
import React, { useState } from "react";
import { Activity, Info, Monitor, Shuffle } from "lucide-react";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { Section, Chip } from "@/components/ui/section";
import { useAuth } from "@/lib/auth";
import { anyInternal, connectionAddress, internalExample, type SessionAddress } from "@/lib/connectionAddress";
import { placeLabel } from "@/lib/geo";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TunnelConnections as Data } from "@/hooks/useTunnelConnections";

function barTone(v: number | null): string {
    if (v === null) return "bg-muted";
    if (v >= 0.999) return "bg-success";
    if (v <= 0.001) return "bg-destructive/70";
    return "bg-warning";
}

/** 秒 → 「3 分鐘」「2.5 小時」「4 天」（Intl 依語系翻單位）。/ Seconds → a localized duration in its largest unit. */
function duration(seconds: number, locale: string): string {
    const [value, unit] =
        seconds >= 86_400 ? [seconds / 86_400, "day"] : seconds >= 3_600 ? [seconds / 3_600, "hour"] : seconds >= 60 ? [seconds / 60, "minute"] : [seconds, "second"];
    return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long", maximumFractionDigits: 1 }).format(value);
}

/** 一列連線的位址：公網的照舊；內部位址後面的，顯示裝置回報的公網 IP 並註明 gateway 看到什麼。/ One row's address. */
function SessionAddressCell({ s }: { s: SessionAddress }) {
    const { t, locale } = useI18n();
    const a = connectionAddress(s);
    if (a.kind === "hidden") return null;
    if (a.kind === "internal") {
        return (
            <span className="ml-auto text-right text-xs text-warning" title={t("tunnelDetails.peerInternalTitle", { ip: a.saw })}>
                <span className="font-mono">{a.saw}</span> · {t("tunnelDetails.peerInternal")}
            </span>
        );
    }
    const place = a.geo ? placeLabel(a.geo, locale) : null;
    if (a.kind === "direct") {
        return (
            <span className="ml-auto font-mono text-xs text-muted-foreground" title={place ?? undefined}>
                {a.ip}
            </span>
        );
    }
    const from = a.source === "lookup" ? t("tunnelDetails.peerViaLookup") : t("tunnelDetails.peerViaDevice");
    return (
        <span className="ml-auto flex flex-col items-end text-right" title={[place, from].filter(Boolean).join(" · ")}>
            <span className="font-mono text-xs text-foreground">{a.ip}</span>
            <span className="text-[0.75rem] leading-tight text-muted-foreground">{t("tunnelDetails.peerSaw", { ip: a.saw })}</span>
        </span>
    );
}

/**
 * 「為什麼是內部位址？」：裝置 ─ 網際網路 ─ Telepy SSH 埠前面那一層（來源在這裡被換掉）─ gateway 看到的位址，
 * 加上 Telepy 怎麼補回公網 IP、走網頁 port 的連線為什麼不受影響、管理員能怎麼讓 gateway 看到真的位址。
 * "Why an internal address?": device ─ internet ─ the hop in front of Telepy's SSH port (where the source is
 * replaced) ─ what the gateway sees, plus how Telepy recovers the public IP, why web-port connections are unaffected and
 * what an admin can do about it.
 */
function PeerAddressDialog({ open, onClose, example }: { open: boolean; onClose: () => void; example: { saw: string; reported: string | null } }) {
    const { t, tn } = useI18n();
    const { user } = useAuth();
    const code = (s: string) => <code className="[overflow-wrap:anywhere]">{s}</code>;
    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            title={t("tunnelDetails.peerWhyTitle")}
            description={t("tunnelDetails.peerWhyDescription")}
            icon={<Info />}
            size="4xl"
            footer={<Button type="button" variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-5">
                <FlowPath>
                    <FlowNode icon={Monitor} title={t("tunnelDetails.peerWhyDevice")} sub={example.reported ? <span className="font-mono">{example.reported}</span> : t("tunnelDetails.peerWhyDeviceUnknown")} state="ok" stateText={t("tunnelDetails.peerWhyDeviceState")} />
                    <FlowLink label={t("tunnelDetails.peerWhyInternet")} state="ok" />
                    <FlowNode icon={Shuffle} title={t("tunnelDetails.peerWhyFront")} sub={t("tunnelDetails.peerWhyFrontSub")} state="ok" stateText={t("tunnelDetails.peerWhyFrontState")} />
                    <FlowLink label={t("tunnelDetails.peerWhyReplaced")} state="failed" />
                    <FlowNode brand title={t("tunnelDetails.peerWhyGateway")} sub={<span className="font-mono">{example.saw}</span>} state="ok" stateText={t("tunnelDetails.peerWhyGatewayState")} />
                </FlowPath>
                <ul className="list-disc space-y-2 pl-5 text-sm leading-relaxed text-foreground/90">
                    <li>{t("tunnelDetails.peerWhyP1", { ip: example.saw })}</li>
                    <li>{tn("tunnelDetails.peerWhyP2", { whoami: code("/api/whoami") })}</li>
                    <li>{t("tunnelDetails.peerWhyP3")}</li>
                    {user?.is_superuser && (
                        <li>
                            {tn("tunnelDetails.peerWhyAdmin", { setting: code("GATEWAY_PROXY_PROTOCOL_FROM") })}{" "}
                            <a href="/tunnels/settings?tab=server" className="text-primary underline-offset-2 hover:underline">
                                {t("tunnelDetails.peerWhyAdminLink")}
                            </a>
                        </li>
                    )}
                </ul>
            </div>
        </Modal>
    );
}

export function TunnelConnectionsSection({ data, failed }: { data: Data | null; failed: boolean }) {
    const { t, locale } = useI18n();
    const [why, setWhy] = useState(false);
    const example = data ? internalExample(data.sessions) : null;
    const pct = (v: number | null) => (v === null ? "—" : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(v));
    const time = (iso: string) => new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const hourLabel = (hoursAgo: number) => {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() - hoursAgo);
        return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    };

    return (
        <Section icon={<Activity />} title={t("tunnelDetails.connections")} description={t("tunnelDetails.connectionsHint")}>
            {failed ? (
                <p className="text-sm text-muted-foreground">{t("tunnelDetails.connectionsFailed")}</p>
            ) : !data ? (
                <div className="h-24 animate-pulse rounded-lg bg-surface" aria-hidden />
            ) : !data.tracked_since ? (
                <p className="rounded-lg border border-dashed border-input bg-surface px-3 py-4 text-center text-sm text-muted-foreground">{t("tunnelDetails.noHistory")}</p>
            ) : (
                <div className="space-y-4">
                    <dl className="grid grid-cols-2 gap-2">
                        {([["h24", "tunnelDetails.uptime24h"], ["d7", "tunnelDetails.uptime7d"]] as const).map(([k, label]) => (
                            <div key={k} className="rounded-lg border border-border bg-surface px-3 py-2">
                                <dt className="text-xs text-muted-foreground">{t(label)}</dt>
                                <dd className="mt-0.5 font-mono text-lg tabular-nums text-foreground">{pct(data.uptime[k])}</dd>
                            </div>
                        ))}
                    </dl>

                    <div>
                        <div className="flex h-10 items-end gap-[3px]" role="img" aria-label={t("tunnelDetails.hourlyAria")}>
                            {data.hourly.map((v, i) => {
                                const hoursAgo = data.hourly.length - i;
                                const range = `${hourLabel(hoursAgo)}–${hourLabel(hoursAgo - 1)}`;
                                return (
                                    <span
                                        key={i}
                                        title={v === null ? t("tunnelDetails.hourNoData", { range }) : t("tunnelDetails.hourUp", { range, pct: pct(v) })}
                                        className="flex h-full min-w-0 flex-1 items-end rounded-[2px] bg-muted/60"
                                    >
                                        <span className={cn("w-full rounded-[2px]", barTone(v))} style={{ height: v === null ? "100%" : `${Math.max(v, 0.08) * 100}%` }} />
                                    </span>
                                );
                            })}
                        </div>
                        <div className="mt-1 flex justify-between text-[0.75rem] text-muted-foreground">
                            <span>{t("tunnelDetails.hoursAgo")}</span>
                            <span>{t("tunnelDetails.now")}</span>
                        </div>
                    </div>

                    <div>
                        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <p className="text-xs text-muted-foreground">{t("tunnelDetails.latestConnections")}</p>
                            {anyInternal(data.sessions) && (
                                <button
                                    type="button"
                                    onClick={() => setWhy(true)}
                                    className="inline-flex items-center gap-1 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <Info size={13} aria-hidden />
                                    {t("tunnelDetails.peerWhy")}
                                </button>
                            )}
                        </div>
                        <ul className="divide-y divide-border rounded-lg border border-border">
                            {data.sessions.map((s) => (
                                <li key={s.connected_at} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                    <span className="tabular-nums text-foreground">{time(s.connected_at)}</span>
                                    {s.disconnected_at ? (
                                        <span className="text-muted-foreground">{s.seconds !== null ? duration(s.seconds, locale) : "—"}</span>
                                    ) : (
                                        <Chip tone="success">{t("tunnelDetails.connectedNow")}</Chip>
                                    )}
                                    <SessionAddressCell s={s} />
                                </li>
                            ))}
                        </ul>
                        <p className="mt-1.5 text-xs text-muted-foreground">{t("tunnelDetails.trackingSince", { date: time(data.tracked_since) })}</p>
                    </div>
                </div>
            )}
            {example && <PeerAddressDialog open={why} onClose={() => setWhy(false)} example={example} />}
        </Section>
    );
}
