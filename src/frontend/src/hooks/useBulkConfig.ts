import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { keysToAdd, splitBulkConfig, type BulkAccounts, type BulkConfigData } from "@/lib/bulkSshConfig";
import type { KeyDevice, UserKey } from "@/types/keys";

const ACCOUNTS_KEY = "telepy.sshConfigAccounts";

function readAccounts(): BulkAccounts {
    try {
        return localStorage.getItem(ACCOUNTS_KEY) === "all" ? "all" : "default";
    } catch {
        return "default";
    }
}

/**
 * 「多台裝置的 SSH config」：一次抓我能登入的每一台（勾選在前端做，切換不必再問後端），加上金鑰矩陣（我的金鑰在每台
 * 的狀態，跟著 DEVICE-KEYS-UPDATED 重抓）與「把我的金鑰補到這些裝置」。對話框打開時才掛載，所以每次打開都重抓。
 * 帳號模式記在 localStorage。
 * The bulk SSH config: every device I can log in to in one request (ticking happens client-side, no refetch), the
 * key matrix (my keys on each device, refetched on DEVICE-KEYS-UPDATED) and "add my keys to these devices". Mounted
 * only while the dialog is open, so every open fetches afresh. The accounts mode is kept in localStorage.
 */
export function useBulkConfig() {
    const { t } = useI18n();
    const { showError, showSuccess } = useToast();
    const [accounts, setAccountsState] = useState<BulkAccounts>(readAccounts);
    const [transport, setTransport] = useState<"ssh" | "websocket">("ssh");
    // 哪個 (帳號模式, 傳輸) 的結果；跟目前的不同 = 載入中。/ Which (accounts, transport) a result is for.
    const [result, setResult] = useState<{ key: string; data: BulkConfigData } | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const [devices, setDevices] = useState<KeyDevice[] | null>(null);
    const [myKeys, setMyKeys] = useState<UserKey[] | null>(null);
    const [adding, setAdding] = useState(false);
    const key = `${accounts}|${transport}`;

    const setAccounts = (v: BulkAccounts) => {
        setAccountsState(v);
        try {
            localStorage.setItem(ACCOUNTS_KEY, v);
        } catch { /* 忽略 / ignore */ }
    };

    useEffect(() => {
        let stale = false;
        const params = new URLSearchParams({ accounts });
        if (transport === "websocket") params.set("transport", "websocket");
        apiFetch(`/tunnels/server/config?${params}`)
            .then(async (res) => {
                if (stale) return;
                if (!res.ok) throw new Error(t("config.loadFailed"));
                const data: BulkConfigData = await res.json();
                if (!stale) setResult({ key, data });
            })
            .catch((e) => {
                if (stale) return;
                setFailedKey(key);
                showError((e instanceof Error && e.message) || t("config.loadFailedGeneric"));
            });
        return () => {
            stale = true;
        };
    }, [key, accounts, transport, showError, t]);

    const loadDevices = useCallback(
        () =>
            apiFetch("/api/reverse/user/keys/devices")
                .then(async (res) => res.ok && setDevices(await res.json()))
                .catch(() => { /* 金鑰狀態只是輔助 / key state is only a hint */ }),
        []
    );

    useEffect(() => {
        apiFetch("/api/reverse/user/keys/devices")
            .then(async (res) => res.ok && setDevices(await res.json()))
            .catch(() => {});
        apiFetch("/api/reverse/user/keys")
            .then(async (res) => setMyKeys(res.ok ? await res.json() : []))
            .catch(() => setMyKeys([]));
    }, []);

    // 通知一次來很多（每台一則），合併成一次重抓。/ Notifications arrive per device; fold them into one refetch.
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const scheduleDevices = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(loadDevices, 600);
    }, [loadDevices]);
    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);
    useNotificationHandlers({
        [NOTIFICATION_ACTIONS.DEVICE_KEYS_UPDATED]: scheduleDevices,
        [NOTIFICATION_ACTIONS.TUNNEL_USERNAMES_UPDATED]: scheduleDevices,
    });

    const deviceMap = useMemo(() => new Map((devices ?? []).map((d) => [d.tunnel_id, d])), [devices]);
    const data = result?.data ?? null;
    const loading = result?.key !== key && failedKey !== key;
    const split = useMemo(() => (data ? splitBulkConfig(data) : null), [data]);

    /** 把我所有的金鑰加到這些裝置的清單（已在的略過），一次 4 台。/ Add all my keys to these devices' lists, 4 at a time. */
    const addMyKeys = useCallback(
        async (tunnelIds: number[]) => {
            const ids = (myKeys ?? []).map((k) => k.id);
            const jobs = tunnelIds.map((id) => ({ id, keys: keysToAdd(deviceMap.get(id), ids) })).filter((j) => j.keys.length > 0);
            if (jobs.length === 0) return;
            setAdding(true);
            let failed = 0;
            const queue = [...jobs];
            const worker = async () => {
                for (let job = queue.shift(); job; job = queue.shift()) {
                    try {
                        const res = await apiFetch(`/api/reverse/server/${job.id}/device-keys`, { method: "POST", body: JSON.stringify({ user_key_ids: job.keys }) });
                        if (!res.ok) failed += 1;
                    } catch {
                        failed += 1;
                    }
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
            setAdding(false);
            await loadDevices();
            if (failed > 0) showError(t("config.bulk.addFailed", { count: failed }));
            else showSuccess(t("config.bulk.added", { count: jobs.length }));
        },
        [myKeys, deviceMap, loadDevices, showError, showSuccess, t]
    );

    return { data, split, loading, accounts, setAccounts, transport, setTransport, deviceMap, devicesLoaded: devices !== null, myKeys, adding, addMyKeys };
}
