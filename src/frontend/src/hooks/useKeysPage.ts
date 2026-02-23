import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { isValidSSHKey, getHostFriendlyNameFromKey } from "@/lib/utils";
import { useViewMode } from "@/hooks/useViewMode";

export function useKeysPage() {
    const { showSuccess, showError } = useToast();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [keys, setKeys] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useViewMode("ssh-keys-view");

    // Modals state
    const [addModalOpen, setAddModalOpen] = useState(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [detailsModal, setDetailsModal] = useState<{ isOpen: boolean, key: any }>({ isOpen: false, key: null });
    const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean, keyId: number | null, name: string }>({ isOpen: false, keyId: null, name: "" });

    // Add Key Form state
    const [newKeyContent, setNewKeyContent] = useState("");
    const [newKeyName, setNewKeyName] = useState("");
    const [newKeyDescription, setNewKeyDescription] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Edit Description state
    const [editDescription, setEditDescription] = useState("");
    const [isUpdating, setIsUpdating] = useState(false);
    const [isEditingDesc, setIsEditingDesc] = useState(false);

    const fetchKeys = useCallback(async () => {
        setLoading(true);
        try {
            const res = await apiFetch("/api/reverse/user/keys");
            if (res.ok) {
                setKeys(await res.json());
            } else {
                showError("Failed to fetch keys");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to fetch keys");
        } finally {
            setLoading(false);
        }
    }, [showError]);

    useEffect(() => {
        fetchKeys();
    }, [fetchKeys]);

    const handleKeyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const key = e.target.value;
        setNewKeyContent(key);
        if (!newKeyName && isValidSSHKey(key)) {
            setNewKeyName(getHostFriendlyNameFromKey(key, ""));
        }
    };

    const handleAddKey = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!isValidSSHKey(newKeyContent)) {
            showError("Invalid SSH Public Key format.");
            return;
        }
        setIsSubmitting(true);
        try {
            const payload = {
                key: newKeyContent,
                host_friendly_name: newKeyName || "Unnamed Key",
                description: newKeyDescription,
            };

            const tokenRes = await apiFetch("/api/reverse/issue/token");
            if (!tokenRes.ok) throw new Error("Failed to get issue token");
            const { token } = await tokenRes.json();

            const createRes = await apiFetch(`/api/reverse/create/key/${token}`, {
                method: "POST",
                body: JSON.stringify(payload),
            });

            if (createRes.ok) {
                showSuccess("Key added successfully");
                setAddModalOpen(false);
                setNewKeyContent("");
                setNewKeyName("");
                setNewKeyDescription("");
                fetchKeys();
            } else {
                const err = await createRes.json();
                showError(err.error || "Failed to add key");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to add key");
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteConfirm.keyId) return;
        try {
            const res = await apiFetch(`/api/reverse/user/keys/${deleteConfirm.keyId}`, {
                method: "DELETE",
            });
            if (res.ok) {
                showSuccess(`Key '${deleteConfirm.name}' deleted`);
                fetchKeys();
                setDeleteConfirm({ isOpen: false, keyId: null, name: "" });
            } else {
                showError("Failed to delete key");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to delete key");
        }
    };

    const handleUpdateDescription = async () => {
        if (!detailsModal.key?.id) return;
        setIsUpdating(true);
        try {
            const res = await apiFetch(`/api/reverse/user/keys/${detailsModal.key.id}`, {
                method: "PATCH",
                body: JSON.stringify({ description: editDescription }),
            });
            if (res.ok) {
                showSuccess("Description updated");
                setDetailsModal({ isOpen: false, key: null });
                fetchKeys();
            } else {
                showError("Failed to update description");
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
            showError(e.message || "Failed to update description");
        } finally {
            setIsUpdating(false);
        }
    };

    return {
        state: {
            keys, setKeys,
            loading, setLoading,
            viewMode, setViewMode,
            addModalOpen, setAddModalOpen,
            detailsModal, setDetailsModal,
            deleteConfirm, setDeleteConfirm,
            newKeyContent, setNewKeyContent,
            newKeyName, setNewKeyName,
            newKeyDescription, setNewKeyDescription,
            isSubmitting, setIsSubmitting,
            editDescription, setEditDescription,
            isUpdating, setIsUpdating,
            isEditingDesc, setIsEditingDesc
        },
        actions: {
            fetchKeys,
            handleKeyChange,
            handleAddKey,
            handleDelete,
            handleUpdateDescription
        }
    };
}
