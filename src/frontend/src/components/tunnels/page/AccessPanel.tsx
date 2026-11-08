"use client";

/**
 * 通道頁面的「存取」：你自己的權限（分享給你的話：到期日、申請更多存取）、分享給誰（擁有者 / Admin 管理）、能登入的
 * OS 帳號、你的 SSH 金鑰放進這台裝置。實際的編輯都在原本的對話框裡（分享、登入帳號），這裡讓人找得到。
 * A tunnel page's "Access": your own permission (when shared with you: when it ends, asking for more), who it is shared
 * with (owners / Admins manage it), the OS accounts, and your SSH keys on the device. The editing stays in the existing
 * dialogs (sharing, login accounts); this tab makes them findable.
 */
import React, { useState } from "react";
import Link from "next/link";
import { ArrowRight, KeyRound, LockKeyholeOpen, LogOut, Share2, ShieldCheck, UserRound, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/Toast";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { Chip, Property, PropertyList, Section } from "@/components/ui/section";
import { ShareExpiryText } from "@/components/tunnels/ShareExpiry";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import type { Tunnel } from "@/types/tunnel";

/** 分享對象的權限（跟「分享給 N 人」浮層同一套字）。/ A sharee's permission (the shared-with chip's words). */
const PERM_LABEL: Record<string, TranslationKey> = { view: "share.permView", edit: "share.permEdit", admin: "share.permAdmin" };

const ROLE_LABEL: Record<string, TranslationKey> = {
    owner: "keys.role.owner",
    admin: "keys.role.admin",
    edit: "keys.role.edit",
    view: "keys.role.view",
};

interface Props {
    tunnel: Tunnel;
    /** owner / admin / edit / view */
    role: string;
    manager: boolean;
    onShare: () => void;
    onUsers: (readOnly: boolean) => void;
    onRequestAccess: () => void;
    /** 退出了經由的個人群組（重新載入）。/ Left the personal group it came through (reload). */
    onLeftGroup: () => void;
}

/**
 * 退出別人的個人群組：任何人都能把你加進去，所以你一定能自己退出。經由它拿到的通道（不只這條）都會收回。
 * Leave someone's personal group: anyone can add you, so you can always leave. Every tunnel held through it goes.
 */
function LeaveGroup({ groupId, name, owner, onLeft }: { groupId: number; name: string; owner: string; onLeft: () => void }) {
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

export function AccessPanel({ tunnel, role, manager, onShare, onUsers, onRequestAccess, onLeftGroup }: Props) {
    const { t } = useI18n();
    const sharees = tunnel.shared_with ?? [];
    const requests = tunnel.access_requests ?? 0;
    return (
        <div className="space-y-6">
            <Section icon={<UserRound />} title={t("tunnelPage.access.yours")}>
                <PropertyList>
                    <Property label={t("tunnelPage.access.role")}>
                        <Chip tone={role === "view" ? "neutral" : "success"}>
                            <ShieldCheck /> {t(ROLE_LABEL[role] ?? "keys.role.view")}
                        </Chip>
                    </Property>
                    {!tunnel.is_owner && (
                        <Property label={t("tunnelPage.access.until")}>
                            <ShareExpiryText expiresAt={tunnel.share_expires_at} showNone />
                        </Property>
                    )}
                    {!tunnel.is_owner && tunnel.share_group && (
                        <Property label={t("share.group.through")}>
                            <span className="flex flex-wrap items-center gap-2">
                                <span title={t("share.group.viaHintMine", { name: tunnel.share_group })}>{tunnel.share_group}</span>
                                {tunnel.share_group_owner && (
                                    <>
                                        <Chip>
                                            <UserRound aria-hidden />
                                            {t("share.group.personalOf", { owner: tunnel.share_group_owner })}
                                        </Chip>
                                        {tunnel.share_group_id != null && (
                                            <LeaveGroup groupId={tunnel.share_group_id} name={tunnel.share_group} owner={tunnel.share_group_owner} onLeft={onLeftGroup} />
                                        )}
                                    </>
                                )}
                            </span>
                        </Property>
                    )}
                </PropertyList>
                {!tunnel.is_owner && !manager && (
                    <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" variant="outline" onClick={onRequestAccess}>
                            <LockKeyholeOpen size={15} /> {t("share.request.menu")}
                        </Button>
                        <span className="text-xs text-muted-foreground">{t("share.request.menuHint")}</span>
                    </div>
                )}
            </Section>

            <Section
                icon={<Share2 />}
                title={t("tunnelPage.access.sharing")}
                description={t("tunnelActions.shareHint")}
                action={
                    manager ? (
                        <Button type="button" size="sm" variant="outline" onClick={onShare}>
                            <Share2 size={14} /> {tunnel.is_owner ? t("tunnelActions.shareTunnel") : t("tunnelActions.manageSharing")}
                        </Button>
                    ) : undefined
                }
            >
                {manager ? (
                    <>
                        {requests > 0 && (
                            <button type="button" onClick={onShare} className="text-left text-sm text-warning hover:underline">
                                {t("tunnelPage.attn.accessRequests", { count: requests })}
                            </button>
                        )}
                        {sharees.length > 0 ? (
                            <ul className="divide-y divide-border rounded-lg border border-border">
                                {sharees.map((s) => (
                                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                                        <span className="min-w-0 truncate text-foreground">{s.username}</span>
                                        <Chip>{PERM_LABEL[s.permission] ? t(PERM_LABEL[s.permission]) : s.permission}</Chip>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-sm text-muted-foreground">{t("tunnelPage.access.notShared")}</p>
                        )}
                    </>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("tunnelPage.access.sharingManagers")}</p>
                )}
            </Section>

            <Section icon={<Users />} title={t("tunnelPage.access.accounts")} description={t("tunnelActions.targetServerUsersHint")}>
                <div>
                    <Button type="button" variant="outline" onClick={() => onUsers(!manager)}>
                        <Users size={15} /> {manager ? t("tunnelActions.targetServerUsers") : t("tunnelActions.viewTargetUsers")}
                    </Button>
                </div>
            </Section>

            <Section icon={<KeyRound />} title={t("tunnelActions.deviceKeys")} description={t("tunnelPage.access.keysHint")}>
                <div>
                    <Button asChild variant="outline">
                        <Link href={`/tunnels/keys/devices?device=${tunnel.id}`} prefetch={false}>
                            <KeyRound size={15} /> {t("tunnelPage.access.keysOpen")} <ArrowRight size={14} />
                        </Link>
                    </Button>
                </div>
            </Section>
        </div>
    );
}
