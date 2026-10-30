import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LaptopTransport } from "@/lib/transportInfo";
import { apiFetch } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/components/ui/Toast";
import { useNotificationHandlers } from "@/lib/websocket";
import { NOTIFICATION_ACTIONS } from "@/types/notification";
import { pickParam, planIsEmpty, splitBulkConfig, type BulkAccounts, type BulkConfigData, type KeyPlan } from "@/lib/bulkSshConfig";
import { saveAliasPrefix } from "@/lib/aliasPrefix";
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
    const [transport, setTransport] = useState<LaptopTransport>("ssh");
    // 哪個 (帳號模式, 傳輸) 的結果；跟目前的不同 = 載入中。/ Which (accounts, transport) a result is for.
    const [result, setResult] = useState<{ key: string; data: BulkConfigData } | null>(null);
    const [failedKey, setFailedKey] = useState<string | null>(null);
    const [devices, setDevices] = useState<KeyDevice[] | null>(null);
    const [myKeys, setMyKeys] = useState<UserKey[] | null>(null);
    const [adding, setAdding] = useState(false);
    // 逐台挑的帳號（只放改過的那幾台；其餘照上面的模式）。/ Per-device accounts (only the changed ones; others follow the mode).
    const [picks, setPicks] = useState<Record<number, number[]>>({});
    const pick = pickParam(picks);
    // 存了新前綴就加一，逼它重抓（別名都變了）。/ Bumped after a new prefix is saved, to refetch (every alias changed).
    const [reload, setReload] = useState(0);
    const key = `${accounts}|${transport}|${pick}|${reload}`;

    const savePrefix = async (prefix: string) => {
        const err = await saveAliasPrefix(prefix, t("config.prefix.saveFailed"));
        if (!err) setReload((n) => n + 1);
        return err;
    };

    const setDeviceAccounts = (tunnelId: number, ids: number[]) => setPicks((prev) => ({ ...prev, [tunnelId]: ids }));

    // 換模式 = 全部照新的模式重來，逐台的選擇清掉。/ A new mode starts every device over; per-device picks are cleared.
    const setAccounts = (v: BulkAccounts) => {
        setPicks({});
        setAccountsState(v);
        try {
            localStorage.setItem(ACCOUNTS_KEY, v);
        } catch { /* 忽略 / ignore */ }
    };

    useEffect(() => {
        let stale = false;
        const params = new URLSearchParams({ accounts });
        if (transport !== "ssh") params.set("transport", transport);
        if (pick) params.set("pick", pick);
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
    }, [key, accounts, transport, pick, showError, t]);

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

    /**
     * 照每台的計畫把我的金鑰放上去（只裝到 config 用的帳號；帳號不夠的加寬），一次 4 台。
     * Place my keys on these devices by each one's plan (only the accounts the config uses; widen narrower ones), 4 at a time.
     */
    const addMyKeys = useCallback(
        async (plans: { id: number; plan: KeyPlan }[]) => {
            const jobs = plans.filter((j) => !planIsEmpty(j.plan));
            if (jobs.length === 0) return;
            setAdding(true);
            let failed = 0;
            const queue = [...jobs];
            const send = async ({ id, plan }: { id: number; plan: KeyPlan }) => {
                if (plan.add.length > 0) {
                    const res = await apiFetch(`/api/reverse/server/${id}/device-keys`, { method: "POST", body: JSON.stringify({ user_key_ids: plan.add, accounts: plan.addAccounts }) });
                    if (!res.ok) return false;
                }
                for (const w of plan.widen) {
                    const res = await apiFetch(`/api/reverse/server/${id}/device-keys/${w.keyId}`, { method: "PATCH", body: JSON.stringify({ accounts: w.accounts }) });
                    if (!res.ok) return false;
                }
                return true;
            };
            const worker = async () => {
                for (let job = queue.shift(); job; job = queue.shift()) {
                    try {
                        if (!(await send(job))) failed += 1;
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
        [loadDevices, showError, showSuccess, t]
    );

    return { data, split, loading, accounts, setAccounts, transport, setTransport, picks, setDeviceAccounts, savePrefix, deviceMap, devicesLoaded: devices !== null, myKeys, adding, addMyKeys };
}
