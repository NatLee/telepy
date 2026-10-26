/**
 * 我的金鑰群組：讀取、建立、改名、刪除、整組金鑰、授予（給一條通道或一個通道群組，可只給某些帳號）、改 / 收回授予。
 * 改動會讓 Telepy 把金鑰裝上 / 移除，所以每次成功後呼叫 `onChanged`（金鑰頁重抓裝置矩陣）。
 * My key groups: load, create, rename, delete, replace keys, grant (to a tunnel or a tunnel group, optionally to
 * some accounts only), change or revoke a grant. Writes move keys on devices, so `onChanged` runs after each.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { fieldMessage, type GroupWrite } from "@/hooks/useTunnelGroups";
import type { GroupsReply, KeyGroup } from "@/types/groups";

/** 授予的對象。/ What to grant to. */
export type GrantTarget = { tunnel_id: number } | { tunnel_group_id: number };

export function useKeyGroups(onChanged?: () => void) {
    const { t } = useI18n();
    const { showError } = useToast();
    const [groups, setGroups] = useState<KeyGroup[]>([]);
    const [loaded, setLoaded] = useState(false);
    const changed = useRef(onChanged);
    changed.current = onChanged;

    const load = useCallback(async () => {
        try {
            const res = await apiFetch("/api/reverse/user/key-groups");
            const body = await readJson<GroupsReply<KeyGroup>>(res);
            if (res.ok && body) setGroups(body.groups);
        } catch {
            /* keep what we have */
        } finally {
            setLoaded(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const write = useCallback(
        async (path: string, method: string, body?: unknown): Promise<GroupWrite<KeyGroup>> => {
            try {
                const res = await apiFetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
                const reply = await readJson<GroupsReply<KeyGroup>>(res);
                if (res.ok && reply) {
                    setGroups(reply.groups);
                    changed.current?.();
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

    const base = "/api/reverse/user/key-groups";
    const create = useCallback((name: string, keyIds: number[] = []) => write(base, "POST", { name, key_ids: keyIds }), [write]);
    const rename = useCallback((id: number, name: string) => write(`${base}/${id}`, "PATCH", { name }), [write]);
    const remove = useCallback((id: number) => write(`${base}/${id}`, "DELETE"), [write]);
    const setKeys = useCallback((id: number, keyIds: number[]) => write(`${base}/${id}/keys`, "PUT", { key_ids: keyIds }), [write]);
    const grant = useCallback((id: number, target: GrantTarget, accounts: string[] | null) => write(`${base}/${id}/grants`, "POST", { ...target, accounts }), [write]);
    const updateGrant = useCallback((id: number, grantId: number, accounts: string[] | null) => write(`${base}/${id}/grants/${grantId}`, "PATCH", { accounts }), [write]);
    const revoke = useCallback((id: number, grantId: number) => write(`${base}/${id}/grants/${grantId}`, "DELETE"), [write]);

    return { groups, loaded, load, create, rename, remove, setKeys, grant, updateGrant, revoke };
}
