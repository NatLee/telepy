"use client";

/**
 * 金鑰區（`/tunnels/keys` 與它的子頁：我的金鑰、金鑰群組、裝置）共用的資料與視窗。放在 layout 裡，換子頁時不重抓、
 * 視窗狀態也不掉；新增 / 詳細資訊 / 刪除確認 / 單台裝置面板（`?device=<id>`，任何子頁都能開）各只有一份。
 * Data and dialogs shared by the keys area (`/tunnels/keys` and its sub-pages: your keys, key groups, devices).
 * Lives in the layout, so switching sub-pages neither refetches nor drops dialog state; the add / details / delete
 * dialogs and the per-device panel (`?device=<id>`, openable from any sub-page) exist once.
 */
import React, { createContext, useContext, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { AddKeyModal } from "@/components/keys/AddKeyModal";
import { DeviceKeysModal } from "@/components/keys/DeviceKeysModal";
import { KeyDetailsModal } from "@/components/keys/KeyDetailsModal";
import { useKeysPage } from "@/hooks/useKeysPage";
import { useKeyGroups } from "@/hooks/useKeyGroups";
import { useTunnelGroups } from "@/hooks/useTunnelGroups";
import { useI18n } from "@/lib/i18n";
import type { UserKey } from "@/types/keys";

function useKeysAreaState() {
    const page = useKeysPage();
    // 金鑰群組（改動會裝 / 移除金鑰，所以重抓裝置矩陣）與通道群組（授予對象、矩陣分段）。
    // Key groups (writes move keys, so the device matrix is refetched) and tunnel groups (grant targets, matrix sections).
    const keyGroups = useKeyGroups(page.fetchDevices);
    const tunnelGroups = useTunnelGroups();
    const groupNameOf = useMemo(() => {
        const m = new Map<number, string>();
        for (const g of keyGroups.groups) for (const k of g.key_ids) m.set(k, g.name);
        return m;
    }, [keyGroups.groups]);
    const [addOpen, setAddOpen] = useState(false);
    const [detailsId, setDetailsId] = useState<number | null>(null);
    const [deleting, setDeleting] = useState<UserKey | null>(null);
    return { page, keyGroups, tunnelGroups, groupNameOf, addOpen, setAddOpen, detailsId, setDetailsId, deleting, setDeleting };
}

type KeysArea = ReturnType<typeof useKeysAreaState>;

const Ctx = createContext<KeysArea | null>(null);

export function useKeysArea(): KeysArea {
    const v = useContext(Ctx);
    if (!v) throw new Error("useKeysArea outside KeysAreaProvider");
    return v;
}

function KeysAreaDialogs({ area }: { area: KeysArea }) {
    const { t } = useI18n();
    const { page, keyGroups, detailsId, setDetailsId, deleting, setDeleting } = area;
    const details = page.keys.find((k) => k.id === detailsId) ?? null;
    const deletingOn = deleting ? (page.placements.get(deleting.id) ?? []).length : 0;
    return (
        <>
            <AddKeyModal
                isOpen={area.addOpen}
                onClose={() => area.setAddOpen(false)}
                devices={page.devices}
                keyGroups={keyGroups.groups}
                onSubmit={async (k) => {
                    const ok = await page.addKey(k);
                    if (ok && k.groupId) void keyGroups.load();
                    return ok;
                }}
            />

            <KeyDetailsModal
                keyItem={details}
                devices={page.devices}
                pending={page.pending}
                onToggle={page.toggle}
                onClose={() => setDetailsId(null)}
                keyGroups={keyGroups.groups}
                onSave={async (k, patch) => {
                    const errors = await page.updateKey(k, patch);
                    if (errors === null && patch.group_id !== undefined) void keyGroups.load();
                    return errors;
                }}
                onManageDevice={(d) => {
                    setDetailsId(null);
                    page.openDevice(d.tunnel_id);
                }}
            />

            <DeviceKeysModal tunnelId={page.openDeviceId} onClose={() => page.openDevice(null)} onChanged={page.fetchDevices} />

            <ConfirmDialog
                isOpen={!!deleting}
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    if (deleting) await page.deleteKey(deleting);
                    setDeleting(null);
                }}
                title={t("keys.deleteTitle")}
                message={
                    deletingOn > 0
                        ? t("keys.deleteMessageDevices", { name: deleting?.host_friendly_name ?? "", count: deletingOn })
                        : t("keys.deleteMessage", { name: deleting?.host_friendly_name ?? "" })
                }
                confirmText={t("common.delete")}
                isDestructive
            />
        </>
    );
}

export function KeysAreaProvider({ children }: { children: React.ReactNode }) {
    const area = useKeysAreaState();
    return (
        <Ctx.Provider value={area}>
            {children}
            <KeysAreaDialogs area={area} />
        </Ctx.Provider>
    );
}
