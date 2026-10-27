/**
 * 建立 / 編輯一個通道群組：名稱 + 挑通道（`MemberPicker`：已選的籤、7 條起有搜尋 / 分類 / 全選、分頁；在別組的會
 * 顯示「在 X」，勾了就移過來）。
 * Create or edit one tunnel group: a name plus the tunnel picker (`MemberPicker`: selected chips, search / buckets /
 * select all from 7 tunnels, pages; tunnels in another group say so and move here when ticked).
 */
import React, { useMemo, useState } from "react";
import { FolderPlus, Loader2, SquarePen } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { MemberPicker, type MemberItem } from "@/components/groups/MemberPicker";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { useI18n } from "@/lib/i18n";
import { groupNameProblem, groupOf, MAX_GROUP_NAME, normalizeGroupName, type GroupNameProblem } from "@/lib/groups";
import type { TranslationKey } from "@/locales/en";
import type { TunnelGroup } from "@/types/groups";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

export const NAME_PROBLEM: Record<Exclude<GroupNameProblem, null>, TranslationKey> = {
    empty: "groups.nameEmpty",
    tooLong: "groups.nameTooLong",
    taken: "groups.nameTaken",
};

export function TunnelGroupEditor({
    group,
    groups,
    tunnels,
    health,
    initialTunnelIds = [],
    onClose,
    onSubmit,
}: {
    /** null = 新增。/ null = a new group. */
    group: TunnelGroup | null;
    groups: TunnelGroup[];
    tunnels: Tunnel[];
    health: (t: Tunnel) => TunnelHealth;
    /** 新增時先勾好的通道。/ Tunnels ticked up front for a new group. */
    initialTunnelIds?: number[];
    onClose: () => void;
    /** 回傳名稱欄位的錯誤（null = 成功）。/ Returns the name field's error (null = saved). */
    onSubmit: (name: string, tunnelIds: number[]) => Promise<string | null>;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(group?.name ?? "");
    const [ids, setIds] = useState<number[]>(group?.tunnel_ids ?? initialTunnelIds);
    // 空名稱只在按下儲存後才提示（不會一離開欄位、開始挑成員就變紅）；太長 / 重名打字時就提示。
    // An empty name is flagged only after Save (not when you leave the field to pick members); too long / taken show as you type.
    const [submitted, setSubmitted] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const of = useMemo(() => groupOf(groups), [groups]);
    const names = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

    const problem = groupNameProblem(name, groups, group?.id);
    const nameError = serverError ?? (problem && (submitted || problem !== "empty") ? t(NAME_PROBLEM[problem]) : undefined);
    const items = useMemo<MemberItem[]>(
        () =>
            [...tunnels]
                .sort((a, b) => a.host_friendly_name.localeCompare(b.host_friendly_name, undefined, { numeric: true, sensitivity: "base" }))
                .map((tn) => {
                    const g = of.get(tn.id);
                    return {
                        id: tn.id,
                        label: tn.host_friendly_name,
                        text: [tn.host_friendly_name, tn.description, String(tn.reverse_port), ...(tn.labels ?? [])],
                        group: g ?? null,
                        groupName: g !== undefined ? (names.get(g) ?? null) : null,
                        title: tn.host_friendly_name,
                        icon: <StatusDot health={health(tn)} />,
                    };
                }),
        [tunnels, of, names, health]
    );

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitted(true);
        if (problem) return;
        setSaving(true);
        const err = await onSubmit(normalizeGroupName(name), ids);
        setSaving(false);
        if (err) setServerError(err);
        else onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={group ? t("groups.edit") : t("groups.new")}
            description={t("groups.onlyYou")}
            icon={group ? <SquarePen /> : <FolderPlus />}
            size="xl"
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
                    <Button type="submit" form="tunnel-group-form" disabled={saving || (submitted && !!problem)}>
                        {saving && <Loader2 className="animate-spin" />} {t("common.save")}
                    </Button>
                </>
            }
        >
            <form id="tunnel-group-form" onSubmit={submit} className="space-y-5">
                <Field id="tunnel-group-name" label={t("groups.name")} required error={nameError}>
                    <Input
                        id="tunnel-group-name"
                        autoFocus
                        value={name}
                        maxLength={MAX_GROUP_NAME * 2}
                        onChange={(e) => {
                            setName(e.target.value);
                            setServerError(null);
                        }}
                        placeholder={t("groups.namePlaceholder")}
                    />
                </Field>
                <MemberPicker items={items} selected={ids} onChange={setIds} current={group?.id ?? null} title={t("groups.tunnel.tunnels")} hint={t("groups.tunnel.moveHint")} />
            </form>
        </Modal>
    );
}
