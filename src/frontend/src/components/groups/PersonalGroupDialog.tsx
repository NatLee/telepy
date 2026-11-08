"use client";

/**
 * 新增 / 編輯個人群組：名稱、說明、成員（其他啟用中的使用者）。只有自己看得到，只用來分享通道。
 * New / edit a personal group: name, description, members (other active users). Only you see it; it is only for sharing.
 */
import React, { useMemo, useState } from "react";
import { User, Users } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MemberPicker } from "@/components/groups/MemberPicker";
import { useI18n } from "@/lib/i18n";
import { nameProblem, type PersonalGroup, type PickableUser } from "@/lib/peopleGroups";

export interface PersonalGroupForm {
    name: string;
    description: string;
    members: number[];
}

export function PersonalGroupDialog({
    group,
    users,
    maxMembers,
    saving,
    onClose,
    onSave,
}: {
    /** null = 新增。/ null = new. */
    group: PersonalGroup | null;
    users: PickableUser[];
    maxMembers: number;
    saving: boolean;
    onClose: () => void;
    onSave: (form: PersonalGroupForm) => void;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(group?.name ?? "");
    const [description, setDescription] = useState(group?.description ?? "");
    const [members, setMembers] = useState<number[]>(group?.members ?? []);
    const [tried, setTried] = useState(false);
    const problem = nameProblem(name);
    const tooMany = members.length > maxMembers;
    const items = useMemo(
        () =>
            users.map((u) => ({
                id: u.id,
                label: u.username,
                text: [u.username, u.email],
                group: null,
                icon: <User size={14} className="shrink-0 text-muted-foreground" aria-hidden />,
                title: u.email || u.username,
            })),
        [users],
    );
    const submit = (e?: React.FormEvent) => {
        e?.preventDefault();
        setTried(true);
        if (problem || tooMany || saving) return;
        onSave({ name: name.trim(), description: description.trim(), members });
    };
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={group ? t("personalGroups.edit") : t("personalGroups.new")}
            description={t("personalGroups.dialogHint")}
            icon={<Users />}
            size="2xl"
            isLoading={saving}
            footer={
                <>
                    <Button type="button" variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="button" disabled={saving} onClick={() => submit()}>{t("common.save")}</Button>
                </>
            }
        >
            <form className="space-y-4" onSubmit={submit}>
                <Field
                    label={t("access.groupName")}
                    required
                    error={tried && problem ? t(problem === "empty" ? "personalGroups.nameEmpty" : "personalGroups.nameLong") : undefined}
                >
                    <Input value={name} maxLength={64} autoFocus onChange={(e) => setName(e.target.value)} placeholder={t("personalGroups.namePlaceholder")} />
                </Field>
                <Field label={t("access.groupDescription")} hint={t("access.groupDescriptionHint")}>
                    <Textarea value={description} rows={2} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
                </Field>
                <MemberPicker
                    items={items}
                    selected={members}
                    onChange={setMembers}
                    current={group?.id ?? null}
                    title={t("access.members")}
                    hint={users.length === 0 ? t("personalGroups.noUsers") : t("personalGroups.membersHint")}
                    showFree={false}
                />
                {tooMany && <p className="text-sm text-destructive">{t("personalGroups.tooMany", { max: maxMembers })}</p>}
            </form>
        </Modal>
    );
}
