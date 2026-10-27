"use client";

/**
 * SSH 金鑰 › 裝置：我的金鑰 × 我能用的裝置。勾選 = 放進那台裝置的金鑰清單；欄位是「金鑰欄」挑的金鑰，列依通道群組
 * 分段並分頁，搜尋對全部裝置。單台裝置的管理面板用 `?device=<id>` 打開（隧道選單會連過來）。
 * SSH keys › Devices: my keys × the devices I can use. A tick puts the key on that device's list; columns are the
 * keys picked with "key columns", rows are split by tunnel group and paged, and the search covers every device.
 * The per-device panel opens with `?device=<id>` (linked from the tunnel menu).
 */
import React from "react";
import { DeviceMatrix } from "@/components/keys/DeviceMatrix";
import { KeyColumnsPicker, useKeyColumns } from "@/components/keys/KeyColumnsPicker";
import { useKeysArea } from "@/components/keys/KeysArea";
import { useI18n } from "@/lib/i18n";

export default function KeyDevicesPage() {
    const { t } = useI18n();
    const { page, tunnelGroups } = useKeysArea();
    const { columns, setChosen } = useKeyColumns(page.keys);
    return (
        <section aria-label={t("keys.devices")} className="space-y-3">
            <p className="max-w-3xl text-sm text-muted-foreground">{t("keys.devicesDescription")}</p>
            {page.loading && page.devices.length === 0 ? (
                <div className="flex justify-center py-12 text-muted-foreground">
                    <div className="mr-3 h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    {t("keys.loading")}
                </div>
            ) : (
                <DeviceMatrix
                    devices={page.devices}
                    keys={columns}
                    toolbar={<KeyColumnsPicker keys={page.keys} columns={columns} onChange={setChosen} />}
                    tunnelGroups={tunnelGroups.groups}
                    pending={page.pending}
                    syncing={page.syncing}
                    onToggle={page.toggle}
                    onSync={page.syncDevice}
                    onManage={(d) => page.openDevice(d.tunnel_id)}
                />
            )}
        </section>
    );
}
