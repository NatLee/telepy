"use client";

/**
 * 即時 session 頁：誰現在連在哪台裝置上（網頁終端機 / 檔案 / 遠端瀏覽器 / 遠端桌面 / 筆電的 ssh / MCP agent），可結束。
 * 看得到自己的、自己擁有或 ADMIN 的隧道上所有人的；管理員看全部。`?tunnel=<id>` 只看一條。
 * Live sessions: who is connected to which device right now, with an End action. Shows your own plus everyone's on
 * tunnels you own or ADMIN (everything for admins); `?tunnel=<id>` narrows it to one tunnel.
 */
import React, { Suspense, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Plug, Power, RefreshCw, Server, X } from "lucide-react";
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
import { filterSessions, groupByTunnel, type KindFilter } from "@/lib/liveSessions";
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
                        {!!s.shells && <Chip>{t("sessions.shells", { count: s.shells })}</Chip>}
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
    const tunnelParam = Number(params.get("tunnel")) || null;
    const { sessions, failed, reload, end } = useLiveSessions();
    const [kind, setKind] = useState<KindFilter>("all");
    const [mineOnly, setMineOnly] = useState(false);
    const [pending, setPending] = useState<LiveSession | null>(null);

    const all = useMemo(() => sessions ?? [], [sessions]);
    const tunnels = useMemo(() => groupByTunnel(all).map((g) => ({ id: g.tunnelId, name: g.name })), [all]);
    const groups = useMemo(() => groupByTunnel(filterSessions(all, { kind, mineOnly, tunnelId: tunnelParam })), [all, kind, mineOnly, tunnelParam]);
    const shown = groups.reduce((n, g) => n + g.sessions.length, 0);
    const setTunnel = (id: number | null) => router.replace(id ? `/tunnels/sessions?tunnel=${id}` : "/tunnels/sessions");

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
                    value={tunnelParam ?? ""}
                    onChange={(e) => setTunnel(e.target.value ? Number(e.target.value) : null)}
                    className="h-9 w-48"
                    aria-label={t("sessions.filterTunnel")}
                >
                    <option value="">{t("sessions.allTunnels")}</option>
                    {tunnels.map((x) => (
                        <option key={x.id} value={x.id}>
                            {x.name}
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
                    {(kind !== "all" || mineOnly || tunnelParam) && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="mt-3"
                            onClick={() => {
                                setKind("all");
                                setMineOnly(false);
                                setTunnel(null);
                            }}
                        >
                            <X /> {t("sessions.clearFilters")}
                        </Button>
                    )}
                </div>
            ) : (
                <div className="space-y-4">
                    {groups.map((g) => (
                        <section key={g.tunnelId} className="overflow-hidden rounded-xl border border-border bg-card">
                            <h2 className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5 text-sm text-foreground">
                                <Server size={15} className="text-muted-foreground" aria-hidden />
                                {g.name}
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
                            ? t("sessions.endMine", { kind: t(PRESENCE_KINDS[pending.kind]?.label ?? "sessions.allKinds"), tunnel: pending.tunnel.name ?? "" })
                            : t("sessions.endOther", { user: pending.user.username, kind: t(PRESENCE_KINDS[pending.kind]?.label ?? "sessions.allKinds"), tunnel: pending.tunnel.name ?? "" })
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
