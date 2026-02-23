import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";

export function useTunnelDetailsModal(tunnelId: number | null, isOpen: boolean, onUpdate: () => void, onClose: () => void) {
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
                        showError("Failed to fetch tunnel details");
                    }
                } catch (e: any) {
                    showError(e.message || "Failed to fetch tunnel details");
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
                showSuccess("Description updated");
                onUpdate();
                onClose();
            } else {
                showError("Failed to update description");
            }
        } catch (e: any) {
            showError(e.message || "Failed to update description");
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
