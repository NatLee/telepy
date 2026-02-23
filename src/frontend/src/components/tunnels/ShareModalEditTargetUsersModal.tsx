/**
 * 分享彈窗內「編輯目標伺服器使用者」子彈窗。
 * Edit target server users sub-modal inside share modal.
 */
import React from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ReverseServerUsername } from "@/types/tunnel";

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
    if (!username) return null;

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={`Target Server Users Access - ${username}`} size="sm">
            <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                    Select which target server users <strong className="text-foreground">{username}</strong> is allowed to access.
                    Leave all unchecked to allow access to all users.
                </p>
                <div className="bg-muted/30 border border-border rounded-lg p-3 max-h-[300px] overflow-y-auto">
                    <div className="flex flex-col gap-2">
                        {tunnelUsernames.map((targetUser) => (
                            <label
                                key={targetUser.id}
                                className="flex items-center gap-3 text-sm bg-background border border-border rounded-md px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors"
                            >
                                <input
                                    type="checkbox"
                                    checked={(!!targetUser.created_by && targetUser.created_by === username) || allowedIds.includes(targetUser.id)}
                                    disabled={!!targetUser.created_by && targetUser.created_by === username}
                                    onChange={(e) => {
                                        if (e.target.checked) {
                                            onAllowedIdsChange([...allowedIds, targetUser.id]);
                                        } else {
                                            onAllowedIdsChange(allowedIds.filter((id) => id !== targetUser.id));
                                        }
                                    }}
                                    className="rounded w-4 h-4 text-primary disabled:opacity-50 disabled:cursor-not-allowed"
                                />
                                <code className="font-mono bg-muted/50 px-1 py-0.5 rounded">{targetUser.username}</code>
                                {targetUser.created_by && (
                                    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
                                        By: {targetUser.created_by} (#{targetUser.created_by_id})
                                    </span>
                                )}
                            </label>
                        ))}
                    </div>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={onClose}>Cancel</Button>
                    <Button onClick={onSave}>Save Changes</Button>
                </div>
            </div>
        </Modal>
    );
}
