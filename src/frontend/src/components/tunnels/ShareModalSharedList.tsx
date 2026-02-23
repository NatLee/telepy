/**
 * 分享彈窗內的「目前已分享」列表與操作。
 * Currently shared-with list and actions inside share modal.
 */
import React from "react";
import { Share2, Edit2, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReverseServerUsername } from "@/types/tunnel";

export interface SharedUserRow {
    id: number;
    username: string;
    permission_type?: string;
    can_admin_tunnel?: boolean;
    can_edit_tunnel?: boolean;
    allowed_target_usernames?: { id: number }[];
}

export interface ShareModalSharedListProps {
    loading: boolean;
    sharedUsers: SharedUserRow[];
    readOnly: boolean;
    tunnelUsernames: ReverseServerUsername[];
    onEditTargetUsers: (payload: { userId: number; username: string; allowedIds: number[] }) => void;
    onUpdatePermission: (userId: number, value: string) => void;
    onUnshare: (payload: { userId: number; username: string }) => void;
}

export function ShareModalSharedList({
    loading,
    sharedUsers,
    readOnly,
    tunnelUsernames,
    onEditTargetUsers,
    onUpdatePermission,
    onUnshare,
}: ShareModalSharedListProps) {
    if (loading) return null;
    if (sharedUsers.length === 0) {
        return (
            <div className="bg-card border border-border rounded-md overflow-hidden">
                <div className="p-8 text-center text-muted-foreground flex flex-col items-center">
                    <Share2 size={32} className="text-muted mb-2 opacity-50" />
                    <p>This tunnel is not shared with anyone.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-card border border-border rounded-md overflow-hidden">
            <div className="overflow-x-auto">
                <div className="bg-muted/40 px-4 py-2 border-b border-border text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Currently Shared With
                </div>
                <table className="min-w-full divide-y divide-border table-fixed">
                    <thead className="bg-muted/20 border-b border-border">
                        <tr>
                            <th className={`px-4 py-3 text-left ${readOnly ? "w-[45%]" : "w-[30%]"} text-xs font-medium text-muted-foreground uppercase tracking-wider`}>User</th>
                            <th className="px-4 py-3 text-center w-[30%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Target Users</th>
                            <th className="px-4 py-3 text-center w-[25%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Permission</th>
                            {!readOnly && <th className="px-4 py-3 text-right w-[15%] text-xs font-medium text-muted-foreground uppercase tracking-wider">Action</th>}
                        </tr>
                    </thead>
                    <tbody className="bg-card divide-y divide-border">
                        {sharedUsers.map((sharedUser) => (
                            <tr key={sharedUser.id} className="hover:bg-muted/50 transition-colors">
                                <td className="px-4 py-3 text-sm font-medium text-foreground">
                                    <div>{sharedUser.username}</div>
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                    <div className="flex items-center justify-center gap-1.5">
                                        <span className="text-xs text-muted-foreground">
                                            {sharedUser.allowed_target_usernames?.length ? `${sharedUser.allowed_target_usernames.length}` : "0"}
                                        </span>
                                        {!readOnly && tunnelUsernames.length > 0 && (
                                            <button
                                                onClick={() =>
                                                    onEditTargetUsers({
                                                        userId: sharedUser.id,
                                                        username: sharedUser.username,
                                                        allowedIds: sharedUser.allowed_target_usernames?.map((a) => a.id) || [],
                                                    })
                                                }
                                                className="text-muted-foreground hover:text-foreground p-1 bg-muted/30 hover:bg-muted/50 rounded transition-colors"
                                                title="Edit allowed target users"
                                            >
                                                <Edit2 size={12} />
                                            </button>
                                        )}
                                    </div>
                                </td>
                                <td className="px-4 py-3 whitespace-nowrap text-center">
                                    <div className="inline-block text-left">
                                        <Select
                                            value={sharedUser.permission_type || (sharedUser.can_admin_tunnel ? "admin" : sharedUser.can_edit_tunnel ? "edit" : "view")}
                                            onValueChange={(val) => onUpdatePermission(sharedUser.id, val)}
                                            disabled={readOnly}
                                        >
                                            <SelectTrigger className="h-8 w-[100px] text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="view">View</SelectItem>
                                                <SelectItem value="edit">Edit</SelectItem>
                                                <SelectItem value="admin">Admin</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </td>
                                {!readOnly && (
                                    <td className="px-4 py-3 whitespace-nowrap text-right">
                                        <button
                                            onClick={() => onUnshare({ userId: sharedUser.id, username: sharedUser.username })}
                                            className="text-destructive hover:text-destructive/90 transition-colors bg-destructive/10 hover:bg-destructive/20 p-1.5 rounded-md"
                                            title="Unshare Tunnel"
                                        >
                                            <X size={16} />
                                        </button>
                                    </td>
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
