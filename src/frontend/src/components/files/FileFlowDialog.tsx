"use client";

/**
 * 檔案管理的 info 視覺說明：即時路徑圖 你的瀏覽器 ─ Telepy ─（一條共用的 SFTP channel）─ 裝置上的帳號，
 * 每一段依連線狀態與正在跑的操作標成 待命 / 進行中 / 通了 / 卡在這（`lib/fileManager.fileSpotStates`）。
 * 下面說明檔案屬於哪個 OS 帳號、權限就是那個帳號的權限（所以有些檔案唯讀）、哪些操作會記進日誌。
 * 寬容器橫向、窄容器直向（container query），手機上直向堆疊。
 * The file manager's info visual: a live path browser ─ Telepy ─ (one shared SFTP channel) ─ the device account, each
 * spot waiting / active / ok / failed from the socket state and the operation in flight; notes below say whose files
 * these are and why some are read-only. Horizontal when wide, stacked when narrow.
 */
import React from "react";
import { Info, Laptop, UserRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { fileSpotStates, flowNow, type Busy, type FileLink, type FileSpot, type SpotState } from "@/lib/fileManager";

export interface FileFlowContext {
    link: FileLink;
    busy: Busy | null;
    /** 登入裝置的 OS 帳號。/ The OS account on the device. */
    account: string;
    /** 隧道（裝置）名稱。/ The tunnel (device) name. */
    deviceName: string;
    /** 目前的資料夾。/ The current folder. */
    path: string;
    shell: "unix" | "powershell";
}

export function FileFlow({ ctx }: { ctx: FileFlowContext }) {
    const { t, tn } = useI18n();
    const s: Record<FileSpot, SpotState> = fileSpotStates(ctx.link, ctx.busy);
    const now = flowNow(ctx.link, ctx.busy);
    const failed = ctx.link === "offline" || ctx.link === "stepup" || ctx.link === "stopped" || ctx.link === "retrying";
    return (
        <div className="space-y-5">
            <FlowNow failed={failed}>{t(now.key, now.vars)}</FlowNow>

            <FlowPath>
                <FlowNode icon={Laptop} title={t("files.flow.you")} sub={t("files.flow.youSub")} state={s.browser} />
                <FlowLink label={t("files.flow.linkWeb")} state={s.web} />
                <FlowNode brand title="Telepy" sub={t("files.flow.telepySub")} state={s.telepy} />
                <FlowLink label={t("files.flow.linkChannel")} state={s.channel} />
                <FlowNode icon={UserRound} title={<span className="font-mono">{`${ctx.account}@${ctx.deviceName}`}</span>} sub={t("files.flow.accountSub")} state={s.account} />
            </FlowPath>

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {t("files.flow.here")}
                <Chip mono>{ctx.account}</Chip>
                <code className="min-w-0 rounded-sm bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground break-all">{ctx.path}</code>
            </div>

            {ctx.link === "stepup" && <Callout tone="warning">{t("files.flow.stepUpNote")}</Callout>}
            {ctx.link === "offline" && <Callout tone="warning">{t("files.flow.offlineNote")}</Callout>}

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{tn("files.flow.noteAccount", { account: <code className="font-mono text-foreground">{ctx.account}</code> })}</li>
                <li>{t(ctx.shell === "powershell" ? "files.flow.notePermissionsWindows" : "files.flow.notePermissions")}</li>
                <li>{t("files.flow.noteChannel")}</li>
                <li>{t("files.flow.noteSave")}</li>
                <li>{t("files.flow.noteLogged")}</li>
            </ul>
        </div>
    );
}

export function FileFlowDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: FileFlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("files.flow.title")}
            description={t("files.flow.description")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <FileFlow ctx={ctx} />
        </Modal>
    );
}
