"use client";

/**
 * 「管理目標主機使用者」：裝置上 Telepy 能登入的作業系統帳號。帳號多時（7 個起）有搜尋與分類（全部 / 有分給別人 /
 * 沒分給別人 / 預設），搜尋與分類先對全部做再分頁；每列有預設帳號的星號、分給幾位 sharee、誰加的與移除。
 * 標題下的「這些帳號是做什麼的？」打開說明（TargetUsersInfoDialog）。
 * The target-account list: the OS accounts on the device that Telepy logs in as. From 7 accounts there is a search
 * and buckets (all / shared / not shared / default), applied to everything before paging; each row has the default
 * star, how many sharees hold it, who added it and remove. "What are these accounts for?" opens the explainer.
 */
import React, { useMemo, useState } from "react";
import { Info, Search, Star, User, UserPlus, Users, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { Pagination } from "@/components/ui/pagination";
import { TargetUsersInfoDialog } from "@/components/tunnels/TargetUsersInfoDialog";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { accountCounts, matchesAccount, sortAccounts, type AccountFilter } from "@/lib/targetUsers";
import { TunnelModalProps } from "@/types/tunnel";
import { useManageUsersModal } from "@/hooks/useManageUsersModal";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** 這麼多個以上才有搜尋與分類。/ Search and buckets from this many accounts on. */
const SEARCH_FROM = 7;

interface ManageUsersModalProps extends TunnelModalProps {
    readOnly?: boolean;
}

export function ManageUsersModal({ isOpen, onClose, tunnelId, readOnly = false }: ManageUsersModalProps) {
    const { t } = useI18n();
    const { state, actions } = useManageUsersModal(tunnelId, isOpen);
    const { users, defaultId, adminSharees, canManage, savingDefault, newUsername, setNewUsername, loading, deleteConfirm, setDeleteConfirm } = state;
    const { handleAddUser, handleDeleteUser, setDefault } = actions;
    const manage = !readOnly && canManage;
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<AccountFilter>("all");
    const [infoOpen, setInfoOpen] = useState(false);

    const counts = useMemo(() => accountCounts(users, defaultId), [users, defaultId]);
    // 選的分類變空了就退回全部。/ Fall back to "all" when the chosen bucket empties.
    const bucket: AccountFilter = filter !== "all" && counts[filter] === 0 ? "all" : filter;
    const filtered = useMemo(() => sortAccounts(users, defaultId).filter((u) => matchesAccount(u, bucket, query, defaultId)), [users, defaultId, bucket, query]);
    const pager = usePagination(filtered.length, { storageKey: "telepy.targetUsersPageSize", resetKey: `${query}|${bucket}` });
    const rows = pageSlice(filtered, pager.page, pager.size);
    const showControls = users.length >= SEARCH_FROM;
    const buckets: AccountFilter[] = ["all", ...(counts.shared ? (["shared"] as const) : []), ...(counts.unshared && counts.shared ? (["unshared"] as const) : []), ...(counts.default ? (["default"] as const) : [])];

    return (
        <>
            <Modal
                isOpen={isOpen}
                onClose={onClose}
                title={t("manageUsers.title")}
                icon={<Users />}
                size="xl"
                isLoading={loading && users.length === 0}
                description={
                    <span>
                        {t("manageUsers.subtitle")}{" "}
                        <button type="button" onClick={() => setInfoOpen(true)} className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline">
                            <Info size={14} aria-hidden />
                            {t("manageUsers.info.open")}
                        </button>
                    </span>
                }
                toolbar={
                    showControls ? (
                        <div className="flex flex-col gap-2">
                            <div className="relative min-w-0">
                                <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("manageUsers.search")} aria-label={t("manageUsers.search")} className="h-8 pl-8" />
                            </div>
                            {buckets.length > 1 && (
                                <Segmented
                                    size="sm"
                                    fullWidth
                                    aria-label={t("manageUsers.filterAria")}
                                    value={bucket}
                                    onChange={setFilter}
                                    options={buckets.map((b) => ({ value: b, label: `${t(`manageUsers.filter.${b}`)} (${counts[b]})` }))}
                                />
                            )}
                        </div>
                    ) : undefined
                }
            >
                <div className="space-y-4">
                    {manage && (
                        <form onSubmit={handleAddUser} className="flex gap-2">
                            <Input
                                type="text"
                                className="flex-1 font-mono"
                                placeholder={t("manageUsers.inputPlaceholder")}
                                aria-label={t("manageUsers.inputPlaceholder")}
                                value={newUsername}
                                onChange={(e) => setNewUsername(e.target.value)}
                                disabled={loading}
                            />
                            <Button type="submit" disabled={!newUsername.trim() || loading}>
                                <UserPlus />
                                {t("common.add")}
                            </Button>
                        </form>
                    )}

                    {loading && users.length === 0 ? null : users.length === 0 ? (
                        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-8 text-center">
                            <span className="mb-3 grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
                                <User size={20} />
                            </span>
                            <p className="text-foreground">{t("manageUsers.empty")}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{t("manageUsers.emptySubtext")}</p>
                        </div>
                    ) : filtered.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">{t("manageUsers.noMatch")}</p>
                    ) : (
                        <ul className="divide-y divide-border/70 rounded-xl ring-1 ring-inset ring-border/80">
                            {rows.map((user) => {
                                const isDefault = user.id === defaultId;
                                return (
                                    <li key={user.id} className="flex min-w-0 items-center gap-2 px-3.5 py-2.5 transition-colors hover:bg-surface">
                                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
                                            <User size={16} />
                                        </span>
                                        {/* 名稱與標籤：放不下時標籤換到下一行，名稱不被擠成「…」。/ The tags wrap below instead of squeezing the name. */}
                                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="min-w-0 max-w-full truncate font-mono text-sm text-foreground" title={user.username}>{user.username}</span>
                                            {isDefault && <Chip tone="success"><Star />{t("manageUsers.defaultTag")}</Chip>}
                                            {typeof user.shared_with === "number" && user.shared_with > 0 && <Chip>{t("manageUsers.sharedWith", { count: user.shared_with })}</Chip>}
                                            {user.created_by && <Chip className="h-auto max-w-full whitespace-normal [overflow-wrap:anywhere]">{t("common.byUserTag", { user: user.created_by, id: user.created_by_id ?? "" })}</Chip>}
                                        </span>
                                        {manage && (
                                            <span className="flex shrink-0 items-center gap-0.5">
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    onClick={() => setDefault(isDefault ? null : user.id)}
                                                    disabled={savingDefault !== null}
                                                    className={cn(isDefault ? "text-success" : "text-muted-foreground")}
                                                    title={isDefault ? t("manageUsers.unsetDefault") : t("manageUsers.setDefault")}
                                                    aria-label={isDefault ? t("manageUsers.unsetDefault") : t("manageUsers.setDefault")}
                                                    aria-pressed={isDefault}
                                                >
                                                    <Star className={cn(isDefault && "fill-current")} />
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="icon-sm"
                                                    onClick={() => setDeleteConfirm({ isOpen: true, user })}
                                                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                                    title={t("manageUsers.removeTitle")}
                                                    aria-label={t("manageUsers.removeTitle")}
                                                >
                                                    <X />
                                                </Button>
                                            </span>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <Pagination pager={pager} />
                </div>
            </Modal>

            <TargetUsersInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} users={users} defaultId={defaultId} adminSharees={adminSharees} canManage={canManage} />

            <ConfirmDialog
                isOpen={deleteConfirm.isOpen}
                onClose={() => setDeleteConfirm({ isOpen: false, user: null })}
                onConfirm={handleDeleteUser}
                title={t("manageUsers.removeTitle")}
                message={t("manageUsers.removeMessage", { username: deleteConfirm.user?.username ?? "" })}
                confirmText={t("common.remove")}
                isDestructive={true}
            />
        </>
    );
}
