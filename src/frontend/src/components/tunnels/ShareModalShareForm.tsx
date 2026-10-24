/**
 * 分享彈窗內的新增分享表單：選擇使用者、目標伺服器使用者限制。
 * Share form inside share modal: select user and target server user restrictions.
 */
import React from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReverseServerUsername } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import type { ShareExpiryPreset } from "@/lib/shareExpiry";
import { ShareExpiryChoice } from "@/components/tunnels/ShareExpiry";

export interface ShareModalShareFormProps {
    selectedUser: string;
    setSelectedUser: (v: string) => void;
    availableUsers: { id: number; username: string }[];
    tunnelUsernames: ReverseServerUsername[];
    selectedAllowedIds: number[];
    setSelectedAllowedIds: React.Dispatch<React.SetStateAction<number[]>>;
    expiryPreset: ShareExpiryPreset;
    setExpiryPreset: (p: ShareExpiryPreset) => void;
    expiryDate: string;
    setExpiryDate: (d: string) => void;
    onShare: (e: React.FormEvent) => void;
}

export function ShareModalShareForm({
    selectedUser,
    setSelectedUser,
    availableUsers,
    tunnelUsernames,
    selectedAllowedIds,
    setSelectedAllowedIds,
    expiryPreset,
    setExpiryPreset,
    expiryDate,
    setExpiryDate,
    onShare,
}: ShareModalShareFormProps) {
    const { t } = useI18n();
    return (
        <form onSubmit={onShare} className="space-y-3">
            <div className="flex gap-2">
                <Select
                    value={selectedUser}
                    onValueChange={setSelectedUser}
                    disabled={availableUsers.length === 0}
                >
                    <SelectTrigger className="flex-1">
                        <SelectValue placeholder={availableUsers.length === 0 ? t("share.noAvailableUsers") : t("share.selectUser")} />
                    </SelectTrigger>
                    <SelectContent>
                        {availableUsers.map((availableUser) => (
                            <SelectItem key={availableUser.id} value={availableUser.id.toString()}>
                                {availableUser.username}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button type="submit" disabled={!selectedUser || (expiryPreset === "date" && !expiryDate)}>
                    <UserPlus />
                    {t("share.share")}
                </Button>
            </div>
            {selectedUser && (
                <div className="space-y-4 rounded-xl bg-surface p-3.5 ring-1 ring-inset ring-border/80">
                    {tunnelUsernames.length > 0 && (
                        <div>
                            <p className="mb-2.5 text-xs text-muted-foreground">{t("share.allowLabel")}</p>
                            <div className="flex flex-wrap gap-2">
                                {tunnelUsernames.map((targetUser) => (
                                    <label key={targetUser.id} className="flex cursor-pointer items-center gap-2 rounded-full bg-card px-3 py-1.5 text-xs ring-1 ring-inset ring-border transition-colors hover:ring-foreground/20 has-checked:bg-primary/10 has-checked:text-primary has-checked:ring-primary/40">
                                        <input
                                            type="checkbox"
                                            checked={selectedAllowedIds.includes(targetUser.id)}
                                            onChange={(e) => {
                                                if (e.target.checked) {
                                                    setSelectedAllowedIds(prev => [...prev, targetUser.id]);
                                                } else {
                                                    setSelectedAllowedIds(prev => prev.filter(id => id !== targetUser.id));
                                                }
                                            }}
                                            className="size-3.5 accent-primary"
                                        />
                                        <code className="font-mono">{targetUser.username}</code>
                                        {targetUser.created_by && (
                                            <span className="rounded-full bg-muted px-1.5 py-px text-[0.6875rem] text-muted-foreground">
                                                {t("common.byUserTag", { user: targetUser.created_by, id: targetUser.created_by_id ?? "" })}
                                            </span>
                                        )}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}
                    <ShareExpiryChoice preset={expiryPreset} date={expiryDate} onPreset={setExpiryPreset} onDate={setExpiryDate} />
                </div>
            )}
        </form>
    );
}
