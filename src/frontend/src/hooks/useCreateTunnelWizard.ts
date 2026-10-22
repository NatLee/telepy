/**
 * 建立通道精靈邏輯：裝置 → 登入帳號 → 授權 Telepy → 連線 → 驗證。
 * Create-tunnel wizard logic: device → login accounts → authorize Telepy → connect → verify.
 * - Step 1 送出才建立通道（取得 id / reverse_port）；建立後 Step 1 鎖定，返回不會再建一條。
 *   The tunnel is created when step 1 is submitted; afterwards step 1 is read-only so Back never creates a second one.
 * - Step 4 的一次性網址用 /tunnels/server/script/one-time/token（單次、10 分鐘）。
 *   Step 4 one-liners use single-use, 10-minute script URLs.
 * - Step 5 以 /api/sftp/shell/{id}/{username} 實際透過隧道登入每個帳號（與網頁終端機同一條路）。
 *   Step 5 really logs in as each account through the tunnel via /api/sftp/shell (the web terminal's path).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useTunnelConnectionWebSocket } from "@/lib/websocket";
import { useI18n } from "@/lib/i18n";
import {
    checkPublicKey,
    classifyLoginError,
    isValidTunnelName,
    oneTimeCommand,
    type ConnectMethod,
    type DeviceOs,
    type LoginFailure,
} from "@/lib/tunnelSetup";

export type WizardStep = 1 | 2 | 3 | 4 | 5;

export interface CreatedTunnel {
    id: number;
    reversePort: number;
    name: string;
}

export interface Account {
    id: number;
    username: string;
}

export interface PublicKeyItem {
    id: number;
    name: string;
    key: string;
}

export interface LoginCheck {
    state: "idle" | "checking" | "ok" | "fail";
    failure?: LoginFailure;
    message?: string;
    shell?: string;
}

export interface DeviceErrors {
    key?: string;
    name?: string;
    port?: string;
}

interface OneTime {
    command: string;
    loading: boolean;
    error?: string;
}

const isPort = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 65535;

export function useCreateTunnelWizard() {
    const { showSuccess, showError } = useToast();
    const { t } = useI18n();

    const [step, setStepState] = useState<WizardStep>(1);
    const [maxStep, setMaxStep] = useState<WizardStep>(1);

    // ── Step 1：裝置 / Device ──
    const [sshKey, setSshKey] = useState("");
    const [hostName, setHostName] = useState("");
    const [nameTouched, setNameTouched] = useState(false);
    const [sshPort, setSshPort] = useState("22");
    const [errors, setErrors] = useState<DeviceErrors>({});
    const [creating, setCreating] = useState(false);
    const [created, setCreated] = useState<CreatedTunnel | null>(null);
    const keyCheck = useMemo(() => checkPublicKey(sshKey), [sshKey]);

    // ── Step 2：登入帳號 / Login accounts ──
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [newAccount, setNewAccount] = useState("");
    const [addingAccount, setAddingAccount] = useState(false);

    // ── Step 3：授權金鑰 / Authorize keys ──
    const [serviceKeys, setServiceKeys] = useState<PublicKeyItem[]>([]);
    const [userKeys, setUserKeys] = useState<PublicKeyItem[]>([]);
    const [keysLoading, setKeysLoading] = useState(false);
    const [excludedUserKeys, setExcludedUserKeys] = useState<Set<number>>(new Set());
    const [deviceOs, setDeviceOs] = useState<DeviceOs>("unix");

    // ── Step 4：連線 / Connect ──
    const [method, setMethod] = useState<ConnectMethod>("autossh-service");
    const [serviceAccountId, setServiceAccountId] = useState<number | null>(null);
    const [oneTime, setOneTime] = useState<Record<string, OneTime>>({});
    const [scripts, setScripts] = useState<Record<string, string>>({});
    const { status } = useTunnelConnectionWebSocket(created ? String(created.id) : null);
    const connected = status?.is_connected === true;
    const rttMs: number | null = typeof status?.rtt_ms === "number" ? status.rtt_ms : null;

    // ── Step 5：驗證 / Verify ──
    const [checks, setChecks] = useState<Record<string, LoginCheck>>({});
    const [configContent, setConfigContent] = useState("");
    const [configLoading, setConfigLoading] = useState(false);

    const setStep = useCallback((next: WizardStep) => {
        setStepState(next);
        setMaxStep((m) => (next > m ? next : m));
    }, []);

    /** 已到過的步驟才能點；建立通道前只能停在 Step 1。/ Only visited steps are reachable; nothing past step 1 before creation. */
    const goTo = useCallback((next: WizardStep) => {
        if (next <= maxStep && (next === 1 || created)) setStepState(next);
    }, [maxStep, created]);

    // ── Step 1 ──
    const onKeyChange = (value: string) => {
        setSshKey(value);
        setErrors((e) => ({ ...e, key: undefined }));
        const parsed = checkPublicKey(value);
        // 名稱沒被手動改過時，跟著公鑰註解走。/ Follow the key comment until the user edits the name.
        if (!nameTouched && parsed.kind === "valid" && parsed.comment) setHostName(parsed.comment);
    };
    const onNameChange = (value: string) => {
        setHostName(value);
        setNameTouched(true);
        setErrors((e) => ({ ...e, name: undefined }));
    };
    const onPortChange = (value: string) => {
        setSshPort(value.replace(/\D/g, "").slice(0, 5));
        setErrors((e) => ({ ...e, port: undefined }));
    };

    const submitDevice = async (e: React.FormEvent) => {
        e.preventDefault();
        if (created) {
            setStep(2);
            return;
        }
        const next: DeviceErrors = {};
        if (keyCheck.kind === "empty") next.key = t("wizard.device.keyRequired");
        else if (keyCheck.kind === "private") next.key = t("wizard.device.keyPrivate");
        else if (keyCheck.kind === "invalid") next.key = t("wizard.device.keyInvalid");
        const name = hostName.trim();
        if (!name) next.name = t("wizard.device.nameRequired");
        else if (!isValidTunnelName(name)) next.name = t("wizard.device.nameLetter");
        if (!isPort(sshPort)) next.port = t("wizard.device.portInvalid");
        setErrors(next);
        if (Object.keys(next).length > 0 || keyCheck.kind !== "valid") return;

        setCreating(true);
        try {
            const tokenRes = await apiFetch("/api/reverse/issue/token");
            const tokenData = await readJson<{ token?: string }>(tokenRes);
            if (!tokenRes.ok || !tokenData?.token) throw new Error(t("wizard.issueTokenFailed"));
            const payload = { key: keyCheck.normalized, host_friendly_name: name, ssh_port: Number(sshPort) };

            // 先查重複，給欄位上的友善訊息（建立時的 UNIQUE 錯誤很難讀）。
            // Check duplicates first for friendly field errors (the create call's UNIQUE error is cryptic).
            const dupRes = await apiFetch(`/api/reverse/create/key/duplicate/${tokenData.token}`, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            if (!dupRes.ok) {
                const dup = await readJson<{ host_friendly_name_exists?: boolean; key_exists?: boolean }>(dupRes);
                if (dup?.host_friendly_name_exists || dup?.key_exists) {
                    setErrors({
                        name: dup.host_friendly_name_exists ? t("wizard.device.nameTaken") : undefined,
                        key: dup.key_exists ? t("wizard.device.keyTaken") : undefined,
                    });
                    return;
                }
            }

            const res = await apiFetch(`/api/reverse/create/key/${tokenData.token}`, {
                method: "POST",
                body: JSON.stringify(payload),
            });
            const data = await readJson<{ id?: number; reverse_port?: number; host_friendly_name?: string }>(res);
            if (!res.ok || !data?.id || !data.reverse_port) {
                showError(responseError(res, data, t("wizard.createFailed")));
                return;
            }
            setCreated({ id: data.id, reversePort: data.reverse_port, name: data.host_friendly_name ?? name });
            showSuccess(t("wizard.tunnelCreated", { name, port: data.reverse_port }));
            setStep(2);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            showError(err?.message || t("wizard.createFailed"));
        } finally {
            setCreating(false);
        }
    };

    // ── Step 2 ──
    const fetchAccounts = useCallback(async (tunnelId: number) => {
        try {
            const res = await apiFetch(`/api/reverse/server/${tunnelId}/usernames`);
            if (!res.ok) return;
            const data = await res.json();
            const list: Account[] = data?.usernames ?? (Array.isArray(data) ? data : (data?.results ?? []));
            setAccounts(list.map((u) => ({ id: u.id, username: u.username })));
        } catch (err) {
            console.error(err);
        }
    }, []);

    const addAccount = async (raw: string) => {
        const username = raw.trim();
        if (!username || !created) return;
        if (accounts.some((a) => a.username === username)) {
            showError(t("wizard.accounts.duplicate", { name: username }));
            return;
        }
        setAddingAccount(true);
        try {
            const res = await apiFetch(`/api/reverse/server/usernames`, {
                method: "POST",
                body: JSON.stringify({ reverse_server: created.id, username }),
            });
            if (res.ok) {
                setNewAccount("");
                await fetchAccounts(created.id);
            } else {
                showError(responseError(res, await readJson(res), t("wizard.addUserFailed")));
            }
        } finally {
            setAddingAccount(false);
        }
    };

    const removeAccount = async (account: Account) => {
        if (!created) return;
        try {
            const res = await apiFetch(`/api/reverse/server/usernames/${account.id}`, { method: "DELETE" });
            if (res.ok) {
                setChecks((c) => {
                    const rest = { ...c };
                    delete rest[account.username];
                    return rest;
                });
                await fetchAccounts(created.id);
            } else {
                showError(responseError(res, await readJson(res), t("wizard.removeUserFailed")));
            }
        } catch (err) {
            console.error(err);
        }
    };

    // ── Step 3 ──
    const fetchKeys = useCallback(async () => {
        setKeysLoading(true);
        try {
            const [uRes, sRes] = await Promise.all([apiFetch("/api/reverse/user/keys"), apiFetch("/api/reverse/service/keys")]);
            type RawKey = { id: number; host_friendly_name?: string; service?: string; key?: string };
            const toItems = (rows: RawKey[] | null, fallback: (n: number) => string): PublicKeyItem[] =>
                (rows ?? [])
                    .filter((r) => r.key)
                    .map((r, i) => ({ id: r.id, name: r.host_friendly_name || r.service || fallback(i + 1), key: (r.key ?? "").trim() }));
            if (uRes.ok) setUserKeys(toItems(await readJson<RawKey[]>(uRes), (n) => t("wizard.userKeyN", { n })));
            if (sRes.ok) setServiceKeys(toItems(await readJson<RawKey[]>(sRes), (n) => t("wizard.serviceKeyN", { n })));
        } catch (err) {
            console.error(err);
        } finally {
            setKeysLoading(false);
        }
    }, [t]);

    const toggleUserKey = (id: number) => {
        setExcludedUserKeys((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const authorizedKeys = useMemo(
        () => [...serviceKeys.map((k) => k.key), ...userKeys.filter((k) => !excludedUserKeys.has(k.id)).map((k) => k.key)],
        [serviceKeys, userKeys, excludedUserKeys],
    );

    useEffect(() => {
        if (!created) return;
        fetchAccounts(created.id);
        fetchKeys();
    }, [created, fetchAccounts, fetchKeys]);

    // ── Step 4 ──
    // autossh-service 以哪個帳號執行：預設第一個，帳號被刪掉時跟著換。
    // Which account runs the systemd service: the first one by default, re-picked when it is removed.
    useEffect(() => {
        if (accounts.length === 0) setServiceAccountId(null);
        else if (!accounts.some((a) => a.id === serviceAccountId)) setServiceAccountId(accounts[0].id);
    }, [accounts, serviceAccountId]);

    const needsAccount = method === "autossh-service";
    const scriptKey = `${method}|${sshPort}|${needsAccount ? serviceAccountId ?? "" : ""}`;
    const scriptReady = !!created && isPort(sshPort) && (!needsAccount || serviceAccountId !== null);

    const generateOneTime = useCallback(async () => {
        if (!created || !scriptReady) return;
        const key = scriptKey;
        setOneTime((m) => ({ ...m, [key]: { command: m[key]?.command ?? "", loading: true } }));
        try {
            const body: Record<string, unknown> = { server_id: created.id, ssh_port: Number(sshPort), script_type: method };
            if (needsAccount && serviceAccountId !== null) body.username_id = serviceAccountId;
            const res = await apiFetch("/tunnels/server/script/one-time/token", { method: "POST", body: JSON.stringify(body) });
            const data = await readJson<{ url?: string }>(res);
            if (!res.ok || !data?.url) throw new Error(responseError(res, data, t("scripts.generateUrlFailed")));
            setOneTime((m) => ({ ...m, [key]: { command: oneTimeCommand(method, data.url!), loading: false } }));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            setOneTime((m) => ({ ...m, [key]: { command: "", loading: false, error: err?.message || t("scripts.generateUrlFailed") } }));
        }
    }, [created, scriptReady, scriptKey, sshPort, method, needsAccount, serviceAccountId, t]);

    const loadScript = useCallback(async () => {
        if (!created || !scriptReady || scripts[scriptKey] !== undefined) return;
        const key = scriptKey;
        const qs = needsAccount && serviceAccountId !== null ? `?username_id=${serviceAccountId}` : "";
        try {
            const res = await apiFetch(`/tunnels/server/script/${method}/${created.id}/${sshPort}${qs}`);
            const data = await readJson<{ script?: string }>(res);
            setScripts((m) => ({ ...m, [key]: res.ok ? (data?.script ?? "") : responseError(res, data, t("scripts.loadFailed")) }));
        } catch {
            setScripts((m) => ({ ...m, [key]: t("scripts.loadFailed") }));
        }
    }, [created, scriptReady, scripts, scriptKey, method, sshPort, needsAccount, serviceAccountId, t]);

    // 進到 Step 4 或換方式時自動產生一次性指令（每個組合一次；用過可按「新連結」再產生）。
    // 稍等一下再發：打埠號時不要每個按鍵都換一張 token。
    // Generate the one-liner when step 4 opens or the method changes (once per combination; "New link" re-issues it).
    // Debounced so typing a port doesn't mint a token per keystroke.
    useEffect(() => {
        if (step !== 4 || !scriptReady || oneTime[scriptKey]) return;
        const timer = setTimeout(generateOneTime, 350);
        return () => clearTimeout(timer);
    }, [step, scriptReady, scriptKey, oneTime, generateOneTime]);

    // ── Step 5 ──
    const checksRef = useRef(checks);
    useEffect(() => {
        checksRef.current = checks;
    }, [checks]);

    const checkLogin = useCallback(async (username: string) => {
        if (!created) return;
        setChecks((c) => ({ ...c, [username]: { state: "checking" } }));
        try {
            const res = await apiFetch(`/api/sftp/shell/${created.id}/${encodeURIComponent(username)}`);
            const data = await readJson<{ shell?: string }>(res);
            if (res.ok) {
                setChecks((c) => ({ ...c, [username]: { state: "ok", shell: data?.shell } }));
            } else {
                const message = responseError(res, data, t("wizard.verify.loginFailed"));
                setChecks((c) => ({ ...c, [username]: { state: "fail", failure: classifyLoginError(message), message } }));
            }
        } catch {
            setChecks((c) => ({ ...c, [username]: { state: "fail", failure: "other", message: t("wizard.verify.loginFailed") } }));
        }
    }, [created, t]);

    const checkAll = useCallback(() => {
        accounts.forEach((a) => checkLogin(a.username));
    }, [accounts, checkLogin]);

    // 裝置一上線（或帳號清單變了）就自動檢查還沒通過的帳號。
    // As soon as the device is online (or the account list changes), check every account that has not passed yet.
    useEffect(() => {
        if (step !== 5 || !connected) return;
        accounts.forEach((a) => {
            const c = checksRef.current[a.username];
            if (!c || c.state === "idle" || (c.state === "fail" && c.failure === "offline")) checkLogin(a.username);
        });
    }, [step, connected, accounts, checkLogin]);

    useEffect(() => {
        if (step !== 5 || !created) return;
        let cancelled = false;
        (async () => {
            setConfigLoading(true);
            try {
                const res = await apiFetch(`/tunnels/server/config/${created.id}`);
                const data = await readJson<{ config?: string }>(res);
                if (!cancelled) setConfigContent(res.ok ? (data?.config || t("wizard.noConfig")) : t("wizard.configError"));
            } catch {
                if (!cancelled) setConfigContent(t("wizard.configError"));
            } finally {
                if (!cancelled) setConfigLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [step, created, accounts, t]);

    const allLoginsOk = accounts.length > 0 && accounts.every((a) => checks[a.username]?.state === "ok");

    return {
        step, maxStep, setStep, goTo,
        created, connected, rttMs,
        device: {
            sshKey, onKeyChange, keyCheck,
            hostName, onNameChange,
            sshPort, onPortChange,
            errors, creating, submitDevice,
        },
        accounts: {
            list: accounts, newAccount, setNewAccount, adding: addingAccount, add: addAccount, remove: removeAccount,
            suggestedFromKey: keyCheck.kind === "valid" ? keyCheck.comment : "",
        },
        keys: {
            serviceKeys, userKeys, loading: keysLoading, excludedUserKeys, toggleUserKey, authorizedKeys,
            deviceOs, setDeviceOs,
        },
        connect: {
            method, setMethod,
            serviceAccountId, setServiceAccountId, needsAccount,
            sshPort, onPortChange, scriptReady,
            oneTime: oneTime[scriptKey] ?? null, generateOneTime,
            script: scripts[scriptKey], loadScript,
        },
        verify: { checks, checkLogin, checkAll, allLoginsOk, configContent, configLoading },
    };
}

export type CreateTunnelWizard = ReturnType<typeof useCreateTunnelWizard>;
