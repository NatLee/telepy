/**
 * 通道列表的群組段落標題：收合 / 展開、名稱、幾條（搜尋時「N 條中的 M 條」）與幾條在線，右邊是群組選單
 * （編輯、上下移、刪除）；群組的標籤與說明在下一行。卡片檢視用 `GroupHeader`，表格檢視用 `GroupHeaderRow`（同一份內容放進一列）。
 * Section header for a tunnel group: collapse toggle, name, counts (and "M of N" while filtering), online count,
 * and the group menu (edit, move up / down, delete); the group's labels and description on a line below. Cards use `GroupHeader`, the table `GroupHeaderRow`.
 */
import React from "react";
import { ArrowDown, ArrowUp, ChevronRight, Folder, FolderOpen, MoreHorizontal, SquarePen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { TunnelLabels } from "@/components/tunnels/TunnelTags";
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
    /** 數量後面的補充（例如金鑰頁的「N 台需要處理」）。/ Extra text after the counts (e.g. the keys page's "N need attention"). */
    extra?: React.ReactNode;
    /** 標題元素的 id（分頁換頁後捲回這裡）。/ The header element's id (paging scrolls back to it). */
    id?: string;
    /** 點群組的標籤（通道頁：加進搜尋）。/ Clicking one of the group's labels (tunnels page: adds it to the search). */
    onLabel?: (label: string) => void;
}

function GroupMenu({ group, isFirst, isLast, onEdit, onMove, onDelete }: GroupHeaderProps) {
    const { t } = useI18n();
    // 沒給動作（金鑰頁的裝置矩陣只是借用分段）就不顯示選單。/ No actions (the keys page only borrows the sections): no menu.
    if (!group || !onEdit) return null;
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

/** 群組的標籤與說明（有才顯示）：標題下一行，說明最多兩行，完整的在 tooltip。/ The group's labels and description under
 *  the title (the description up to two lines, in full on hover); nothing when there are neither. */
function GroupMetaLine({ group, onLabel }: { group: TunnelGroup | null; onLabel?: (label: string) => void }) {
    const labels = group?.labels ?? [];
    const description = group?.description ?? "";
    if (!labels.length && !description) return null;
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-0.5 pl-6">
            <TunnelLabels labels={labels} onLabel={onLabel} />
            {/* 放不下 16rem 就換到下一行，最多兩行（不切成「…」一行）。/ Wraps below the labels when under 16rem fits; two lines at most. */}
            {description && (
                <p className="line-clamp-2 min-w-[min(100%,16rem)] flex-1 text-xs text-muted-foreground" title={description}>{description.replace(/\s+/g, " ")}</p>
            )}
        </div>
    );
}

function HeaderContent(p: GroupHeaderProps) {
    return (
        <>
            <HeaderLine {...p} />
            <GroupMetaLine group={p.group} onLabel={p.onLabel} />
        </>
    );
}

function HeaderLine(p: GroupHeaderProps) {
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
            {p.extra}
            <span className="ml-auto shrink-0">
                <GroupMenu {...p} />
            </span>
        </div>
    );
}

/** 卡片檢視的段落標題。/ Section header for the card view. */
export function GroupHeader(p: GroupHeaderProps) {
    return (
        <div id={p.id} className="scroll-mt-20 border-b border-border pb-1.5">
            <HeaderContent {...p} />
        </div>
    );
}

/** 表格檢視：一列橫跨所有欄位的段落標題。/ Section header row spanning the table. */
export function GroupHeaderRow({ colSpan, ...p }: GroupHeaderProps & { colSpan: number }) {
    return (
        <tr id={p.id} className="scroll-mt-20 bg-surface/60">
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
