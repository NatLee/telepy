/**
 * 「移到群組」：一條通道放進我的哪個群組（或不放），也可以當場取名建一個新的。只改我自己的列表。
 * "Move to group": which of my groups a tunnel goes in (or none), or a new group named on the spot. Only my own
 * list changes.
 */
import React, { useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { groupNameProblem, MAX_GROUP_NAME, normalizeGroupName } from "@/lib/groups";
import { NAME_PROBLEM } from "@/components/tunnels/TunnelGroupEditor";
import { GroupSearchBox, GroupSearchFooter, useGroupSearch } from "@/components/groups/GroupSearch";
import type { TunnelGroup } from "@/types/groups";
import type { Tunnel } from "@/types/tunnel";

type Choice = { kind: "none" } | { kind: "group"; id: number } | { kind: "new" };

const row = "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 ring-1 ring-border transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6 has-[:checked]:ring-primary/30";

export function MoveToGroupDialog({
    tunnel,
    groups,
    current,
    onClose,
    onMove,
    onCreate,
}: {
    tunnel: Tunnel;
    groups: TunnelGroup[];
    /** 它現在在哪一組。/ Its current group. */
    current: number | null;
    onClose: () => void;
    onMove: (groupId: number | null) => Promise<boolean>;
    /** 建新群組並把它放進去；回傳名稱錯誤（null = 成功）。/ Create a group holding it; returns the name error. */
    onCreate: (name: string) => Promise<string | null>;
}) {
    const { t } = useI18n();
    const ordered = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
    const [choice, setChoice] = useState<Choice>(current === null ? (groups.length ? { kind: "none" } : { kind: "new" }) : { kind: "group", id: current });
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    // 群組很多時：搜尋 + 分頁（目前選的那組一定看得到）。/ Many groups: search + pages (the current choice stays visible).
    const search = useGroupSearch(ordered, choice.kind === "group" ? choice.id : null);
    const problem = choice.kind === "new" ? groupNameProblem(name, groups) : null;
    const unchanged = (choice.kind === "none" && current === null) || (choice.kind === "group" && choice.id === current);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (unchanged) return onClose();
        if (problem) {
            setError(t(NAME_PROBLEM[problem]));
            return;
        }
        setSaving(true);
        if (choice.kind === "new") {
            const err = await onCreate(normalizeGroupName(name));
            setSaving(false);
            if (err) setError(err);
            else onClose();
            return;
        }
        const ok = await onMove(choice.kind === "group" ? choice.id : null);
        setSaving(false);
        if (ok) onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("groups.move.title")}
            description={t("groups.move.description", { name: tunnel.host_friendly_name })}
            icon={<FolderInput />}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={saving}>{t("common.cancel")}</Button>
                    <Button type="submit" form="move-to-group-form" disabled={saving}>
                        {saving && <Loader2 className="animate-spin" />} {t("common.save")}
                    </Button>
                </>
            }
        >
            <form id="move-to-group-form" onSubmit={submit} className="space-y-3">
                <fieldset className="space-y-1.5">
                    <legend className="sr-only">{t("groups.move.title")}</legend>
                    <GroupSearchBox s={search} />
                    {search.visible.map((g) => (
                        <label key={g.id} className={row}>
                            <input type="radio" name="group" checked={choice.kind === "group" && choice.id === g.id} onChange={() => setChoice({ kind: "group", id: g.id })} className="size-4 accent-primary" />
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={g.name}>{g.name}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{t("groups.tunnel.count", { count: g.tunnel_ids.length })}</span>
                        </label>
                    ))}
                    <GroupSearchFooter s={search} />
                    {ordered.length > 0 && (
                        <label className={row}>
                            <input type="radio" name="group" checked={choice.kind === "none"} onChange={() => setChoice({ kind: "none" })} className="size-4 accent-primary" />
                            <span className="text-sm text-muted-foreground">{t("groups.move.none")}</span>
                        </label>
                    )}
                    <label className={cn(row, "flex-wrap")}>
                        <input type="radio" name="group" checked={choice.kind === "new"} onChange={() => setChoice({ kind: "new" })} className="size-4 accent-primary" />
                        <span className="text-sm text-foreground">{t("groups.move.newLabel")}</span>
                        {choice.kind === "new" && (
                            <Input
                                autoFocus
                                value={name}
                                maxLength={MAX_GROUP_NAME * 2}
                                onChange={(e) => {
                                    setName(e.target.value);
                                    setError(null);
                                }}
                                placeholder={t("groups.namePlaceholder")}
                                aria-label={t("groups.name")}
                                aria-invalid={!!error}
                                className="h-8 min-w-[10rem] flex-1 basis-full sm:basis-auto"
                            />
                        )}
                    </label>
                    {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
                </fieldset>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("groups.move.keysNote")}</p>
            </form>
        </Modal>
    );
}
