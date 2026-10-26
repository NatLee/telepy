"use client";

/**
 * 即時 session 頁：誰現在連在哪台裝置上（網頁終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面 / 筆電的 ssh / MCP agent），可結束。
 * 看得到自己的、自己擁有或 ADMIN 的隧道上與自己的 RustDesk 裝置上所有人的；管理員看全部。`?tunnel=<id>` /
 * `?device=<RustDesk 裝置 id>` 只看一處。
 * Live sessions: who is connected to which device right now, with an End action. Shows your own plus everyone's on
 * tunnels you own or ADMIN and on your RustDesk devices (everything for admins); `?tunnel=<id>` / `?device=<id>`
 * narrows it to one place.
 */
import React, { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Activity, MonitorSmartphone, Plug, Power, RefreshCw, Server, X } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { IpPlace } from "@/components/ui/IpPlace";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { PRESENCE_KINDS } from "@/components/tunnels/TunnelPresence";
import { useLiveSessions } from "@/hooks/useLiveSessions";
import { useI18n } from "@/lib/i18n";
import { filterSessions, groupByPlace, parsePlaceKey, placeFromParams, placeKey, placeName, type KindFilter, type Place } from "@/lib/liveSessions";
import { formatRelativeTime } from "@/lib/relativeTime";
import type { LiveSession } from "@/types/liveSession";

const KIND_FILTERS: KindFilter[] = ["all", "terminal", "files", "browser", "desktop", "rustdesk", "ssh", "ai"];

function SessionRow({ s, onEnd }: { s: LiveSession; onEnd: () => void }) {
    const { t, locale } = useI18n();
    const kind = PRESENCE_KINDS[s.kind];
    const Icon = kind?.icon ?? Plug;
    const label = kind ? t(kind.label) : s.kind;
    return (
        <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-muted-foreground" aria-hidden>
                    <Icon size={16} />
                </span>
                <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-foreground">
                        <span>{label}</span>
                        {s.client && <span className="text-muted-foreground">· {s.client}</span>}
                        {s.mine && <Chip>{t("sessions.you")}</Chip>}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span className="text-foreground/80">{s.user.username}</span>
                        {s.ip && <span className="font-mono">{s.ip}</span>}
                        <IpPlace geo={s.geo} />
                    </p>
                </div>
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap" title={new Date(s.since).toLocaleString(locale)}>
                {t("sessions.since", { time: formatRelativeTime(s.since, locale) })}
            </span>
            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={onEnd}>
                <Power /> {t("sessions.end")}
            </Button>
        </li>
    );
}

function LiveSessionsInner() {
    const { t } = useI18n();
    const router = useRouter();
    const params = useSearchParams();
    const place = placeFromParams(params.get("tunnel"), params.get("device"));
    const { sessions, failed, reload, end } = useLiveSessions();
    const [kind, setKind] = useState<KindFilter>("all");
    const [mineOnly, setMineOnly] = useState(false);
    const [pending, setPending] = useState<LiveSession | null>(null);

    const all = useMemo(() => sessions ?? [], [sessions]);
    const places = useMemo(() => groupByPlace(all), [all]);
    const placeValue = place ? placeKey(place) : "";
    const groups = useMemo(() => groupByPlace(filterSessions(all, { kind, mineOnly, place: parsePlaceKey(placeValue) })), [all, kind, mineOnly, placeValue]);
    const shown = groups.reduce((n, g) => n + g.sessions.length, 0);
    const setPlace = (p: Place | null) => router.replace(p ? `/tunnels/sessions?${p.type}=${p.id}` : "/tunnels/sessions");

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<Activity />}
                title={t("sessions.title")}
                description={t("sessions.subtitle")}
                actions={
                    <Button onClick={() => void reload()} variant="outline">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="max-w-full overflow-x-auto">
                    <Segmented
                        size="sm"
                        aria-label={t("sessions.filterKind")}
                        value={kind}
                        onChange={setKind}
                        options={KIND_FILTERS.map((k) => ({ value: k, label: k === "all" ? t("sessions.allKinds") : t(PRESENCE_KINDS[k].label) }))}
                    />
                </div>
                <NativeSelect
                    value={placeValue}
                    onChange={(e) => setPlace(parsePlaceKey(e.target.value))}
                    className="h-9 w-48"
                    aria-label={t("sessions.filterTunnel")}
                >
                    <option value="">{t("sessions.allTunnels")}</option>
                    {places.map((x) => (
                        <option key={x.key} value={x.key}>
                            {x.place.type === "device" ? t("sessions.rustdeskOption", { name: x.name }) : x.name}
                        </option>
                    ))}
                </NativeSelect>
                <Segmented
                    size="sm"
                    aria-label={t("sessions.filterWho")}
                    value={mineOnly ? "mine" : "everyone"}
                    onChange={(v) => setMineOnly(v === "mine")}
                    options={[
                        { value: "everyone", label: t("sessions.everyone") },
                        { value: "mine", label: t("sessions.mine") },
                    ]}
                />
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t("sessions.count", { count: shown })}</span>
            </div>

            {failed && <Callout tone="warning" className="mb-4">{t("sessions.loadFailed")}</Callout>}

            {sessions !== null && shown === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                    <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                        <Activity size={20} />
                    </span>
                    <p className="text-sm text-foreground">{t("sessions.empty")}</p>
                    <p className="mt-1 max-w-md text-xs text-muted-foreground">{t("sessions.emptyHint")}</p>
                    {(kind !== "all" || mineOnly || place) && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                                setKind("all");
                                setMineOnly(false);
                                setPlace(null);
                            }}
                        >
                            <X /> {t("sessions.clearFilters")}
                        </Button>
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    {groups.map((g) => (
                        <section key={g.key} className="overflow-hidden rounded-xl border border-border bg-card">
                            <h2 className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5 text-sm text-foreground">
                                {g.place.type === "device" ? (
                                    <>
                                        <MonitorSmartphone size={15} className="text-muted-foreground" aria-hidden />
                                        <Link href="/tunnels/rustdesk" prefetch={false} className="min-w-0 truncate underline-offset-2 hover:underline">{g.name}</Link>
                                        <Chip title={t("sessions.rustdeskHint")}>RustDesk</Chip>
                                    </>
                                ) : (
                                    <>
                                        <Server size={15} className="text-muted-foreground" aria-hidden />
                                        {g.name}
                                    </>
                                )}
                                <span className="text-xs text-muted-foreground tabular-nums">{g.sessions.length}</span>
                            </h2>
                            <ul className="divide-y divide-border">
                                {g.sessions.map((s) => (
                                    <SessionRow key={s.id} s={s} onEnd={() => setPending(s)} />
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}

            <p className="mt-6 text-xs text-muted-foreground">{t("sessions.footnote")}</p>

            <ConfirmDialog
                isOpen={pending !== null}
                onClose={() => setPending(null)}
                onConfirm={async () => {
                    if (pending) await end(pending);
                    setPending(null);
                }}
                title={t("sessions.endTitle")}
                message={
                    pending
                        ? pending.mine
                            ? t("sessions.endMine", { kind: t(PRESENCE_KINDS[pending.kind]?.label ?? "sessions.allKinds"), tunnel: placeName(pending) })
                            : t("sessions.endOther", { user: pending.user.username, kind: t(PRESENCE_KINDS[pending.kind]?.label ?? "sessions.allKinds"), tunnel: placeName(pending) })
                        : ""
                }
                confirmText={t("sessions.end")}
                isDestructive
            />
        </div>
    );
}

export default function LiveSessionsPage() {
    return (
        <Suspense>
            <LiveSessionsInner />
        </Suspense>
    );
}
