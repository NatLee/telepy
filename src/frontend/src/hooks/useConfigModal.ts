import { useState, useEffect, useCallback, useMemo } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { TargetUser } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { useDeviceKeys } from "@/hooks/useDeviceKeys";
import { parseStanzas } from "@/lib/sshConfig";
import type { TunnelConfigData } from "@/hooks/useCheatsheetPage";

/**
 * 「反向伺服器設定」視窗：選定帳號的 ~/.ssh/config 區塊（伺服器 + 裝置），加上「金鑰進不進得去」與裝置是否在線
 * （裝置金鑰清單，跟著通知即時更新）。
 * The SSH config dialog: the ~/.ssh/config stanzas for the selected account (server + device), plus whether your
 * key can get in and whether the device is online (from the device key list, kept live by notifications).
 */
export function useConfigModal(isOpen: boolean, tunnelId: number | null) {
    const { t } = useI18n();
    const [data, setData] = useState<TunnelConfigData | null>(null);
    const [loading, setLoading] = useState(false);
    const [targetUsers, setTargetUsers] = useState<TargetUser[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string>("");
    // 筆電怎麼連 Telepy：SSH port，或只開網頁 port 時包進 WebSocket。/ How the laptop reaches Telepy.
    const [transport, setTransport] = useState<"ssh" | "websocket">("ssh");
    const { showError } = useToast();
    const deviceKeys = useDeviceKeys(isOpen ? tunnelId : null);

    const fetchConfig = useCallback(async (usernameId?: string, via: "ssh" | "websocket" = transport) => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (usernameId && usernameId !== "all") params.set("username_id", usernameId);
            if (via === "websocket") params.set("transport", "websocket");
            const url = `/tunnels/server/config/${tunnelId}${params.size ? `?${params.toString()}` : ""}`;
            const res = await apiFetch(url);
            if (res.ok) {
                const body: TunnelConfigData = await res.json();
                const users: TargetUser[] = body.usernames ?? [];

                // On initial load (no usernameId), populate users and auto-select first
                if (!usernameId) {
                    setTargetUsers(users);
                    if (users.length > 0) {
                        // Auto-select first user and re-fetch with that filter
                        const firstId = String(users[0].id);
                        setSelectedUserId(firstId);
                        // Re-fetch with the first user selected
                        setLoading(false);
                        fetchConfig(firstId);
                        return;
                    } else {
                        // No target users — just show server-only config
                        setSelectedUserId("");
                    }
                }

                setData(body);
            } else {
                showError(t("config.loadFailed"));
            }
        } catch (e) {
            showError((e instanceof Error && e.message) || t("config.loadFailedGeneric"));
        } finally {
            setLoading(false);
        }
    }, [tunnelId, transport, showError, t]);

    useEffect(() => {
        if (isOpen && tunnelId) {
            setTargetUsers([]);
            setSelectedUserId("");
            setTransport("ssh");
            setData(null);
            fetchConfig(undefined, "ssh");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const handleUserChange = (value: string) => {
        setSelectedUserId(value);
        fetchConfig(value);
    };

    const handleTransportChange = (value: "ssh" | "websocket") => {
        setTransport(value);
        fetchConfig(selectedUserId || undefined, value);
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
            selectedUserId,
            stanzas,
            serverStanza,
            deviceStanzas,
            deviceKeys,
            transport,
        },
        actions: {
            handleUserChange,
            handleTransportChange,
        }
    };
}
