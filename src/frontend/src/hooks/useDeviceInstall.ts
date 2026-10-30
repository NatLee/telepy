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
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS, type NotificationPayload } from "@/types/notification";
import { RENAME_STEPS, type DeviceInstallView, type RenameReport, type ReportedStep } from "@/lib/deviceInstall";

export function useDeviceInstall(tunnelId: number | null, isOpen: boolean, enabled: boolean, onChanged?: () => void) {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
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

    const survey = useCallback(
        async (quiet = false) => {
            if (!tunnelId) return;
            setSurveying(true);
            try {
                const res = await apiFetch(`/api/reverse/server/${tunnelId}/device-install/survey`, { method: "POST" });
                const body = await readJson<DeviceInstallView & { code?: string; error?: string }>(res);
                if (res.ok && body) {
                    setView({ id: tunnelId, view: body });
                    if (!quiet) showSuccess(t("deviceInstall.surveyed"));
                } else if (!quiet) {
                    showError(body?.code === "device_offline" ? t("deviceInstall.offline") : body?.code === "busy" ? t("deviceInstall.busy") : t("deviceInstall.surveyFailed", { error: body?.error ?? responseError(res, body, "") }));
                }
            } catch (e) {
                if (!quiet) showError(e instanceof Error ? e.message : t("deviceInstall.surveyFailed", { error: "" }));
            } finally {
                setSurveying(false);
                void load();
            }
        },
        [tunnelId, load, showError, showSuccess, t]
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

    const rename = useCallback(async () => {
        if (!tunnelId || renaming) return;
        setRenaming(true);
        setSteps([]);
        setReport(null);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/device-install/rename`, { method: "POST" });
            const body = await readJson<{ report?: RenameReport; view?: DeviceInstallView; code?: string; error?: string }>(res);
            if (res.ok && body?.report) {
                setReport(body.report);
                setSteps(body.report.steps);
                if (body.view) setView({ id: tunnelId, view: body.view });
                if (body.report.ok) showSuccess(t("deviceInstall.renamed"));
                onChanged?.();
            } else {
                const code = body?.code ?? "other";
                setReport({ ok: false, steps: [], code, error: body?.error, old: [] });
            }
        } catch (e) {
            setReport({ ok: false, steps: [], code: "other", error: e instanceof Error ? e.message : undefined, old: [] });
        } finally {
            setRenaming(false);
        }
    }, [tunnelId, renaming, onChanged, showSuccess, t]);

    // 拿掉多出來的那份：同一份步驟 / 回報結構（三步）。/ Remove the extra copies: same steps / report shape (three steps).
    const tidy = useCallback(async () => {
        if (!tunnelId || renaming) return;
        setRenaming(true);
        setSteps([]);
        setReport(null);
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/device-install/tidy`, { method: "POST" });
            const body = await readJson<{ report?: RenameReport; view?: DeviceInstallView; code?: string; error?: string }>(res);
            if (res.ok && body?.report) {
                setReport(body.report);
                setSteps(body.report.steps);
                if (body.view) setView({ id: tunnelId, view: body.view });
                if (body.report.ok) showSuccess(t("deviceInstall.tidied"));
                onChanged?.();
            } else {
                setReport({ ok: false, steps: [], code: body?.code ?? "other", error: body?.error, old: [] });
            }
        } catch (e) {
            setReport({ ok: false, steps: [], code: "other", error: e instanceof Error ? e.message : undefined, old: [] });
        } finally {
            setRenaming(false);
        }
    }, [tunnelId, renaming, onChanged, showSuccess, t]);

    const resetRename = useCallback(() => {
        setReport(null);
        setSteps([]);
    }, []);

    return { view: current, error, surveying, survey, renaming, steps, report, rename, tidy, resetRename, reload: load };
}
