import { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { TargetUser } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import { parseStanzas } from "@/lib/sshConfig";
import { firstAccount, toggleAccount } from "@/lib/bulkSshConfig";
import { saveAliasPrefix } from "@/lib/aliasPrefix";
import type { TunnelConfigData } from "@/hooks/useCheatsheetPage";

/**
 * 「反向伺服器設定」視窗：勾選帳號的 ~/.ssh/config 區塊（伺服器 + 每個帳號一個裝置區塊；只勾一個時別名就是裝置名稱），
 * 加上「金鑰進不進得去」與裝置是否在線（裝置金鑰清單，跟著通知即時更新）。一開始勾隧道的預設帳號（能用時），否則第一個。
 * The SSH config dialog: stanzas for the ticked accounts (server + one device stanza per account; one ticked = the
 * device name as the alias), plus whether your key can get in and whether the device is online (device key list,
 * kept live by notifications). Starts with the tunnel's default account when usable, else the first.
 */
export function useConfigModal(isOpen: boolean, tunnelId: number | null) {
    const { t } = useI18n();
    const [data, setData] = useState<TunnelConfigData | null>(null);
    const [loading, setLoading] = useState(false);
    const [targetUsers, setTargetUsers] = useState<TargetUser[]>([]);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    // 筆電怎麼連 Telepy：SSH port，或只開網頁 port 時包進 WebSocket。/ How the laptop reaches Telepy.
    const [transport, setTransport] = useState<"ssh" | "websocket">("ssh");
    const { showError } = useToast();
    const deviceKeys = useDeviceKeys(isOpen ? tunnelId : null);

    /** `ids` = null：第一次，拿帳號清單並決定先勾哪個。/ `ids` = null: the first load, which picks the first account. */
    const fetchConfig = useCallback(async (ids: number[] | null, via: "ssh" | "websocket") => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (ids) params.set("username_ids", ids.join(","));
            if (via === "websocket") params.set("transport", "websocket");
            const res = await apiFetch(`/tunnels/server/config/${tunnelId}${params.size ? `?${params.toString()}` : ""}`);
            if (!res.ok) {
                showError(t("config.loadFailed"));
                return;
            }
            const body: TunnelConfigData = await res.json();
            if (ids === null) {
                const users: TargetUser[] = body.usernames ?? [];
                setTargetUsers(users);
                const first = firstAccount(users.map((u) => u.id), body.default_username_id);
                setSelectedIds(first);
                if (first.length > 0) {
                    // 用選好的帳號再抓一次。/ Fetch again with the picked account.
                    setLoading(false);
                    fetchConfig(first, via);
                    return;
                }
            }
            setData(body);
        } catch (e) {
            showError((e instanceof Error && e.message) || t("config.loadFailedGeneric"));
        } finally {
            setLoading(false);
        }
    }, [tunnelId, showError, t]);

    useEffect(() => {
        if (isOpen && tunnelId) {
            setTargetUsers([]);
            setSelectedIds([]);
            setTransport("ssh");
            setData(null);
            fetchConfig(null, "ssh");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const order = useMemo(() => targetUsers.map((u) => u.id), [targetUsers]);
    const choose = (ids: number[]) => {
        setSelectedIds(ids);
        fetchConfig(ids, transport);
    };
    const toggleUser = (id: number) => choose(toggleAccount(selectedIds, id, order));
    const selectAllUsers = () => choose(order);

    /** 存前綴，成功就用新的別名重抓。/ Save the prefix and refetch with the new aliases. */
    const savePrefix = async (prefix: string) => {
        const err = await saveAliasPrefix(prefix, t("config.prefix.saveFailed"));
        if (!err) await fetchConfig(selectedIds.length ? selectedIds : null, transport);
        return err;
    };

    const handleTransportChange = (value: "ssh" | "websocket") => {
        setTransport(value);
        fetchConfig(selectedIds.length ? selectedIds : null, value);
    };

    // 伺服器區塊 = 別名等於後端給的 server.alias，其餘是裝置區塊（每個帳號一個）。
    // The server stanza is the one named server.alias; the rest are device stanzas (one per account).
    const stanzas = useMemo(() => (data ? parseStanzas(data.config) : []), [data]);
    const serverStanza = stanzas.find((s) => s.alias === data?.server.alias) ?? null;
    const deviceStanzas = stanzas.filter((s) => s !== serverStanza);

    return {
        state: {
            data,
            loading,
            targetUsers,
            selectedIds,
            stanzas,
            serverStanza,
            deviceStanzas,
            deviceKeys,
            transport,
        },
        actions: {
            toggleUser,
            selectAllUsers,
            handleTransportChange,
            savePrefix,
        }
    };
}
