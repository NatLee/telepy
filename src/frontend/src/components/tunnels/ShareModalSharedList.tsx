/**
 * 分享彈窗內的「目前已分享」列表與操作。
 * Currently shared-with list and actions inside share modal.
 */
import React, { useState } from "react";
import { Search, Share2, Pencil, X, UserCog, Users, UserRoundCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Pagination } from "@/components/ui/pagination";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { SHARED_CONTROLS_FROM, sharedUsersView, type SharedBucket } from "@/lib/sharedUsers";
import { ReverseServerUsername } from "@/types/tunnel";
import { useI18n } from "@/lib/i18n";
import { ShareExpiryControl } from "@/components/tunnels/ShareExpiry";
import { TemporaryGrantText } from "@/components/tunnels/AccessRequests";

export interface SharedUserRow {
    id: number;
    username: string;
    permission_type?: string;
    can_admin_tunnel?: boolean;
    can_edit_tunnel?: boolean;
    allowed_target_usernames?: { id: number; username?: string; until?: string | null }[];
    /** 存取申請暫時提升了權限：到什麼時候、之後回到哪個。/ A temporary raise: until when, and what comes after. */
    permission_until?: string | null;
    base_permission?: string | null;
    /** 分享到期時間（UTC ISO）；null = 一直有效。/ When the share ends (UTC ISO); null = never. */
    expires_at?: string | null;
    /** 經由哪個使用者群組（null = 直接分享給他）。/ The user group it comes through (null = shared directly). */
    via_group?: { group_share_id: number; group_id: number; name: string } | null;
}

export interface ShareModalSharedListProps {
    loading: boolean;
    sharedUsers: SharedUserRow[];
    readOnly: boolean;
    /** 「分享隧道」功能被關掉：不能改權限 / 帳號 / 期限，但還是可以取消分享。/ Sharing turned off: no edits, unsharing still works. */
    locked?: boolean;
    tunnelUsernames: ReverseServerUsername[];
    onEditTargetUsers: (payload: { userId: number; username: string; allowedIds: number[] }) => void;
    onUpdatePermission: (userId: number, value: string) => void;
    onUpdateExpiry: (userId: number, expiresAt: string | null) => Promise<boolean>;
    onUnshare: (payload: { userId: number; username: string }) => void;
    /** 把經由群組的分享改成他自己的（之後照這裡的設定）。/ Turn a share through a group into their own. */
    onOwnShare?: (row: SharedUserRow) => void;
    /** 到「群組」分頁。/ Go to the Groups tab. */
    onGroups?: () => void;
}

export function ShareModalSharedList({
    loading,
    sharedUsers,
    readOnly,
    locked = false,
    tunnelUsernames,
    onEditTargetUsers,
    onUpdatePermission,
    onUpdateExpiry,
    onUnshare,
    onOwnShare,
    onGroups,
}: ShareModalSharedListProps) {
    const { t } = useI18n();
    // 分享給群組後可能上百人：搜尋、直接 / 經由群組分類，再分頁。/ A group share can bring in hundreds: search, buckets, pages.
    const [query, setQuery] = useState("");
    const [bucket, setBucket] = useState<SharedBucket>("all");
    const controls = sharedUsers.length >= SHARED_CONTROLS_FROM;
    const grouped = sharedUsers.some((u) => u.via_group);
    const view = sharedUsersView(sharedUsers, controls ? query : "", controls && grouped ? bucket : "all");
    const pager = usePagination(view.shown.length, { storageKey: "telepy.sharedUsersPageSize", resetKey: `${query}|${bucket}` });
    const rows = pageSlice(view.shown, pager.page, pager.size);
    const buckets: { value: SharedBucket; label: string }[] = [
        { value: "all", label: `${t("share.list.all")} (${view.counts.all})` },
        { value: "direct", label: `${t("share.list.direct")} (${view.counts.direct})` },
        { value: "group", label: `${t("share.list.group")} (${view.counts.group})` },
    ];
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
            {controls && (
                <div className="mb-2.5 flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[10rem] flex-1 basis-full sm:basis-auto">
                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("share.list.search")} aria-label={t("share.list.search")} className="h-8 pl-8" />
                    </div>
                    {grouped && (
                        <>
                            <NativeSelect value={bucket} onChange={(e) => setBucket(e.target.value as SharedBucket)} aria-label={t("share.list.bucketAria")} className="h-8 w-auto max-w-full text-xs sm:hidden">
                                {buckets.map((b) => (
                                    <option key={b.value} value={b.value}>{b.label}</option>
                                ))}
                            </NativeSelect>
                            <Segmented size="sm" fullWidth className="hidden w-full sm:grid" value={bucket} onChange={setBucket} aria-label={t("share.list.bucketAria")} options={buckets} />
                        </>
                    )}
                </div>
            )}
            {view.shown.length === 0 && (
                <p className="rounded-xl border border-dashed border-border py-5 text-center text-sm text-muted-foreground">{t("share.list.noMatch")}</p>
            )}
            <ul className="divide-y divide-border/70 overflow-hidden rounded-xl ring-1 ring-inset ring-border/80 empty:hidden">
                {rows.map((sharedUser) => {
                    const allowedCount = sharedUser.allowed_target_usernames?.length ?? 0;
                    // 經由群組的分享：在群組分頁改，或改成他自己的。/ Through a group: changed on the Groups tab, or made their own.
                    const via = sharedUser.via_group ?? null;
                    const canEditTargets = !readOnly && !locked && tunnelUsernames.length > 0 && !via;
                    return (
                        <li key={sharedUser.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3 transition-colors hover:bg-surface">
                            {/* 名字與期限至少 14rem：放不下時按鈕整組換到下一行，不會把它們擠成一字一行。
                                Name and end get at least 14rem: on a phone the buttons move to the next line instead of squeezing them. */}
                            <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-sm text-background uppercase" aria-hidden>
                                    {sharedUser.username.slice(0, 1)}
                                </span>
                                <span className="flex min-w-0 flex-col items-start">
                                    <span className="max-w-full truncate text-sm text-foreground">{sharedUser.username}</span>
                                    {via && (
                                        <button
                                            type="button"
                                            onClick={onGroups}
                                            className="inline-flex items-center gap-1 text-xs text-info hover:underline"
                                            title={t("share.group.viaHint", { name: via.name })}
                                        >
                                            <Users size={12} aria-hidden /> {t("share.group.via", { name: via.name })}
                                        </button>
                                    )}
                                    <ShareExpiryControl
                                        expiresAt={sharedUser.expires_at}
                                        editable={!readOnly && !locked && !via}
                                        onChange={(value) => onUpdateExpiry(sharedUser.id, value)}
                                    />
                                    <TemporaryGrantText
                                        accounts={(sharedUser.allowed_target_usernames ?? []).map((a) => ({ username: a.username ?? `#${a.id}`, until: a.until }))}
                                        permission={sharedUser.permission_type}
                                        permissionUntil={sharedUser.permission_until}
                                    />
                                </span>
                            </div>
                            <div className="ml-auto flex shrink-0 items-center gap-2">
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
                                    className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-muted-foreground ring-1 ring-inset ring-border transition-colors enabled:hover:bg-muted enabled:hover:text-foreground disabled:cursor-default"
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
                                    disabled={readOnly || locked || !!via}
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
                                {!readOnly && via && !locked && onOwnShare && (
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => onOwnShare(sharedUser)}
                                        className="text-muted-foreground"
                                        title={t("share.group.own")}
                                        aria-label={t("share.group.own")}
                                    >
                                        <UserRoundCog />
                                    </Button>
                                )}
                                {!readOnly && !via && (
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
            <Pagination pager={pager} className="mt-2.5" />
        </section>
    );
}
