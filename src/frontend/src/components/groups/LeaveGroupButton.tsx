"use client";

import React, { useState } from "react";
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useI18n } from "@/lib/i18n";

/**
 * 退出別人的個人群組：任何人都能把你加進去，所以你一定能自己退出。經由它拿到的通道（不只這條）都會收回。
 * Leave someone's personal group: anyone can add you, so you can always leave. Every tunnel held through it goes.
 */
export function LeaveGroupButton({ groupId, name, owner, onLeft }: { groupId: number; name: string; owner: string; onLeft: () => void }) {
    const { t } = useI18n();
    const { showSuccess, showError } = useToast();
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const leave = async () => {
        setAsking(false);
        setBusy(true);
        try {
            const res = await apiFetch(`/api/user/groups/${groupId}/membership`, { method: "DELETE" });
            if (res.ok) {
                showSuccess(t("share.group.leftGroup", { name }));
                onLeft();
            } else {
                showError(responseError(res, await readJson(res), t("share.group.leaveGroupFailed")));
            }
        } catch (e) {
            showError((e instanceof Error && e.message) || t("share.group.leaveGroupFailed"));
        } finally {
            setBusy(false);
        }
    };
    return (
        <>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAsking(true)}>
                <LogOut size={14} /> {t("share.group.leave")}
            </Button>
            <ConfirmDialog
                isOpen={asking}
                onClose={() => setAsking(false)}
                onConfirm={() => void leave()}
                title={t("share.group.leaveTitle", { name, owner })}
                message={t("share.group.leaveMessage", { owner })}
                confirmText={t("share.group.leave")}
                isDestructive
            />
        </>
    );
}
