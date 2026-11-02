"use client";

/**
 * 詳細資訊「裝置」頁的「裝置上的安裝」：`GET …/device-install`（打開時讀；沒盤點過又在線就自動盤點一次），
 * 「重新檢查」= `POST …/survey`，「在裝置上改名」= `POST …/rename`（要跑十幾到幾十秒；步驟靠
 * `DEVICE-INSTALL-UPDATED {step, state}` 即時更新，最後以回應為準）。
 * The details dialog's "On the device": read on open (an unsurveyed online device is surveyed once automatically),
 * "Check again" posts `/survey`, "Rename on the device" posts `/rename` while `DEVICE-INSTALL-UPDATED` streams steps,
 * "Remove the extra copy" posts `/tidy` (three steps, same report shape).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { formatApiError } from "@/lib/formatApiError";
import { LongRequestLost, longFetch } from "@/lib/longFetch";
import type { TranslationKey } from "@/locales/en";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { RENAME_STEPS, type DeviceInstallView, type RenameReport, type ReportedStep, type WayInSetup } from "@/lib/deviceInstall";
import { doneKeys } from "@/lib/wayIn";

export function useDeviceInstall(tunnelId: number | null, isOpen: boolean, enabled: boolean, onChanged?: () => void) {
    const { t } = useI18n();
    const { showError, showSuccess, showToast } = useToast();
    const [view, setView] = useState<{ id: number; view: DeviceInstallView } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [surveying, setSurveying] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const [steps, setSteps] = useState<ReportedStep[]>([]);
    const [report, setReport] = useState<RenameReport | null>(null);
    const autoSurveyed = useRef<number | null>(null);

    const current = view && view.id === tunnelId ? view.view : null;

    const load = useCallback(async () => {
        if (!tunnelId) return;
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/device-install`);
            const body = await readJson<DeviceInstallView>(res);
            if (res.ok && body) {
                setView({ id: tunnelId, view: body });
                setError(null);
            } else setError(responseError(res, body, t("deviceInstall.loadFailed")));
        } catch (e) {
            setError(e instanceof Error ? e.message : t("deviceInstall.loadFailed"));
        }
    }, [tunnelId, t]);

    // 前面的代理切斷了請求（伺服器照樣做完）：說一聲，結果到了再顯示。/ A proxy cut the request: say so, the result follows.
    const onCut = useCallback(() => showToast(t("deviceInstall.cutNote"), "info"), [showToast, t]);

    const survey = useCallback(
        async (quiet = false) => {
            if (!tunnelId) return;
            setSurveying(true);
            try {
                const r = await longFetch<DeviceInstallView & { code?: string; error?: string }>(`/api/reverse/server/${tunnelId}/device-install/survey`, { method: "POST" }, { onCut: quiet ? undefined : onCut });
                const body = r.body;
                if (r.ok && body) {
                    setView({ id: tunnelId, view: body });
                    if (!quiet) showSuccess(t("deviceInstall.surveyed"));
                } else if (!quiet) {
                    showError(body?.code === "device_offline" ? t("deviceInstall.offline") : body?.code === "busy" ? t("deviceInstall.busy") : t("deviceInstall.surveyFailed", { error: body?.error ?? formatApiError(body, `HTTP ${r.status}`) }));
                }
            } catch (e) {
                if (!quiet) showError(e instanceof LongRequestLost ? t("api.cutNoResult") : e instanceof Error ? e.message : t("deviceInstall.surveyFailed", { error: "" }));
            } finally {
                setSurveying(false);
                void load();
            }
        },
        [tunnelId, load, onCut, showError, showSuccess, t]
    );

    useEffect(() => {
        if (isOpen && enabled) void load();
        if (!isOpen) {
            setView(null);
            setReport(null);
            setSteps([]);
        }
    }, [isOpen, enabled, load]);

    // 沒盤點過、裝置在線：打開時自動盤點一次。/ Never surveyed and online: survey once on open.
    useEffect(() => {
        if (!current || !tunnelId || !isOpen) return;
        if (current.surveyed_at || !current.online || current.busy || autoSurveyed.current === tunnelId) return;
        autoSurveyed.current = tunnelId;
        void survey(true);
    }, [current, tunnelId, isOpen, survey]);

    const handlers = useMemo(
        () => ({
            [NOTIFICATION_ACTIONS.DEVICE_INSTALL_UPDATED]: (msg: NotificationPayload) => {
                if (!isOpen || msg.tunnel_id !== tunnelId) return;
                const step = msg.step as ReportedStep["id"] | undefined;
                if (step && (RENAME_STEPS as readonly string[]).includes(step) && (msg.state === "done" || msg.state === "failed")) {
                    setSteps((prev) => (prev.some((s) => s.id === step) ? prev : [...prev, { id: step, state: msg.state as "done" | "failed" }]));
                } else if (!renaming && !surveying) void load();
            },
        }),
        [isOpen, tunnelId, renaming, surveying, load]
    );
    useNotificationHandlers(handlers);

    // 改名、拿掉多的那份、換連線方式：同一份步驟 / 回報結構，交接要等一兩分鐘，所以走 longFetch。
    // Rename, remove the extra copies, switch how it connects: one steps / report shape; a handover takes a minute or two.
    const change = useCallback(
        async (path: "rename" | "tidy" | "switch", init: RequestInit, successKey: TranslationKey | ((report: RenameReport) => TranslationKey)) => {
            if (!tunnelId || renaming) return;
            setRenaming(true);
            setSteps([]);
            setReport(null);
            try {
                const r = await longFetch<{ report?: RenameReport; view?: DeviceInstallView; code?: string; error?: string }>(`/api/reverse/server/${tunnelId}/device-install/${path}`, { method: "POST", ...init }, { onCut });
                const body = r.body;
                if (r.ok && body?.report) {
                    setReport(body.report);
                    setSteps(body.report.steps);
                    if (body.view) setView({ id: tunnelId, view: body.view });
                    if (body.report.ok) showSuccess(t(typeof successKey === "function" ? successKey(body.report) : successKey));
                    onChanged?.();
                } else {
                    setReport({ ok: false, steps: [], code: body?.code ?? "other", error: body?.error ?? formatApiError(body, `HTTP ${r.status}`), old: [] });
                }
            } catch (e) {
                setReport({ ok: false, steps: [], code: "other", error: e instanceof LongRequestLost ? t("api.cutNoResult") : e instanceof Error ? e.message : undefined, old: [] });
            } finally {
                setRenaming(false);
            }
        },
        [tunnelId, renaming, onChanged, onCut, showSuccess, t]
    );
    const rename = useCallback(() => change("rename", {}, "deviceInstall.renamed"), [change]);
    const tidy = useCallback(() => change("tidy", {}, "deviceInstall.tidied"), [change]);
    const switchTransport = useCallback(
        (transport: WayInSetup) => change("switch", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transport }) }, (r) => doneKeys(r.transport ?? transport, !!r.no_carrier).toast),
        [change]
    );

    const resetRename = useCallback(() => {
        setReport(null);
        setSteps([]);
    }, []);

    return { view: current, error, surveying, survey, renaming, steps, report, rename, tidy, switchTransport, resetRename, reload: load };
}

export type DeviceInstallState = ReturnType<typeof useDeviceInstall>;
