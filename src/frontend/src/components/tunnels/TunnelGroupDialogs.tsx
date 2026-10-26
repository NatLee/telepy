/**
 * 通道頁的群組視窗們（管理、編輯、移到群組、刪除確認），狀態來自 `useTunnelGroupsUi`。
 * The tunnels page's group dialogs (manage, edit, move, delete), driven by `useTunnelGroupsUi`.
 */
import React from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TunnelGroupsDialog } from "@/components/tunnels/TunnelGroupsDialog";
import { TunnelGroupEditor } from "@/components/tunnels/TunnelGroupEditor";
import { MoveToGroupDialog } from "@/components/tunnels/MoveToGroupDialog";
import { useI18n } from "@/lib/i18n";
import { groupOf } from "@/lib/groups";
import type { TunnelGroupsUi } from "@/hooks/useTunnelGroupsUi";
import type { Tunnel, TunnelHealth } from "@/types/tunnel";

export function TunnelGroupDialogs({ ui, tunnels, health }: { ui: TunnelGroupsUi; tunnels: Tunnel[]; health: (t: Tunnel) => TunnelHealth }) {
    const { t } = useI18n();
    const moving = ui.moveFor !== null ? tunnels.find((tn) => tn.id === ui.moveFor) : undefined;
    return (
        <>
            <TunnelGroupsDialog
                open={ui.manageOpen && !ui.editor && !ui.deleting}
                groups={ui.groups}
                onlineCount={ui.onlineOf}
                onClose={ui.closeManage}
                onNew={() => ui.openNew()}
                onEdit={ui.openEdit}
                onDelete={(g) => void ui.requestDelete(g)}
                onReorder={(ids) => void ui.reorder(ids)}
            />
            {ui.editor && (
                <TunnelGroupEditor
                    key={ui.editor.group?.id ?? "new"}
                    group={ui.editor.group}
                    groups={ui.groups}
                    tunnels={tunnels}
                    health={health}
                    initialTunnelIds={ui.editor.initial}
                    onClose={ui.closeEditor}
                    onSubmit={ui.submitEditor}
                />
            )}
            {moving && (
                <MoveToGroupDialog
                    tunnel={moving}
                    groups={ui.groups}
                    current={groupOf(ui.groups).get(moving.id) ?? null}
                    onClose={ui.closeMove}
                    onMove={ui.move}
                    onCreate={ui.createAndMove}
                />
            )}
            <ConfirmDialog
                isOpen={!!ui.deleting}
                onClose={ui.cancelDelete}
                onConfirm={() => void ui.confirmDelete()}
                title={t("groups.tunnel.deleteTitle")}
                message={
                    ui.deleting ? (
                        <>
                            <span className="block">{t("groups.tunnel.deleteMessage", { name: ui.deleting.group.name, count: ui.deleting.group.tunnel_ids.length })}</span>
                            {ui.deleting.grants > 0 && <span className="mt-2 block text-warning">{t("groups.tunnel.deleteGrants", { count: ui.deleting.grants })}</span>}
                        </>
                    ) : (
                        ""
                    )
                }
                confirmText={t("common.delete")}
                isDestructive
            />
        </>
    );
}
