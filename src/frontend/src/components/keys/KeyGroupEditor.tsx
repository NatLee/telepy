/**
 * 建立 / 編輯金鑰群組：名稱 + 挑金鑰（`MemberPicker`：已選的籤、搜尋 / 分類 / 全選、分頁；在別組的會顯示「在 X」，
 * 勾了就移過來），金鑰再多視窗也不會變很長。
 * Create or edit a key group: a name plus the key picker (`MemberPicker`: selected chips, search / buckets / select
 * all, pages; keys in another group say so and move here), so many keys never make the dialog long.
 */
import React, { useMemo, useState } from "react";
import { KeyRound, Layers, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MemberPicker, type MemberItem } from "@/components/groups/MemberPicker";
import { GroupMetaFields, useGroupMetaForm } from "@/components/groups/GroupMetaFields";
import { NAME_PROBLEM } from "@/components/tunnels/TunnelGroupEditor";
import { useI18n } from "@/lib/i18n";
import { groupNameProblem, MAX_GROUP_NAME, normalizeGroupName } from "@/lib/groups";
import type { GroupMeta, KeyGroup } from "@/types/groups";
import type { UserKey } from "@/types/keys";

export function KeyGroupEditor({
    group,
    groups,
    keys,
    onClose,
    onSubmit,
}: {
    group: KeyGroup | null;
    groups: KeyGroup[];
    keys: UserKey[];
    onClose: () => void;
    /** 回傳名稱欄位的錯誤（null = 成功）。/ Returns the name error (null = saved). */
    onSubmit: (name: string, meta: GroupMeta, keyIds: number[]) => Promise<string | null>;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(group?.name ?? "");
    const [ids, setIds] = useState<number[]>(group?.key_ids ?? []);
    // 空名稱只在按下儲存後才提示（不會一離開欄位、開始挑成員就變紅）；太長 / 重名打字時就提示。
    // An empty name is flagged only after Save (not when you leave the field to pick members); too long / taken show as you type.
    const [submitted, setSubmitted] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const meta = useGroupMetaForm(group);
    const groupOfKey = useMemo(() => {
        const m = new Map<number, KeyGroup>();
        for (const g of groups) for (const k of g.key_ids) m.set(k, g);
        return m;
    }, [groups]);
    const problem = groupNameProblem(name, groups, group?.id);
    const nameError = serverError ?? (problem && (submitted || problem !== "empty") ? t(NAME_PROBLEM[problem]) : undefined);
    const items = useMemo<MemberItem[]>(
        () =>
            [...keys]
                .sort((a, b) => a.host_friendly_name.localeCompare(b.host_friendly_name, undefined, { numeric: true, sensitivity: "base" }))
                .map((k) => {
                    const g = groupOfKey.get(k.id);
                    return {
                        id: k.id,
                        label: k.host_friendly_name,
                        text: [k.host_friendly_name, k.fingerprint, k.comment, k.key_type],
                        group: g?.id ?? null,
                        groupName: g?.name ?? null,
                        title: k.fingerprint ?? undefined,
                        icon: <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />,
                        meta: <span className="shrink-0 font-mono text-xs text-muted-foreground">{k.key_type ?? "?"}</span>,
                    };
                }),
        [keys, groupOfKey]
    );

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (problem || !meta.valid) return;
        setSaving(true);
        const err = await onSubmit(normalizeGroupName(name), meta.value, ids);
        setSaving(false);
        if (err !== null) setServerError(err || null);
        else onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={group ? t("groups.key.editTitle") : t("groups.key.newTitle")}
            description={t("groups.key.fieldHint")}
            icon={<Layers />}
            size="xl"
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
                    <Button type="submit" form="key-group-form" disabled={saving || (submitted && !!problem) || !meta.valid}>
                        {saving && <Loader2 className="animate-spin" />} {t("common.save")}
                    </Button>
                </>
            }
        >
            <form id="key-group-form" onSubmit={submit} className="space-y-5">
                <Field id="key-group-name" label={t("groups.name")} required error={nameError}>
                    <Input
                        id="key-group-name"
                        autoFocus
                        value={name}
                        maxLength={MAX_GROUP_NAME * 2}
                        onChange={(e) => {
                            setName(e.target.value);
                            setServerError(null);
                        }}
                        placeholder={t("groups.example.group")}
                    />
                </Field>
                <GroupMetaFields form={meta} idPrefix="key-group" descriptionPlaceholder={t("groups.key.descriptionPlaceholder")} />
                <MemberPicker items={items} selected={ids} onChange={setIds} current={group?.id ?? null} title={t("groups.key.keys")} hint={t("groups.key.moveHint")} />
            </form>
        </Modal>
    );
}
