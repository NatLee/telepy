import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { TargetUser } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";

export function useConfigModal(isOpen: boolean, tunnelId: number | null) {
    const { t } = useI18n();
    const [configContent, setConfigContent] = useState<string>("");
    const [loading, setLoading] = useState(false);
    const [targetUsers, setTargetUsers] = useState<TargetUser[]>([]);
    const [selectedUserId, setSelectedUserId] = useState<string>("");
    const { showError } = useToast();

    const fetchConfig = useCallback(async (usernameId?: string) => {
        if (!tunnelId) return;
        setLoading(true);
        try {
            let url = `/tunnels/server/config/${tunnelId}`;
            if (usernameId && usernameId !== "all") {
                url += `?username_id=${usernameId}`;
            }
            const res = await apiFetch(url);
            if (res.ok) {
                const data = await res.json();
                const users: TargetUser[] = data.usernames ?? [];

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

                setConfigContent(data.config ?? t("config.noConfig"));
            } else {
                showError(t("config.loadFailed"));
            }
        } catch (e: any) {
            showError(e.message || t("config.loadFailedGeneric"));
        } finally {
            setLoading(false);
        }
    }, [tunnelId, showError, t]);

    useEffect(() => {
        if (isOpen && tunnelId) {
            setTargetUsers([]);
            setSelectedUserId("");
            setConfigContent("");
            fetchConfig();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    const handleUserChange = (value: string) => {
        setSelectedUserId(value);
        fetchConfig(value);
    };

    return {
        state: {
            configContent,
            loading,
            targetUsers,
            selectedUserId
        },
        actions: {
            handleUserChange
        }
    };
}
