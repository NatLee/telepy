/**
 * 設定頁邏輯：載入/儲存站台設定、切換開關與錯誤處理。
 * Settings page logic: load/save site settings, toggle and error handling.
 */
import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export function useSettingsPage() {
    const [settingsObj, setSettingsObj] = useState<Record<string, unknown>>({});
    const [loading, setLoading] = useState(true);
    const { showSuccess, showError } = useToast();

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/site/settings");
            if (res.ok) {
                const data = await res.json();
                setSettingsObj(typeof data === "object" && data !== null ? data : {});
            } else {
                showError("Failed to fetch settings");
            }
        } catch (e: unknown) {
            showError(e instanceof Error ? e.message : "Failed to fetch settings");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchSettings();
    }, []);

    const handleToggle = async (keyName: string, currentValue: unknown) => {
        const newValue = !currentValue;
        setSettingsObj((prev) => ({ ...prev, [keyName]: newValue }));

        try {
            const res = await apiFetch("/api/site/settings", {
                method: "POST",
                body: JSON.stringify({ [keyName]: newValue }),
            });
            if (res.ok) {
                showSuccess("Setting updated");
            } else {
                setSettingsObj((prev) => ({ ...prev, [keyName]: currentValue }));
                const err = await res.json();
                showError((err as { error?: string }).error || "Failed to update setting");
            }
        } catch (e: unknown) {
            setSettingsObj((prev) => ({ ...prev, [keyName]: currentValue }));
            showError(e instanceof Error ? e.message : "Failed to update setting");
        }
    };

    return {
        state: { settingsObj, loading },
        actions: { fetchSettings, handleToggle },
    };
}
