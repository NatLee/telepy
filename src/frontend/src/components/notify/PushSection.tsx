"use client";

/**
 * 偏好設定 → 通知 →「推播通知」：這台裝置的開關（要在點擊裡要權限）、為什麼不能開（http / iPhone 要先加到主畫面 / 瀏覽器
 * 不支援 / 管理員關了），收推播的裝置清單（這一台、最近一次送出、測試、移除），資訊按鈕打開路徑圖。
 * Preferences → Notifications → "Push notifications": this device's switch (permission is asked in the click), why it
 * can't be turned on (http / iPhone needs the Home Screen first / unsupported / turned off by an admin), the devices
 * that receive pushes (this one, the last delivery, test, remove), and the info button's path diagram.
 */
import React, { useState } from "react";
import { BellRing, Info, Send, Smartphone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, Section } from "@/components/ui/section";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/Toast";
import { usePush } from "@/hooks/usePush";
import { useI18n } from "@/lib/i18n";
import { delayChoices, lastDelivery, type PushDevice, type PushStatus } from "@/lib/push";
import { describeUserAgent } from "@/lib/userAgent";
import { PushFlowDialog, useWaitLabel } from "./PushFlow";

export function PushSection({ details }: { details: boolean }) {
    const { t, locale } = useI18n();
    const { showSuccess, showError } = useToast();
    const push = usePush();
    const [busy, setBusy] = useState(false);
    const [denied, setDenied] = useState(false);
    const [infoOpen, setInfoOpen] = useState(false);
    const { view, support, on } = push;

    const toggle = async (next: boolean) => {
        setBusy(true);
        setDenied(false);
        try {
            if (next) {
                const r = await push.enable({ lang: locale, details });
                if (r === "denied") setDenied(true);
            } else {
                await push.disable();
            }
        } catch (e) {
            showError(t("push.failed", { error: e instanceof Error ? e.message : "" }));
        } finally {
            setBusy(false);
        }
    };

    const test = async (d: PushDevice) => {
        try {
            const r = await push.test(d.id);
            if (r.outcome === "sent") showSuccess(t("push.testSent"));
            else if (r.outcome === "gone") showError(t("push.testGone"));
            else if (r.outcome === "skipped") showError(t("push.testSkipped"));
            else showError(t("push.failed", { error: r.error ?? "" }));
        } catch (e) {
            showError(t("push.failed", { error: e instanceof Error ? e.message : "" }));
        }
    };

    const remove = async (d: PushDevice) => {
        try {
            if (d.current) await push.disable();
            else await push.remove(d.id);
        } catch (e) {
            showError(t("push.failed", { error: e instanceof Error ? e.message : "" }));
        }
    };

    const blocked = support !== "ok" || !view?.available;
    return (
        <Section
            icon={<BellRing />}
            title={t("push.title")}
            description={t("push.description")}
            action={
                <Button type="button" size="sm" variant="outline" onClick={() => setInfoOpen(true)}>
                    <Info size={14} /> {t("push.howItWorks")}
                </Button>
            }
        >
            {support === "insecure" && <Callout tone="warning">{t("push.why.insecure")}</Callout>}
            {support === "unsupported" && <Callout tone="warning">{t("push.why.unsupported")}</Callout>}
            {/* 偏好設定已經開著：同一個事件換到「安裝成 App」分頁（不 import 那個 modal，免得互相引用）。
                Preferences is open already: the same event switches it to the install tab (no import of the modal, no cycle). */}
            {support === "iosInstall" && (
                <Callout tone="info" icon={<Smartphone size={17} className="mt-0.5 shrink-0" aria-hidden />}>
                    {t("push.why.iosInstall")}{" "}
                    <button type="button" className="text-foreground underline underline-offset-2" onClick={() => window.dispatchEvent(new CustomEvent("telepy:open-prefs", { detail: "install" }))}>
                        {t("prefs.tabInstall")}
                    </button>
                </Callout>
            )}
            {view && !view.enabled && <Callout tone="warning">{t("push.why.off")}</Callout>}
            {view?.enabled && view.key_error && <Callout tone="danger">{t("push.why.key", { error: view.key_error })}</Callout>}

            <Switch checked={on} onCheckedChange={(v) => void toggle(v)} disabled={busy || (blocked && !on) || !view}>
                {t("push.here")}
            </Switch>
            {denied && <Callout tone="warning">{t("push.denied")}</Callout>}
            {on && view?.status && <StatusWait status={view.status} onSaved={() => void push.refresh()} />}

            {view && view.subscriptions.length > 0 && (
                <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{t("push.devices")}</p>
                    <ul className="divide-y divide-border rounded-xl border border-border">
                        {view.subscriptions.map((d) => (
                            <DeviceRow key={d.id} d={d} onTest={() => void test(d)} onRemove={() => void remove(d)} />
                        ))}
                    </ul>
                </div>
            )}

            <PushFlowDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} device={push.current} on={on} status={view?.status} />
        </Section>
    );
}

/**
 * 上線 / 離線推播：這個人要等多久（跟著帳號，每台裝置一樣）；站台上限以上的選不到，目前的選擇超過時標成「會縮短成…」。
 * Status pushes: how long this person waits (on the account, the same on every device); choices above the site's limit
 * are hidden, a current choice above it is marked as shortened.
 */
function StatusWait({ status, onSaved }: { status: PushStatus; onSaved: () => void }) {
    const { t } = useI18n();
    const { showError } = useToast();
    const label = useWaitLabel();
    const [busy, setBusy] = useState(false);
    const save = async (secs: number) => {
        setBusy(true);
        try {
            const res = await apiFetch("/api/user/settings", { method: "POST", body: JSON.stringify({ push_status_delay: secs }) });
            if (!res.ok) showError(responseError(res, await readJson(res), t("push.failed", { error: `HTTP ${res.status}` })));
            onSaved();
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="space-y-1.5">
            <Field label={t("push.wait.label")} hint={t("push.wait.hint", { perHour: status.per_hour })}>
                <NativeSelect value={String(status.delay)} disabled={busy} onChange={(e) => void save(Number(e.target.value))}>
                    {delayChoices(status).map((c) => (
                        <option key={c.secs} value={c.secs}>
                            {c.capped ? t("push.wait.capped", { wait: label(c.secs), max: label(status.max_delay) }) : label(c.secs)}
                        </option>
                    ))}
                </NativeSelect>
            </Field>
        </div>
    );
}

function DeviceRow({ d, onTest, onRemove }: { d: PushDevice; onTest: () => void; onRemove: () => void }) {
    const { t, locale } = useI18n();
    const last = lastDelivery(d);
    const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "");
    return (
        <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
            <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-foreground">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{describeUserAgent(d.user_agent) ?? t("push.unknownDevice")}</span>
                    {d.current && <Chip tone="primary">{t("push.thisDevice")}</Chip>}
                </p>
                <p className={last === "failed" ? "text-xs text-destructive [overflow-wrap:anywhere]" : "text-xs text-muted-foreground"}>
                    {last === "ok" && t("push.lastOk", { at: when(d.last_success_at) })}
                    {last === "failed" && t("push.lastFailed", { at: when(d.last_error_at), error: d.last_error ?? "" })}
                    {last === "none" && t("push.since", { at: when(d.created_at) })}
                    {d.service && <span className="text-muted-foreground"> · {t(`push.service.${d.service}`)}</span>}
                </p>
            </div>
            <div className="flex shrink-0 gap-1">
                <Button type="button" size="sm" variant="ghost" onClick={onTest}>
                    <Send size={14} /> {t("push.test")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onRemove} aria-label={t("push.remove")} title={t("push.remove")}>
                    <Trash2 size={14} />
                </Button>
            </div>
        </li>
    );
}
