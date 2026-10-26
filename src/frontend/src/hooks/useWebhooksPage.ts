/**
 * Webhooks 頁的資料：我的 webhook、（管理員）全站 webhook、事件目錄與網站限制；新增 / 修改 / 刪除、開關、送測試、
 * 送出紀錄與簽章密鑰。範圍在網址上（`?scope=site`）。
 * Data for the Webhooks page: my webhooks, the site-wide ones (admins), the catalogue and the site's limits;
 * create / change / delete, on / off, test sends, delivery history and signing secrets. The scope is in the URL.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { NOTIFICATION_ACTIONS } from "@/lib/notificationActions";
import { useNotificationHandlers } from "@/lib/websocket";
import { errorKey } from "@/lib/webhooks";
import type { Webhook, WebhookDelivery, WebhookInput, WebhookList, WebhookScope, WebhookTestResult } from "@/types/webhooks";

/** 存檔時的欄位錯誤。/ Field errors from saving. */
export type WebhookErrors = Partial<Record<keyof WebhookInput | "form", string>>;

const FIELDS: (keyof WebhookInput)[] = ["name", "url", "format", "language", "events", "all_tunnels", "tunnel_ids", "delay", "enabled"];

export function useWebhooksPage() {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const router = useRouter();
    const params = useSearchParams();
    const [data, setData] = useState<WebhookList | null>(null);
    const [failed, setFailed] = useState(false);
    const [tunnels, setTunnels] = useState<{ id: number; name: string }[]>([]);
    const wantsSite = params.get("scope") === "site";
    const scope: WebhookScope = wantsSite && data?.can_manage_site ? "site" : "user";

    const setScope = useCallback((s: WebhookScope) => router.replace(s === "site" ? "/tunnels/webhooks?scope=site" : "/tunnels/webhooks"), [router]);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/webhooks");
            if (res.ok) setData((await res.json()) as WebhookList);
            setFailed(!res.ok);
        } catch {
            setFailed(true);
        }
    }, []);

    useEffect(() => {
        const first = setTimeout(() => void load(), 0);
        return () => clearTimeout(first);
    }, [load]);

    // 「只限這幾條隧道」的選單：我看得到的隧道。/ The "only these tunnels" picker: tunnels I can see.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await apiFetch("/api/reverse/server/dashboard");
                const body = await readJson<{ tunnels?: { id: number; host_friendly_name: string }[] }>(res);
                if (!cancelled && res.ok && Array.isArray(body?.tunnels)) {
                    setTunnels(body!.tunnels.map((x) => ({ id: x.id, name: x.host_friendly_name })).sort((a, b) => a.name.localeCompare(b.name)));
                }
            } catch {
                /* 只影響選單。/ Only the picker is affected. */
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // 一直失敗被暫停：重抓讓卡片跟上。/ A webhook was paused: refetch so the card catches up.
    useNotificationHandlers({ [NOTIFICATION_ACTIONS.WEBHOOK_PAUSED]: () => void load() });

    /** 新增或修改；欄位錯誤回給表單；新增成功回傳新的 webhook。/ Create or change; field errors go back to the form. */
    const save = async (input: WebhookInput, existing: Webhook | null): Promise<{ errors: WebhookErrors } | { saved: Webhook }> => {
        const res = await apiFetch(existing ? `/api/webhooks/${existing.id}` : "/api/webhooks", {
            method: existing ? "PATCH" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(existing ? { ...input, scope: undefined } : input),
        });
        const body = await readJson<Record<string, unknown>>(res);
        if (res.ok) {
            showSuccess(t(existing ? "webhooks.saved" : "webhooks.added"));
            await load();
            return { saved: (existing ? body : body?.webhook) as Webhook };
        }
        const errors: WebhookErrors = {};
        const coded = errorKey(body?.code);
        for (const k of FIELDS) {
            const v = body?.[k];
            if (Array.isArray(v) && typeof v[0] === "string") errors[k] = coded ? t(coded) : v[0];
        }
        if (Object.keys(errors).length === 0) errors.form = coded ? t(coded) : responseError(res, body, t("webhooks.saveFailed"));
        return { errors };
    };

    const setEnabled = async (h: Webhook, enabled: boolean) => {
        const res = await apiFetch(`/api/webhooks/${h.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) });
        if (!res.ok) showError(responseError(res, await readJson(res), t("webhooks.saveFailed")));
        await load();
    };

    const remove = async (h: Webhook) => {
        const res = await apiFetch(`/api/webhooks/${h.id}`, { method: "DELETE" });
        if (res.ok) showSuccess(t("webhooks.deleted", { name: h.name }));
        else showError(responseError(res, await readJson(res), t("webhooks.saveFailed")));
        await load();
    };

    /** 送測試；結果用 toast 說，也回傳給呼叫端。/ Send a test; the result is toasted and returned. */
    const sendTest = async (h: Webhook): Promise<WebhookTestResult | null> => {
        try {
            const res = await apiFetch(`/api/webhooks/${h.id}/test`, { method: "POST" });
            const body = await readJson<WebhookTestResult>(res);
            if (!res.ok || !body) {
                showError(responseError(res, body, t("webhooks.testFailed", { error: String(res.status) })));
                return null;
            }
            if (body.ok) showSuccess(t("webhooks.testOk", { name: h.name }));
            else showError(t("webhooks.testFailed", { error: body.error ?? (body.http_status ? `HTTP ${body.http_status}` : "") }));
            await load();
            return body;
        } catch (e) {
            showError(t("webhooks.testFailed", { error: e instanceof Error ? e.message : "" }));
            return null;
        }
    };

    const deliveries = useCallback(async (id: number): Promise<WebhookDelivery[] | null> => {
        try {
            const res = await apiFetch(`/api/webhooks/${id}/deliveries`);
            return res.ok ? ((await res.json()) as WebhookDelivery[]) : null;
        } catch {
            return null;
        }
    }, []);

    /** 讀或換簽章密鑰；失敗回 error 的翻譯。/ Read or rotate the signing secret. */
    const secret = useCallback(
        async (id: number, rotate: boolean): Promise<{ secret: string } | { error: string }> => {
            try {
                const res = await apiFetch(`/api/webhooks/${id}/secret`, { method: rotate ? "POST" : "GET" });
                const body = await readJson<{ secret?: string; code?: string }>(res);
                if (res.ok && body?.secret) return { secret: body.secret };
                const key = errorKey(body?.code);
                return { error: key ? t(key) : responseError(res, body, t("webhooks.secret.failed")) };
            } catch {
                return { error: t("webhooks.secret.failed") };
            }
        },
        [t],
    );

    const list = scope === "site" ? (data?.site ?? []) : (data?.mine ?? []);
    const catalog = (scope === "site" ? data?.catalog.site : data?.catalog.personal) ?? [];

    return { data, failed, scope, setScope, list, catalog, tunnels, reload: load, save, setEnabled, remove, sendTest, deliveries, secret };
}
