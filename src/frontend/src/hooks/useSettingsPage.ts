/**
 * 設定頁邏輯：載入/儲存站台設定、切換開關與錯誤處理。
 * Settings page logic: load/save site settings, toggle and error handling.
 *
 * API 回傳 { values, meta }：values 是各設定的值,meta 是每個設定的說明
 * (label / description / type),讓頁面顯示「這個設定是做什麼的」並選對編輯器。
 */
import { useState, useEffect } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export interface SettingMeta {
    label: string;
    description: string;
    type: "boolean" | "integer" | "string";
}

export function useSettingsPage() {
    const [settingsObj, setSettingsObj] = useState<Record<string, unknown>>({});
    const [meta, setMeta] = useState<Record<string, SettingMeta>>({});
    const [loading, setLoading] = useState(true);
    const { showSuccess, showError } = useToast();

    const fetchSettings = async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/site/settings");
            if (res.ok) {
                const data = await readJson(res);
                const obj = (data && typeof data === "object") ? data as Record<string, unknown> : {};
                setSettingsObj((obj.values && typeof obj.values === "object") ? obj.values as Record<string, unknown> : {});
                setMeta((obj.meta && typeof obj.meta === "object") ? obj.meta as Record<string, SettingMeta> : {});
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

    // 送出單一設定的更新;失敗時把畫面上的值還原。/ Persist one setting; roll back the UI on failure.
    const saveSetting = async (keyName: string, newValue: unknown, previous: unknown) => {
        setSettingsObj((prev) => ({ ...prev, [keyName]: newValue }));
        try {
            const res = await apiFetch("/api/site/settings", {
                method: "POST",
                body: JSON.stringify({ [keyName]: newValue }),
            });
            if (res.ok) {
                showSuccess("Setting updated");
            } else {
                setSettingsObj((prev) => ({ ...prev, [keyName]: previous }));
                const err = await readJson(res);
                showError(responseError(res, err, "Failed to update setting"));
            }
        } catch (e: unknown) {
            setSettingsObj((prev) => ({ ...prev, [keyName]: previous }));
            showError(e instanceof Error ? e.message : "Failed to update setting");
        }
    };

    const handleToggle = (keyName: string, currentValue: unknown) =>
        saveSetting(keyName, !currentValue, currentValue);

    const handleUpdate = (keyName: string, newValue: unknown) =>
        saveSetting(keyName, newValue, settingsObj[keyName]);

    return {
        state: { settingsObj, meta, loading },
        actions: { fetchSettings, handleToggle, handleUpdate },
    };
}
