"use client";

/**
 * 管理區的全站通知：頁面提示與桌面通知的網站預設（每個事件 × 管道），以及每個事件的「允許使用者覆寫」
 * （關 = 強制：收到的人一律顯示，不能關、不能用隧道靜音蓋掉）。只有管理員。
 * The admin section's site notifications: the site defaults for in-app and desktop notifications (per event ×
 * channel) and each event's "Let people override" switch (off = enforced: always shown to everyone who receives
 * it, can't be turned off or muted). Admins only.
 */
import React, { useCallback, useEffect, useState } from "react";
import { BellRing, Info, Lock } from "lucide-react";
import { AdminChip, AdminGate } from "@/components/layout/AdminViews";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { useToast } from "@/components/ui/Toast";
import { NotifyMatrix } from "@/components/notify/NotifyMatrix";
import { NotifyFlowDialog } from "@/components/notify/NotifyFlow";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { parsePrefs, type NotifyChannel, type NotifyEvent } from "@/lib/notifyPrefs";

export default function AdminNotificationsPage() {
    return (
        <AdminGate>
            <SiteNotifications />
        </AdminGate>
    );
}

function SiteNotifications() {
    const { t } = useI18n();
    const { showError } = useToast();
    const [events, setEvents] = useState<NotifyEvent[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [flowOpen, setFlowOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const r = await apiFetch("/api/notifications/defaults");
            const p = r.ok ? parsePrefs(await r.json()) : null;
            setFailed(!p);
            if (p) setEvents(p.events);
        } catch {
            setFailed(true);
        }
    }, []);
    useEffect(() => {
        const first = setTimeout(() => void load(), 0);
        return () => clearTimeout(first);
    }, [load]);

    const save = async (body: object, optimistic: (list: NotifyEvent[]) => NotifyEvent[]) => {
        const before = events;
        if (events) setEvents(optimistic(events));
        const r = await apiFetch("/api/notifications/defaults", { method: "PUT", body: JSON.stringify(body) });
        const data = await readJson(r);
        const p = r.ok ? parsePrefs(data) : null;
        if (!p) {
            setEvents(before);
            showError(t("notifyPrefs.saveFailed", { error: responseError(r, data, String(r.status)) }));
            return;
        }
        setEvents(p.events);
    };
    const change = (ev: NotifyEvent, channel: NotifyChannel, value: boolean) =>
        void save({ defaults: [{ event: ev.event, channel, value: value ? "on" : "off" }] }, (list) =>
            list.map((e) => (e.event === ev.event ? { ...e, site: { ...e.site, [channel]: value } } : e)),
        );
    const lock = (ev: NotifyEvent, locked: boolean) =>
        void save({ locks: [{ event: ev.event, locked }] }, (list) => list.map((e) => (e.event === ev.event ? { ...e, locked } : e)));

    return (
        <div className="flex flex-col animate-fade-in-up">
            <PageHeader
                className="mb-6"
                icon={<BellRing />}
                title={t("nav.adminNotifications")}
                titleAddon={<AdminChip />}
                description={t("notifyPrefs.adminDescription")}
                actions={
                    <Button variant="outline" onClick={() => setFlowOpen(true)} disabled={!events}>
                        <Info size={16} /> {t("notifyPrefs.howItWorks")}
                    </Button>
                }
            />
            {failed && <Callout tone="warning" className="mb-4">{t("notifyPrefs.loadFailed")}</Callout>}
            <Callout tone="info" className="mb-6" icon={<Lock />} title={t("notifyPrefs.lockNoteTitle")}>
                {t("notifyPrefs.lockNote")}
            </Callout>
            <div className="rounded-xl border border-border bg-card p-4 shadow-card sm:p-5">
                {events ? <NotifyMatrix mode="site" events={events} onChange={change} onLock={lock} /> : <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
            </div>
            {events && <NotifyFlowDialog isOpen={flowOpen} onClose={() => setFlowOpen(false)} events={events} admin />}
        </div>
    );
}
