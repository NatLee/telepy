/**
 * 分享彈窗內的「目前已分享」列表與操作。
 * Currently shared-with list and actions inside share modal.
 */
import React from "react";
import { Share2, Pencil, X, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ReverseServerUsername } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { ShareExpiryControl } from "@/components/tunnels/ShareExpiry";

export interface SharedUserRow {
    id: number;
    username: string;
    permission_type?: string;
    can_admin_tunnel?: boolean;
    can_edit_tunnel?: boolean;
    allowed_target_usernames?: { id: number }[];
    /** 分享到期時間（UTC ISO）；null = 一直有效。/ When the share ends (UTC ISO); null = never. */
    expires_at?: string | null;
}

export interface ShareModalSharedListProps {
    loading: boolean;
    sharedUsers: SharedUserRow[];
    readOnly: boolean;
    tunnelUsernames: ReverseServerUsername[];
    onEditTargetUsers: (payload: { userId: number; username: string; allowedIds: number[] }) => void;
    onUpdatePermission: (userId: number, value: string) => void;
    onUpdateExpiry: (userId: number, expiresAt: string | null) => Promise<boolean>;
    onUnshare: (payload: { userId: number; username: string }) => void;
}

export function ShareModalSharedList({
    loading,
    sharedUsers,
    readOnly,
    tunnelUsernames,
    onEditTargetUsers,
    onUpdatePermission,
    onUpdateExpiry,
    onUnshare,
}: ShareModalSharedListProps) {
    const { t } = useI18n();
    if (loading) return null;
    if (sharedUsers.length === 0) {
        return (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-8 text-center">
                <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                    <Share2 size={20} />
                </span>
                <p className="text-sm text-muted-foreground">{t("share.notShared")}</p>
            </div>
        );
    }

    return (
        <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                {t("share.currentlySharedWith")}
                <span className="rounded-full bg-muted px-1.5 py-px tabular-nums normal-case tracking-normal">{sharedUsers.length}</span>
            </h3>
            <ul className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-border/80">
                {sharedUsers.map((sharedUser) => {
                    const allowedCount = sharedUser.allowed_target_usernames?.length ?? 0;
                    const canEditTargets = !readOnly && tunnelUsernames.length > 0;
                    return (
                        <li key={sharedUser.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 transition-colors hover:bg-surface">
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-sm text-background uppercase" aria-hidden>
                                    {sharedUser.username.slice(0, 1)}
                                </span>
                                <span className="flex min-w-0 flex-col items-start">
                                    <span className="max-w-full truncate text-sm text-foreground">{sharedUser.username}</span>
                                    <ShareExpiryControl
                                        expiresAt={sharedUser.expires_at}
                                        editable={!readOnly}
                                        onChange={(value) => onUpdateExpiry(sharedUser.id, value)}
                                    />
                                </span>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={!canEditTargets}
                                    onClick={() =>
                                        onEditTargetUsers({
                                            userId: sharedUser.id,
                                            username: sharedUser.username,
                                            allowedIds: sharedUser.allowed_target_usernames?.map((a) => a.id) || [],
                                        })
                                    }
                                    className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground ring-1 ring-inset ring-border transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-default"
                                    title={canEditTargets ? t("share.editAllowedUsers") : t("share.thTargetUsers")}
                                >
                                    <UserCog size={14} aria-hidden />
                                    <span>{t("share.thTargetUsers")}</span>
                                    <span className="tabular-nums text-foreground">{allowedCount}</span>
                                    {canEditTargets && <Pencil size={12} aria-hidden />}
                                </button>
                                <Select
                                    value={sharedUser.permission_type || (sharedUser.can_admin_tunnel ? "admin" : sharedUser.can_edit_tunnel ? "edit" : "view")}
                                    onValueChange={(val) => onUpdatePermission(sharedUser.id, val)}
                                    disabled={readOnly}
                                >
                                    <SelectTrigger size="sm" className="w-[104px] text-xs" aria-label={t("share.thPermission")}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="view">{t("share.permView")}</SelectItem>
                                        <SelectItem value="edit">{t("share.permEdit")}</SelectItem>
                                        <SelectItem value="admin">{t("share.permAdmin")}</SelectItem>
                                    </SelectContent>
                                </Select>
                                {!readOnly && (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onUnshare({ userId: sharedUser.id, username: sharedUser.username })}
                                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                        title={t("share.unshareTitle")}
                                        aria-label={t("share.unshareTitle")}
                                    >
                                        <X />
                                    </Button>
                                )}
                            </div>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
