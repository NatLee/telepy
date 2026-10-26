"use client";

/**
 * 一台 RustDesk 伺服器裝置最近的瀏覽器連線：誰、從哪、何時、多久、流量、怎麼結束的（擁有者與管理員）。
 * 這些裝置沒有隧道，所以 Logs 頁只有管理員看得到它們的事件；擁有者看這裡。
 * A RustDesk-server device's recent browser sessions: who, from where, when, how long, how much and how it ended.
 * These devices have no tunnel, so their gateway events are admin-only in Logs; owners read this instead.
 */
import React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { Chip } from "@/components/ui/section";
import { IpPlace } from "@/components/ui/IpPlace";
import { useRustDeskDeviceSessions } from "@/hooks/useRustDeskDevices";
import { formatBytes } from "@/lib/aiActivity";
import { useI18n } from "@/lib/i18n";
import { formatSpan } from "@/lib/relativeTime";
import { endReasonKey, type RustDeskDevice } from "@/lib/rustdeskDevices";

/** `device` 在關閉動畫期間還留著（`open` 先變 false）。/ `device` stays set while it closes (`open` goes false first). */
export function DeviceSessionsDialog({ device, open, onClose }: { device: RustDeskDevice | null; open: boolean; onClose: () => void }) {
    const { t, locale } = useI18n();
    const { sessions, loaded, failed } = useRustDeskDeviceSessions(device?.id ?? null, open);
    const time = (iso: string) => new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    return (
        <Modal
            isOpen={open && !!device}
            onClose={onClose}
            title={t("rustdesk.history.title")}
            description={device ? t("rustdesk.history.description", { name: device.name }) : undefined}
            icon={<History />}
            size="lg"
            footer={
                <>
                    {device && device.in_use > 0 && (
                        <Button asChild variant="outline">
                            <Link href={`/tunnels/sessions?device=${device.id}`} prefetch={false}>{t("rustdesk.history.live", { n: device.in_use })}</Link>
                        </Button>
                    )}
                    <Button onClick={onClose}>{t("common.close")}</Button>
                </>
            }
        >
            {failed ? (
                <p className="text-sm text-muted-foreground">{t("rustdesk.history.failed")}</p>
            ) : !loaded ? (
                <div className="h-24 animate-pulse rounded-lg bg-surface" aria-hidden />
            ) : sessions.length === 0 ? (
                <p className="rounded-lg border border-dashed border-input bg-surface px-3 py-6 text-center text-sm text-muted-foreground">{t("rustdesk.history.empty")}</p>
            ) : (
                <ul className="divide-y divide-border rounded-lg border border-border">
                    {sessions.map((s) => (
                        <li key={s.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-foreground">{s.user.username}</span>
                                {s.mine && <Chip>{t("sessions.you")}</Chip>}
                                <span className="tabular-nums text-muted-foreground">{time(s.started_at)}</span>
                                <span className="flex-1" />
                                {s.ended_at ? (
                                    <span className="text-muted-foreground">{s.seconds !== null ? formatSpan(s.seconds, locale) : "—"}</span>
                                ) : (
                                    <Chip tone="success">{t("rustdesk.history.open")}</Chip>
                                )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                {s.ip && <span className="font-mono">{s.ip}</span>}
                                <IpPlace geo={s.geo} />
                                {s.ended_at && (
                                    <>
                                        <span className="inline-flex items-center gap-0.5 tabular-nums" title={t("rustdesk.history.toBrowser")}>
                                            <ArrowDown size={12} aria-hidden /> {formatBytes(s.to_browser)}
                                        </span>
                                        <span className="inline-flex items-center gap-0.5 tabular-nums" title={t("rustdesk.history.toDevice")}>
                                            <ArrowUp size={12} aria-hidden /> {formatBytes(s.to_device)}
                                        </span>
                                        <span>{t(endReasonKey(s.reason))}</span>
                                    </>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <p className="mt-3 text-xs text-muted-foreground">{t("rustdesk.history.note")}</p>
        </Modal>
    );
}
