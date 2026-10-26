/**
 * 我的通道群組（每個人自己的資料夾）：讀取、建立、改名、刪除、排序、整組成員、把一條通道換組。
 * 每次改動後端都回整份清單，直接換掉；換組先改畫面再送出，失敗就重抓。
 * My tunnel groups (personal folders): load, create, rename, delete, reorder, replace members, move one tunnel.
 * Every write answers the whole list, which replaces ours; moving a tunnel updates the screen first.
 */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import type { GroupsReply, TunnelGroup } from "@/types/groups";

/** 寫入的結果：成功時有剛改到的群組，失敗時有錯誤訊息（`name` 欄位的錯另外給，表單顯示在欄位下）。 */
export interface GroupWrite<T> {
    ok: boolean;
    group: T | null;
    nameError?: string;
}

/** 後端的 `{field: [msg]}` 取第一句。/ First message of a `{field: [msg]}` error. */
export function fieldMessage(body: unknown, field: string): string | undefined {
    const v = (body as Record<string, unknown> | null)?.[field];
    if (Array.isArray(v) && v.length) return String(v[0]);
    return undefined;
}

export function useTunnelGroups() {
    const { t } = useI18n();
    const { showError } = useToast();
    const [groups, setGroups] = useState<TunnelGroup[]>([]);
    const [loaded, setLoaded] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/tunnel-groups");
            const body = await readJson<GroupsReply<TunnelGroup>>(res);
            if (res.ok && body) setGroups(body.groups);
        } catch {
            /* 沒有群組就是一個平的列表。/ Without groups the list is simply flat. */
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const write = useCallback(
        async (path: string, method: string, body?: unknown): Promise<GroupWrite<TunnelGroup>> => {
            try {
                const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
                const reply = await readJson<GroupsReply<TunnelGroup>>(res);
                if (res.ok && reply) {
                    setGroups(reply.groups);
                    return { ok: true, group: reply.group };
                }
                const nameError = fieldMessage(reply, "name");
                if (!nameError) showError(responseError(res, reply, t("groups.saveFailed")));
                return { ok: false, group: null, nameError };
            } catch (e) {
                showError(e instanceof Error ? e.message : t("groups.saveFailed"));
                return { ok: false, group: null };
            }
        },
        [showError, t]
    );

    const create = useCallback((name: string, tunnelIds: number[] = []) => write("/api/reverse/tunnel-groups", "POST", { name, tunnel_ids: tunnelIds }), [write]);
    const rename = useCallback((id: number, name: string) => write(`/api/reverse/tunnel-groups/${id}`, "PATCH", { name }), [write]);
    const remove = useCallback((id: number) => write(`/api/reverse/tunnel-groups/${id}`, "DELETE"), [write]);
    const setMembers = useCallback((id: number, tunnelIds: number[]) => write(`/api/reverse/tunnel-groups/${id}/tunnels`, "PUT", { tunnel_ids: tunnelIds }), [write]);

    const reorder = useCallback(
        async (ids: number[]) => {
            // 先照新順序排，回應再換成後端的。/ Show the new order at once; the reply replaces it.
            setGroups((prev) => ids.flatMap((id, position) => prev.filter((g) => g.id === id).map((g) => ({ ...g, position }))));
            const r = await write("/api/reverse/tunnel-groups/order", "PUT", { ids });
            if (!r.ok) void load();
            return r;
        },
        [load, write]
    );

    const moveTunnel = useCallback(
        async (tunnelId: number, groupId: number | null) => {
            setGroups((prev) =>
                prev.map((g) => {
                    const without = g.tunnel_ids.filter((id) => id !== tunnelId);
                    return { ...g, tunnel_ids: g.id === groupId ? [...without, tunnelId] : without };
                })
            );
            const r = await write(`/api/reverse/server/${tunnelId}/group`, "PUT", { group_id: groupId });
            if (!r.ok) void load();
            return r;
        },
        [load, write]
    );

    return { groups, loaded, load, create, rename, remove, reorder, setMembers, moveTunnel };
}
