/**
 * 通道列表的群組段落標題：收合 / 展開、名稱、幾條（搜尋時「N 條中的 M 條」）與幾條在線，右邊是群組選單
 * （編輯、上下移、刪除）。卡片檢視用 `GroupHeader`，表格檢視用 `GroupHeaderRow`（同一份內容放進一列）。
 * Section header for a tunnel group: collapse toggle, name, counts (and "M of N" while filtering), online count,
 * and the group menu (edit, move up / down, delete). Cards use `GroupHeader`, the table `GroupHeaderRow`.
 */
import React from "react";
import { ArrowDown, ArrowUp, ChevronRight, Folder, FolderOpen, MoreHorizontal, SquarePen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import type { TunnelGroup } from "@/types/groups";

export interface GroupHeaderProps {
    /** null = 未分組。/ null = not in a group. */
    group: TunnelGroup | null;
    shown: number;
    total: number;
    online: number;
    filtering: boolean;
    collapsed: boolean;
    onToggle: () => void;
    isFirst?: boolean;
    isLast?: boolean;
    onEdit?: () => void;
    onMove?: (delta: -1 | 1) => void;
    onDelete?: () => void;
}

function GroupMenu({ group, isFirst, isLast, onEdit, onMove, onDelete }: GroupHeaderProps) {
    const { t } = useI18n();
    if (!group) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t("groups.menuAria", { name: group.name })} className="data-[state=open]:bg-accent">
                    <MoreHorizontal />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={onEdit}>
                    <SquarePen /> {t("groups.edit")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isFirst} onClick={() => onMove?.(-1)}>
                    <ArrowUp /> {t("groups.moveUp")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isLast} onClick={() => onMove?.(1)}>
                    <ArrowDown /> {t("groups.moveDown")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 /> {t("groups.delete")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function HeaderContent(p: GroupHeaderProps) {
    const { t } = useI18n();
    const name = p.group?.name ?? t("groups.tunnel.ungrouped");
    const Icon = p.collapsed ? Folder : FolderOpen;
    return (
        <div className="flex min-w-0 items-center gap-2">
            <button
                type="button"
                onClick={p.onToggle}
                aria-expanded={!p.collapsed}
                aria-label={p.collapsed ? t("groups.tunnel.expand", { name }) : t("groups.tunnel.collapse", { name })}
                className="flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
                <ChevronRight size={16} className={cn("shrink-0 text-muted-foreground transition-transform", !p.collapsed && "rotate-90")} aria-hidden />
                <Icon size={16} className={cn("shrink-0", p.group ? "text-foreground/70" : "text-muted-foreground")} aria-hidden />
                <span className={cn("truncate text-base", p.group ? "text-foreground" : "text-muted-foreground")} title={name}>{name}</span>
            </button>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {p.filtering ? t("groups.tunnel.matches", { shown: p.shown, total: p.total }) : t("groups.tunnel.count", { count: p.total })}
                {p.total > 0 && <> · {t("groups.tunnel.online", { count: p.online })}</>}
            </span>
            <span className="ml-auto shrink-0">
                <GroupMenu {...p} />
            </span>
        </div>
    );
}

/** 卡片檢視的段落標題。/ Section header for the card view. */
export function GroupHeader(p: GroupHeaderProps) {
    return (
        <div className="border-b border-border pb-1.5">
            <HeaderContent {...p} />
        </div>
    );
}

/** 表格檢視：一列橫跨所有欄位的段落標題。/ Section header row spanning the table. */
export function GroupHeaderRow({ colSpan, ...p }: GroupHeaderProps & { colSpan: number }) {
    return (
        <tr className="bg-surface/60">
            <th scope="colgroup" colSpan={colSpan} className="px-3 py-1.5 text-left font-normal">
                <HeaderContent {...p} />
            </th>
        </tr>
    );
}

/** 空的群組（還沒放通道）。/ An empty group. */
export function EmptyGroup({ className }: { className?: string }) {
    const { t } = useI18n();
    return <p className={cn("rounded-xl border border-dashed border-input px-4 py-5 text-center text-sm text-muted-foreground", className)}>{t("groups.tunnel.emptySection")}</p>;
}
