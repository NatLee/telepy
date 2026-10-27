/**
 * 建立 / 編輯金鑰群組：名稱 + 勾選我的金鑰（在別組的會顯示「在 X」，勾了就移過來）。
 * Create or edit a key group: a name plus a checklist of my keys (keys in another group say so and move here).
 */
import React, { useMemo, useState } from "react";
import { KeyRound, Layers, Loader2, Search } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { NAME_PROBLEM } from "@/components/tunnels/TunnelGroupEditor";
import { useI18n } from "@/lib/i18n";
import { groupNameProblem, MAX_GROUP_NAME, normalizeGroupName } from "@/lib/groups";
import type { KeyGroup } from "@/types/groups";
import type { UserKey } from "@/types/keys";

const SEARCH_FROM = 7;

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
    onSubmit: (name: string, keyIds: number[]) => Promise<string | null>;
}) {
    const { t } = useI18n();
    const [name, setName] = useState(group?.name ?? "");
    const [ids, setIds] = useState<number[]>(group?.key_ids ?? []);
    const [query, setQuery] = useState("");
    const [touched, setTouched] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const groupOfKey = useMemo(() => {
        const m = new Map<number, KeyGroup>();
        for (const g of groups) for (const k of g.key_ids) m.set(k, g);
        return m;
    }, [groups]);
    const problem = groupNameProblem(name, groups, group?.id);
    const nameError = serverError ?? (touched && problem ? t(NAME_PROBLEM[problem]) : undefined);
    const q = query.trim().toLowerCase();
    const shown = q ? keys.filter((k) => [k.host_friendly_name, k.fingerprint ?? "", k.comment ?? ""].some((f) => f.toLowerCase().includes(q))) : keys;

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setTouched(true);
        if (problem) return;
        setSaving(true);
        const err = await onSubmit(normalizeGroupName(name), ids);
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
                    <Button type="submit" form="key-group-form" disabled={saving || (touched && !!problem)}>
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
                        onBlur={() => setTouched(true)}
                        placeholder={t("groups.example.group")}
                    />
                </Field>
                <fieldset className="space-y-2">
                    <legend className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                        {t("groups.key.keys")}
                        <span className="text-xs text-muted-foreground">{t("groups.selectedCount", { count: ids.length })}</span>
                    </legend>
                    <p className="text-xs text-muted-foreground">{t("groups.key.moveHint")}</p>
                    {keys.length >= SEARCH_FROM && (
                        <div className="relative">
                            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.search")} aria-label={t("groups.search")} className="h-8 pl-8" />
                        </div>
                    )}
                    <div className="grid gap-1.5 p-px sm:grid-cols-2">
                        {shown.map((k) => {
                            const other = groupOfKey.get(k.id);
                            const elsewhere = other && other.id !== group?.id && !ids.includes(k.id) ? other.name : undefined;
                            return (
                                <label
                                    key={k.id}
                                    className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30"
                                    title={k.fingerprint ?? ""}
                                >
                                    <input
                                        type="checkbox"
                                        checked={ids.includes(k.id)}
                                        onChange={(e) => setIds((prev) => (e.target.checked ? [...prev, k.id] : prev.filter((x) => x !== k.id)))}
                                        className="size-4 shrink-0 accent-primary"
                                    />
                                    <KeyRound size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{k.host_friendly_name}</span>
                                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{k.key_type ?? "?"}</span>
                                    {elsewhere && <Chip className="max-w-[40%] truncate">{t("groups.inGroup", { name: elsewhere })}</Chip>}
                                </label>
                            );
                        })}
                    </div>
                    {shown.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">{t("groups.noMatch")}</p>}
                </fieldset>
            </form>
        </Modal>
    );
}
