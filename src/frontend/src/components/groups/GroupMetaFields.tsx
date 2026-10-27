/**
 * 通道群組與金鑰群組的「說明」與「標籤」欄位（兩個編輯視窗共用）。標籤和通道標籤同規則（`lib/tunnelLabels`），
 * 打字時就檢查，下面列出整理後的標籤；說明最多 500 字。只有自己看得到（群組本來就是個人的）。
 * The description and labels fields of both group editors. Labels follow the tunnel label rules
 * (`lib/tunnelLabels`) and are checked as you type, with the tidied labels shown below; the description is up to
 * 500 characters. Only you see them (groups are personal).
 */
import React, { useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { parseLabels } from "@/lib/tunnelLabels";
import { MAX_GROUP_DESCRIPTION, normalizeGroupDescription } from "@/lib/groups";
import type { GroupMeta } from "@/types/groups";

/** 表單狀態：原始文字、整理後的值與錯誤。/ Form state: raw text, the tidied value and errors. */
export function useGroupMetaForm(initial: GroupMeta | null) {
    const { t } = useI18n();
    const [description, setDescription] = useState(initial?.description ?? "");
    const [labelsText, setLabelsText] = useState((initial?.labels ?? []).join(", "));
    const check = useMemo(() => parseLabels(labelsText), [labelsText]);
    const value: GroupMeta = useMemo(() => ({ description: normalizeGroupDescription(description), labels: check.labels }), [description, check.labels]);
    const errors: { description?: string; labels?: string } = {};
    if ([...value.description].length > MAX_GROUP_DESCRIPTION) errors.description = t("groups.descriptionTooLong", { max: MAX_GROUP_DESCRIPTION });
    if (check.invalid.length) errors.labels = t("tunnelDetails.labelInvalid", { label: check.invalid[0] });
    else if (check.tooMany) errors.labels = t("groups.labelsTooMany");
    return { description, setDescription, labelsText, setLabelsText, value, errors, valid: !errors.description && !errors.labels };
}

export type GroupMetaForm = ReturnType<typeof useGroupMetaForm>;

export function GroupMetaFields({ form, idPrefix, descriptionPlaceholder }: { form: GroupMetaForm; idPrefix: string; descriptionPlaceholder: string }) {
    const { t } = useI18n();
    const length = [...form.description.trim()].length;
    return (
        <>
            <Field
                id={`${idPrefix}-description`}
                label={t("common.description")}
                addon={t("common.optional")}
                hint={length > MAX_GROUP_DESCRIPTION * 0.8 ? t("groups.descriptionCount", { count: length, max: MAX_GROUP_DESCRIPTION }) : undefined}
                error={form.errors.description}
            >
                <Textarea id={`${idPrefix}-description`} value={form.description} onChange={(e) => form.setDescription(e.target.value)} rows={2} placeholder={descriptionPlaceholder} />
            </Field>
            <Field id={`${idPrefix}-labels`} label={t("tunnelDetails.labels")} addon={t("common.optional")} hint={t("groups.labelsHint")} error={form.errors.labels}>
                <Input
                    id={`${idPrefix}-labels`}
                    value={form.labelsText}
                    onChange={(e) => form.setLabelsText(e.target.value)}
                    spellCheck={false}
                    autoCapitalize="none"
                    placeholder="env=prod, web"
                />
            </Field>
            {form.value.labels.length > 0 && !form.errors.labels && (
                <span className="-mt-3 flex flex-wrap gap-1">
                    {form.value.labels.map((l) => (
                        <Chip key={l}><Tag /> {l}</Chip>
                    ))}
                </span>
            )}
        </>
    );
}
