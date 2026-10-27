"use client";

/**
 * 終端機錄影：開了錄影的隧道上，網頁終端機的錄影，可播放、下載、刪除（只有 owner / ADMIN / 管理員）。兩個頁面共用：
 * `mine` = 終端機錄影頁（自己的、自己擁有或 ADMIN 的隧道上的，管理員也一樣）；`all` = 管理區的全站錄影（每個人的，
 * 可依使用者篩選）。`?tunnel=<id>` 只看一條。
 * Terminal recordings of web terminals on tunnels that record, with play, download and delete (managers only). Two
 * pages share it: `mine` = the Recordings page (yours plus everyone's on tunnels you own or ADMIN, admins too);
 * `all` = the admin section's site-wide view (everyone's, with a user filter). `?tunnel=<id>` narrows to one tunnel.
 */
import React, { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Clapperboard, Download, Film, Play, RefreshCw, Trash2 } from "lucide-react";
import { AdminChip, AdminViewLink, type ViewScope } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { CastPlayer } from "@/components/recordings/CastPlayer";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Chip } from "@/components/ui/section";
import { useRecordings } from "@/hooks/useRecordings";
import { clock, parseCast, type Cast } from "@/lib/asciicast";
import { useI18n } from "@/lib/i18n";
import { usersIn } from "@/lib/liveSessions";
import type { Recording } from "@/types/recording";

function size(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RecordingsView({ scope }: { scope: ViewScope }) {
    const { t, locale } = useI18n();
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const site = scope === "all";
    const tunnelId = Number(params.get("tunnel")) || null;
    const { list: fetched, failed, reload, fetchCast, download, remove } = useRecordings(tunnelId, scope);
    // 管理區：只看某個人的（在前端篩，名單取自清單）。/ Admin section: only one person's (filtered here, names from the list).
    const [userId, setUserId] = useState<number | null>(null);
    const people = useMemo(() => usersIn(fetched ?? []), [fetched]);
    const list = useMemo(() => (fetched && site && userId !== null ? fetched.filter((r) => r.user.id === userId) : fetched), [fetched, site, userId]);
    const [playing, setPlaying] = useState<{ rec: Recording; cast: Cast } | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Recording | null>(null);
    const tunnels = useMemo(() => {
        const m = new Map<number, string>();
        for (const r of fetched ?? []) m.set(r.tunnel.id, r.tunnel.name ?? `#${r.tunnel.id}`);
        return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    }, [fetched]);
    const fmt = (iso: string) => new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

    const play = async (r: Recording) => {
        const text = await fetchCast(r);
        if (text !== null) setPlaying({ rec: r, cast: parseCast(text) });
    };

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={site ? <Film /> : <Clapperboard />}
                title={site ? t("recordings.allTitle") : t("recordings.title")}
                titleAddon={site ? <AdminChip /> : undefined}
                description={site ? t("recordings.allSubtitle") : t("recordings.subtitle")}
                actions={
                    <Button onClick={() => void reload()} variant="outline">
                        <RefreshCw size={16} />
                        {t("common.refresh")}
                    </Button>
                }
            />

            {site ? (
                <Callout tone="info" className="mb-4">{t("recordings.bannerAll")}</Callout>
            ) : (
                <AdminViewLink className="mb-4" href="/tunnels/admin/recordings" label={t("nav.adminRecordings")} />
            )}

            <div className="mb-4 flex flex-wrap items-center gap-2">
                <NativeSelect
                    value={tunnelId ?? ""}
                    onChange={(e) => router.replace(e.target.value ? `${pathname}?tunnel=${e.target.value}` : pathname)}
                    className="h-9 w-56"
                    aria-label={t("recordings.filterTunnel")}
                >
                    <option value="">{t("recordings.allTunnels")}</option>
                    {tunnels.map(([id, name]) => (
                        <option key={id} value={id}>
                            {name}
                        </option>
                    ))}
                </NativeSelect>
                {site && (
                    <NativeSelect value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : null)} className="h-9 w-44" aria-label={t("recordings.filterUser")}>
                        <option value="">{t("recordings.allUsers")}</option>
                        {people.map((u) => (
                            <option key={u.id} value={u.id}>
                                {u.username}
                            </option>
                        ))}
                    </NativeSelect>
                )}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t("recordings.count", { count: list?.length ?? 0 })}</span>
            </div>

            {failed && <Callout tone="warning" className="mb-4">{t("recordings.loadFailed")}</Callout>}

            {list !== null && list.length === 0 ? (
                <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
                    <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                        <Clapperboard size={20} />
                    </span>
                    <p className="text-sm text-foreground">{t("recordings.empty")}</p>
                    <p className="mt-1 max-w-md text-xs text-muted-foreground">{site ? t("recordings.emptyHintAll") : t("recordings.emptyHint")}</p>
                </div>
            ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                    {(list ?? []).map((r) => (
                        <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                            <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
                                    <span>{r.tunnel.name}</span>
                                    <span className="font-mono text-xs text-muted-foreground">{r.lan_host ?? r.os_user}</span>
                                    {r.kind === "agent" && <Chip title={t("recordings.agentHint")}>{t("recordings.agent")}</Chip>}
                                    {r.live && <Chip tone="danger">{t("recordings.live")}</Chip>}
                                    {r.truncated && <Chip tone="warning">{t("recordings.truncated")}</Chip>}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {r.user.username} · {fmt(r.started_at)} · {r.live ? t("recordings.recordingNow") : clock(r.duration_ms / 1000)} · {size(r.bytes)}
                                </p>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <Button size="sm" onClick={() => void play(r)}>
                                    <Play /> {t("recordings.play")}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => void download(r)} aria-label={t("recordings.download")} title={t("recordings.download")}>
                                    <Download />
                                </Button>
                                {r.can_delete && !r.live && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        onClick={() => setPendingDelete(r)}
                                        aria-label={t("recordings.delete")}
                                        title={t("recordings.delete")}
                                    >
                                        <Trash2 />
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {/* 管理區的說明在上面的提示裡。/ The admin section explains itself in the banner above. */}
            {!site && <p className="mt-6 text-xs text-muted-foreground">{t("recordings.footnote")}</p>}

            <Modal
                isOpen={playing !== null}
                onClose={() => setPlaying(null)}
                title={playing ? `${playing.rec.tunnel.name} · ${playing.rec.lan_host ?? playing.rec.os_user}` : ""}
                description={playing ? `${playing.rec.user.username} · ${fmt(playing.rec.started_at)}` : undefined}
                icon={<Clapperboard />}
                size="4xl"
                footer={
                    playing ? (
                        <Button variant="outline" onClick={() => void download(playing.rec)}>
                            <Download /> {t("recordings.download")}
                        </Button>
                    ) : undefined
                }
            >
                {playing && <CastPlayer key={playing.rec.id} cast={playing.cast} tunnelId={playing.rec.tunnel.id} />}
            </Modal>

            <ConfirmDialog
                isOpen={pendingDelete !== null}
                onClose={() => setPendingDelete(null)}
                onConfirm={async () => {
                    if (pendingDelete) await remove(pendingDelete);
                    setPendingDelete(null);
                }}
                title={t("recordings.deleteTitle")}
                message={pendingDelete ? t("recordings.deleteMessage", { user: pendingDelete.user.username, when: fmt(pendingDelete.started_at) }) : ""}
                confirmText={t("recordings.delete")}
                isDestructive
            />
        </div>
    );
}
