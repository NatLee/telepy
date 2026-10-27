"use client";

/**
 * 「管理目標主機使用者」的說明：這些是裝置上 Telepy 能登入的作業系統帳號。路徑圖（Telepy 的使用者 ─ 允許清單 ─
 * 這台的帳號 ─ 裝置的 sshd）帶這台的實際數字，下面幾點說誰能用哪個、預設帳號用在哪、移除會怎樣。
 * The explainer for the target-account list: these are the OS accounts on the device that Telepy logs in as. A path
 * diagram (Telepy users ─ allow-list ─ this device's accounts ─ the device's sshd) with this tunnel's real numbers,
 * then who may use which, where the default account is used, and what removing one does.
 */
import React from "react";
import { Cpu, KeyRound, ShieldCheck, Star, Trash2, UserRound, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import type { TargetAccount } from "@/lib/targetUsers";
import type { TranslationKey } from "@/locales/en";

const POINTS: { icon: React.ReactNode; title: TranslationKey; body: TranslationKey }[] = [
    { icon: <UserRound />, title: "manageUsers.info.whatTitle", body: "manageUsers.info.what" },
    { icon: <ShieldCheck />, title: "manageUsers.info.whoTitle", body: "manageUsers.info.who" },
    { icon: <Star />, title: "manageUsers.info.defaultTitle", body: "manageUsers.info.default" },
    { icon: <KeyRound />, title: "manageUsers.info.keysTitle", body: "manageUsers.info.keys" },
    { icon: <Trash2 />, title: "manageUsers.info.removeTitle", body: "manageUsers.info.remove" },
];

export function TargetUsersInfoDialog({ isOpen, onClose, users, defaultId, adminSharees, canManage }: {
    isOpen: boolean;
    onClose: () => void;
    users: TargetAccount[];
    defaultId: number | null;
    adminSharees: number | null;
    canManage: boolean;
}) {
    const { t } = useI18n();
    const shared = users.filter((u) => (u.shared_with ?? 0) > 0).length;
    const defaultName = users.find((u) => u.id === defaultId)?.username;
    const names = users.slice(0, 4).map((u) => u.username).join(", ") + (users.length > 4 ? ` +${users.length - 4}` : "");

    return (
        <Modal isOpen={isOpen} onClose={onClose} title={t("manageUsers.info.title")} description={t("manageUsers.info.subtitle")} size="4xl">
            <div className="space-y-6 text-sm">
                <FlowPath>
                    <FlowNode
                        icon={Users}
                        title={t("manageUsers.info.nodeUsers")}
                        sub={canManage && adminSharees !== null ? t("manageUsers.info.nodeUsersSub", { admins: adminSharees }) : t("manageUsers.info.nodeUsersYou")}
                        state="ok"
                        stateText={t("manageUsers.info.nodeUsersState")}
                    />
                    <FlowLink label={t("manageUsers.info.linkAllow")} note={canManage ? t("manageUsers.info.linkAllowNote", { shared, count: users.length }) : undefined} state="ok" />
                    <FlowNode
                        icon={UserRound}
                        title={t("manageUsers.info.nodeAccounts", { count: users.length })}
                        sub={users.length ? names : t("manageUsers.empty")}
                        state={users.length ? "ok" : "waiting"}
                        stateText={defaultName ? t("manageUsers.info.nodeDefault", { username: defaultName }) : t("manageUsers.info.nodeNoDefault")}
                    />
                    <FlowLink label={t("manageUsers.info.linkLogin")} state={users.length ? "ok" : "waiting"} />
                    <FlowNode icon={Cpu} title={t("manageUsers.info.nodeDevice")} sub="authorized_keys" state="waiting" stateText={t("manageUsers.info.nodeDeviceState")} />
                </FlowPath>
                <ul className="grid gap-3 sm:grid-cols-2">
                    {POINTS.map((p) => (
                        <li key={p.title} className="flex gap-3 rounded-xl border border-border p-3">
                            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground [&>svg]:size-4" aria-hidden>{p.icon}</span>
                            <span className="min-w-0">
                                <span className="block text-foreground">{t(p.title)}</span>
                                <span className="mt-0.5 block text-muted-foreground">{t(p.body)}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            </div>
        </Modal>
    );
}
