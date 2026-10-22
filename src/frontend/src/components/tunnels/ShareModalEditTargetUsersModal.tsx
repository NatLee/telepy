/**
 * 分享彈窗內「編輯目標伺服器使用者」子彈窗。
 * Edit target server users sub-modal inside share modal.
 */
import React from "react";
import { UserCog } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ReverseServerUsername } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";

export interface ShareModalEditTargetUsersModalProps {
    isOpen: boolean;
    username: string | null;
    allowedIds: number[];
    tunnelUsernames: ReverseServerUsername[];
    onClose: () => void;
    onSave: () => void;
    /** 僅傳入非「自己建立」的使用者 id 變更；created_by 與 username 相同者由後端視為必含。 Only non-self-created user id changes; backend treats self-created as always allowed. */
    onAllowedIdsChange: (allowedIds: number[]) => void;
}

export function ShareModalEditTargetUsersModal({
    isOpen,
    username,
    allowedIds,
    tunnelUsernames,
    onClose,
    onSave,
    onAllowedIdsChange,
}: ShareModalEditTargetUsersModalProps) {
    const { t, tn } = useI18n();
    if (!username) return null;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("share.editTargetTitle", { username })}
            description={tn("share.editTargetBody", { username: <strong>{username}</strong> })}
            icon={<UserCog />}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button onClick={onSave}>{t("common.saveChanges")}</Button>
                </>
            }
        >
            <div className="flex flex-col divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                {tunnelUsernames.map((targetUser) => {
                    const selfCreated = !!targetUser.created_by && targetUser.created_by === username;
                    return (
                        <label
                            key={targetUser.id}
                            className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-sm transition-colors hover:bg-surface has-disabled:cursor-not-allowed"
                        >
                            <input
                                type="checkbox"
                                checked={selfCreated || allowedIds.includes(targetUser.id)}
                                disabled={selfCreated}
                                onChange={(e) => {
                                    if (e.target.checked) {
                                        onAllowedIdsChange([...allowedIds, targetUser.id]);
                                    } else {
                                        onAllowedIdsChange(allowedIds.filter((id) => id !== targetUser.id));
                                    }
                                }}
                                className="size-4 accent-primary disabled:opacity-50"
                            />
                            <code className="font-mono text-foreground">{targetUser.username}</code>
                            {targetUser.created_by && (
                                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[0.75rem] text-muted-foreground">
                                    {t("common.byUserTag", { user: targetUser.created_by, id: targetUser.created_by_id ?? "" })}
                                </span>
                            )}
                        </label>
                    );
                })}
            </div>
        </Modal>
    );
}
