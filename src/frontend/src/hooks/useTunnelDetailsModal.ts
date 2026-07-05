import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";

export function useTunnelDetailsModal(tunnelId: number | null, isOpen: boolean, onUpdate: () => void, onClose: () => void) {
    const { t } = useI18n();
    const [details, setDetails] = useState<any>(null);
    const [loading, setLoading] = useState(false);
    const [description, setDescription] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const [copiedKey, setCopiedKey] = useState(false);
    const { showSuccess, showError } = useToast();

    useEffect(() => {
        if (isOpen && tunnelId) {
            const fetchDetails = async () => {
                setLoading(true);
                try {
                    const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`);
                    if (res.ok) {
                        const data = await res.json();
                        setDetails(data);
                        setDescription(data.description || "");
                    } else {
                        showError(t("tunnelDetails.fetchFailed"));
                    }
                } catch (e: any) {
                    showError(e.message || t("tunnelDetails.fetchFailed"));
                } finally {
                    setLoading(false);
                }
            };
            fetchDetails();
        }
    }, [isOpen, tunnelId, showError]);

    const handleSaveDescription = async () => {
        if (!tunnelId) return;
        setIsSaving(true);
        try {
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`, {
                method: "PATCH",
                body: JSON.stringify({ description }),
            });
            if (res.ok) {
                showSuccess(t("tunnelDetails.descriptionUpdated"));
                onUpdate();
                onClose();
            } else {
                showError(t("tunnelDetails.descriptionUpdateFailed"));
            }
        } catch (e: any) {
            showError(e.message || t("tunnelDetails.descriptionUpdateFailed"));
        } finally {
            setIsSaving(false);
        }
    };

    const copyKey = () => {
        if (details?.key) {
            navigator.clipboard.writeText(details.key);
            setCopiedKey(true);
            setTimeout(() => setCopiedKey(false), 2000);
        }
    };

    return {
        state: {
            details,
            loading,
            description, setDescription,
            isSaving,
            copiedKey
        },
        actions: {
            handleSaveDescription,
            copyKey
        }
    };
}
