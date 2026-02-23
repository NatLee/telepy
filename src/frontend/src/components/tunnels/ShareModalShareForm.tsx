/**
 * 分享彈窗內的新增分享表單：選擇使用者、目標伺服器使用者限制。
 * Share form inside share modal: select user and target server user restrictions.
 */
import React from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReverseServerUsername } from "@/types/tunnel";

export interface ShareModalShareFormProps {
    selectedUser: string;
    setSelectedUser: (v: string) => void;
    availableUsers: { id: number; username: string }[];
    tunnelUsernames: ReverseServerUsername[];
    selectedAllowedIds: number[];
    setSelectedAllowedIds: React.Dispatch<React.SetStateAction<number[]>>;
    onShare: (e: React.FormEvent) => void;
}

export function ShareModalShareForm({
    selectedUser,
    setSelectedUser,
    availableUsers,
    tunnelUsernames,
    selectedAllowedIds,
    setSelectedAllowedIds,
    onShare,
}: ShareModalShareFormProps) {
    return (
        <form onSubmit={onShare} className="space-y-3">
            <div className="flex gap-2">
                <Select
                    value={selectedUser}
                    onValueChange={setSelectedUser}
                    disabled={availableUsers.length === 0}
                >
                    <SelectTrigger className="flex-1">
                        <SelectValue placeholder={availableUsers.length === 0 ? "No available users to share with" : "-- Select User --"} />
                    </SelectTrigger>
                    <SelectContent>
                        {availableUsers.map((availableUser) => (
                            <SelectItem key={availableUser.id} value={availableUser.id.toString()}>
                                {availableUser.username}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button type="submit" disabled={!selectedUser}>
                    <UserPlus size={16} className="mr-2" />
                    Share
                </Button>
            </div>
            {selectedUser && tunnelUsernames.length > 0 && (
                <div className="bg-muted/30 border border-border rounded-lg p-3">
                    <p className="text-xs font-medium text-muted-foreground mb-2">Restrict to specific Target Server Users:</p>
                    <div className="flex flex-wrap gap-2">
                        {tunnelUsernames.map((targetUser) => (
                            <label key={targetUser.id} className="flex items-center gap-1.5 text-xs bg-background border border-border rounded px-2 py-1 cursor-pointer hover:bg-muted/50 transition-colors">
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
                                    className="rounded"
                                />
                                <code className="font-mono">{targetUser.username}</code>
                                {targetUser.created_by && (
                                    <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/50">
                                        By: {targetUser.created_by} (#{targetUser.created_by_id})
                                    </span>
                                )}
                            </label>
                        ))}
                    </div>
                </div>
            )}
        </form>
    );
}
