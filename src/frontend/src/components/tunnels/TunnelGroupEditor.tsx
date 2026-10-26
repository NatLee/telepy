/**
 * 建立 / 編輯一個通道群組：名稱 + 勾選通道（在別組的會顯示「在 X」，勾了就移過來）。通道多時（7 條起）有搜尋。
 * Create or edit one tunnel group: a name plus a tunnel checklist (tunnels in another group say so and move here
 * when ticked). A search box appears from 7 tunnels.
 */
import React, { useMemo, useState } from "react";
import { FolderPlus, Loader2, Search, SquarePen } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/ui/section";
import { StatusDot } from "@/components/tunnels/TunnelStatus";
import { useI18n } from "@/lib/i18n";
import { groupNameProblem, groupOf, MAX_GROUP_NAME, normalizeGroupName, type GroupNameProblem } from "@/lib/groups";
import type { TranslationKey } from "@/locales/en";
import type { TunnelGroup } from "@/types/groups";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

/** 這麼多條以上才有搜尋。/ Search from this many tunnels on. */
const SEARCH_FROM = 7;

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
    const [query, setQuery] = useState("");
    const [touched, setTouched] = useState(false);
    const [serverError, setServerError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const of = useMemo(() => groupOf(groups), [groups]);
    const names = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

    const problem = groupNameProblem(name, groups, group?.id);
    const nameError = serverError ?? (touched && problem ? t(NAME_PROBLEM[problem]) : undefined);
    const sorted = useMemo(() => [...tunnels].sort((a, b) => a.host_friendly_name.localeCompare(b.host_friendly_name)), [tunnels]);
    const q = query.trim().toLowerCase();
    const shown = q ? sorted.filter((tn) => tn.host_friendly_name.toLowerCase().includes(q) || (tn.description ?? "").toLowerCase().includes(q)) : sorted;

    const toggle = (id: number, on: boolean) => setIds((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)));

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setTouched(true);
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
                    <Button type="submit" form="tunnel-group-form" disabled={saving || (touched && !!problem)}>
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
                        onBlur={() => setTouched(true)}
                        placeholder={t("groups.namePlaceholder")}
                    />
                </Field>
                <fieldset className="space-y-2">
                    <legend className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                        {t("groups.tunnel.tunnels")}
                        <span className="text-xs text-muted-foreground">{t("groups.selectedCount", { count: ids.length })}</span>
                    </legend>
                    <p className="text-xs text-muted-foreground">{t("groups.tunnel.moveHint")}</p>
                    {tunnels.length >= SEARCH_FROM && (
                        <div className="relative">
                            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.search")} aria-label={t("groups.search")} className="h-8 pl-8" />
                        </div>
                    )}
                    <div className="grid gap-1.5 p-px sm:grid-cols-2">
                        {shown.map((tn) => {
                            const other = of.get(tn.id);
                            const elsewhere = other !== undefined && other !== group?.id ? names.get(other) : undefined;
                            return (
                                <label
                                    key={tn.id}
                                    className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30"
                                >
                                    <input type="checkbox" checked={ids.includes(tn.id)} onChange={(e) => toggle(tn.id, e.target.checked)} className="size-4 shrink-0 accent-primary" />
                                    <StatusDot health={health(tn)} />
                                    <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={tn.host_friendly_name}>{tn.host_friendly_name}</span>
                                    {elsewhere && !ids.includes(tn.id) && <Chip className="max-w-[45%] truncate">{t("groups.inGroup", { name: elsewhere })}</Chip>}
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
