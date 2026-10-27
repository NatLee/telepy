/**
 * 「群組」管理視窗：我的通道群組（照我排的順序）、各有幾條 / 幾條在線，可以上下移、編輯、刪除，或新增一組。
 * The "Groups" manager: my tunnel groups in my order with tunnel / online counts; move up or down, edit, delete,
 * or add one.
 */
import React from "react";
import { ArrowDown, ArrowUp, Folder, FolderTree, Plus, SquarePen, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { TunnelLabels } from "@/components/tunnels/TunnelTags";
import { useI18n } from "@/lib/i18n";
import { moveId } from "@/lib/groups";
import type { TunnelGroup } from "@/types/groups";

export function TunnelGroupsDialog({
    open,
    groups,
    onlineCount,
    onClose,
    onNew,
    onEdit,
    onDelete,
    onReorder,
}: {
    open: boolean;
    groups: TunnelGroup[];
    /** 這組有幾條在線。/ How many of a group's tunnels are online. */
    onlineCount: (g: TunnelGroup) => number;
    onClose: () => void;
    onNew: () => void;
    onEdit: (g: TunnelGroup) => void;
    onDelete: (g: TunnelGroup) => void;
    onReorder: (ids: number[]) => void;
}) {
    const { t } = useI18n();
    const ordered = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
    const ids = ordered.map((g) => g.id);
    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            title={t("groups.tunnel.title")}
            description={t("groups.tunnel.description")}
            icon={<FolderTree />}
            size="xl"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
                    <Button onClick={onNew}>
                        <Plus /> {t("groups.new")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <Callout tone="info">{t("groups.onlyYou")}</Callout>
                {ordered.length === 0 ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">{t("groups.tunnel.empty")}</p>
                ) : (
                    <ul className="divide-y divide-border rounded-xl ring-1 ring-border">
                        {ordered.map((g, i) => (
                            <li key={g.id} className="flex items-center gap-3 px-3 py-2.5">
                                <Folder size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm text-foreground" title={g.name}>{g.name}</p>
                                    {g.description && <p className="line-clamp-2 whitespace-pre-line text-xs text-foreground/75" title={g.description}>{g.description}</p>}
                                    <TunnelLabels labels={g.labels} className="my-0.5" />
                                    <p className="text-xs text-muted-foreground">
                                        {t("groups.tunnel.count", { count: g.tunnel_ids.length })}
                                        {g.tunnel_ids.length > 0 && <> · {t("groups.tunnel.online", { count: onlineCount(g) })}</>}
                                    </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-0.5">
                                    <Button variant="ghost" size="icon-sm" disabled={i === 0} onClick={() => onReorder(moveId(ids, g.id, -1))} aria-label={`${t("groups.moveUp")}: ${g.name}`} title={t("groups.moveUp")}>
                                        <ArrowUp />
                                    </Button>
                                    <Button variant="ghost" size="icon-sm" disabled={i === ordered.length - 1} onClick={() => onReorder(moveId(ids, g.id, 1))} aria-label={`${t("groups.moveDown")}: ${g.name}`} title={t("groups.moveDown")}>
                                        <ArrowDown />
                                    </Button>
                                    <Button variant="ghost" size="icon-sm" onClick={() => onEdit(g)} aria-label={`${t("groups.edit")}: ${g.name}`} title={t("groups.edit")}>
                                        <SquarePen />
                                    </Button>
                                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(g)} aria-label={`${t("groups.delete")}: ${g.name}`} title={t("groups.delete")}>
                                        <Trash2 />
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Modal>
    );
}
