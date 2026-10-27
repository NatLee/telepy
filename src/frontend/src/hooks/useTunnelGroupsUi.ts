/**
 * 通道頁的群組介面狀態：哪些段落收起來（localStorage `telepy.tunnelGroupsCollapsed`）、群組管理 / 編輯 / 移到群組 /
 * 刪除確認這幾個視窗，以及它們的動作（成功時提示）。資料本身在 `useTunnelGroups`。
 * UI state for groups on the tunnels page: collapsed sections (localStorage `telepy.tunnelGroupsCollapsed`), the
 * manage / edit / move / delete dialogs and their actions (with toasts). The data lives in `useTunnelGroups`.
 */
import { useCallback, useState } from "react";
import { apiFetch, readJson } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useTunnelGroups } from "@/hooks/useTunnelGroups";
import { groupPatch, moveId } from "@/lib/groups";
import type { GroupMeta, GroupsReply, KeyGroup, TunnelGroup } from "@/types/groups";
import type { Tunnel } from "@/types/tunnel";

const COLLAPSED_KEY = "telepy.tunnelGroupsCollapsed";
/** 「未分組」段落在收合清單裡的鍵。/ The ungrouped section's key in the collapsed list. */
export const UNGROUPED = "none";

export const sectionKey = (g: TunnelGroup | null) => (g ? String(g.id) : UNGROUPED);

function readCollapsed(): Set<string> {
    try {
        const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
        return new Set(Array.isArray(v) ? v.map(String) : []);
    } catch {
        return new Set();
    }
}

export function useTunnelGroupsUi(tunnels: Tunnel[], isOnline: (t: Tunnel) => boolean) {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const data = useTunnelGroups();
    // 頁面只在瀏覽器端算繪（列表要等登入後才有），直接讀 localStorage。/ Client-only list, so read storage up front.
    const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
    const [manageOpen, setManageOpen] = useState(false);
    const [editor, setEditor] = useState<{ group: TunnelGroup | null; initial: number[] } | null>(null);
    const [moveFor, setMoveFor] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<{ group: TunnelGroup; grants: number } | null>(null);

    const toggleSection = useCallback((key: string) => {
        setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            try {
                localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
            } catch {
                /* not remembered this time */
            }
            return next;
        });
    }, []);

    const onlineOf = useCallback((g: TunnelGroup) => tunnels.filter((tn) => g.tunnel_ids.includes(tn.id) && isOnline(tn)).length, [tunnels, isOnline]);

    const submitEditor = useCallback(
        async (name: string, meta: GroupMeta, ids: number[]): Promise<string | null> => {
            const g = editor?.group;
            if (!g) {
                const r = await data.create(name, ids, meta);
                return r.ok ? null : (r.nameError ?? "");
            }
            const patch = groupPatch(g, name, meta);
            if (patch) {
                const r = await data.update(g.id, patch);
                if (!r.ok) return r.nameError ?? "";
            }
            const same = ids.length === g.tunnel_ids.length && ids.every((id) => g.tunnel_ids.includes(id));
            if (!same) {
                const r = await data.setMembers(g.id, ids);
                if (!r.ok) return "";
            }
            return null;
        },
        [data, editor]
    );

    const nameOf = (id: number) => tunnels.find((tn) => tn.id === id)?.host_friendly_name ?? `#${id}`;

    const move = useCallback(
        async (groupId: number | null) => {
            if (moveFor === null) return false;
            const r = await data.moveTunnel(moveFor, groupId);
            if (r.ok) {
                const group = data.groups.find((g) => g.id === groupId)?.name ?? r.group?.name;
                showSuccess(groupId === null || !group ? t("groups.move.doneNone", { name: nameOf(moveFor) }) : t("groups.move.done", { name: nameOf(moveFor), group }));
            }
            return r.ok;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [data, moveFor, showSuccess, t, tunnels]
    );

    const createAndMove = useCallback(
        async (name: string): Promise<string | null> => {
            if (moveFor === null) return null;
            const r = await data.create(name, [moveFor]);
            if (r.ok) showSuccess(t("groups.move.done", { name: nameOf(moveFor), group: name }));
            return r.ok ? null : (r.nameError ?? "");
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [data, moveFor, showSuccess, t, tunnels]
    );

    /** 刪之前先數有幾個金鑰群組授予給它（刪了那些金鑰會從裝置拿掉）。/ Count key group grants to it before deleting. */
    const requestDelete = useCallback(async (group: TunnelGroup) => {
        let grants = 0;
        try {
            const res = await apiFetch("/api/reverse/user/key-groups");
            const body = await readJson<GroupsReply<KeyGroup>>(res);
            grants = (body?.groups ?? []).filter((kg) => kg.grants.some((gr) => gr.tunnel_group?.id === group.id)).length;
        } catch {
            /* the confirmation just leaves that line out */
        }
        setDeleting({ group, grants });
    }, []);

    const confirmDelete = useCallback(async () => {
        if (!deleting) return;
        await data.remove(deleting.group.id);
        setDeleting(null);
    }, [data, deleting]);

    const orderedIds = [...data.groups].sort((a, b) => a.position - b.position || a.id - b.id).map((g) => g.id);
    const moveGroup = useCallback((g: TunnelGroup, delta: -1 | 1) => void data.reorder(moveId(orderedIds, g.id, delta)), [data, orderedIds]);

    return {
        ...data,
        collapsed,
        toggleSection,
        onlineOf,
        orderedIds,
        manageOpen,
        openManage: () => setManageOpen(true),
        closeManage: () => setManageOpen(false),
        editor,
        openNew: (initial: number[] = []) => setEditor({ group: null, initial }),
        openEdit: (group: TunnelGroup) => setEditor({ group, initial: [] }),
        closeEditor: () => setEditor(null),
        submitEditor,
        moveFor,
        openMove: (tunnelId: number) => setMoveFor(tunnelId),
        closeMove: () => setMoveFor(null),
        move,
        createAndMove,
        deleting,
        requestDelete,
        cancelDelete: () => setDeleting(null),
        confirmDelete,
        moveGroup,
    };
}

export type TunnelGroupsUi = ReturnType<typeof useTunnelGroupsUi>;
