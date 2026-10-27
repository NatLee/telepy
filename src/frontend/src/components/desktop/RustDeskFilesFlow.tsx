"use client";

/**
 * 「檔案」面板的 info 視覺說明：即時路徑圖 你的瀏覽器（第二份 RustDesk 核心）─ Telepy 中繼 ─ 隧道 ─ 裝置上的
 * RustDesk ─ 磁碟，每一站依連線階段與正在做的動作（下載 / 上傳 / 改名 / 刪除）標成 待命 / 進行中 / 通了 / 卡在這
 * （`lib/rustdeskFileOps.rdFileSpots`）。下面是四種動作各自的狀態，以及哪些會記進 Logs。
 * The Files panel's info visual: browser (second RustDesk core) ─ Telepy relay ─ tunnel ─ the device's RustDesk ─
 * disk, each spot waiting / active / ok / failed from the panel's phase and the action in flight; below it the four
 * actions with their state and what the Logs record.
 */
import React from "react";
import { Download, HardDrive, Info, Laptop, Loader2, Monitor, PencilLine, Trash2, Upload, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { currentOp, FILE_OP_KINDS, rdFileSpots, type FileActivity, type FileOpKind, type FileOpState, type RdFilesPhase } from "@/lib/rustdeskFileOps";
import type { TranslationKey } from "@/locales/en";

export interface RdFilesFlowContext {
    phase: RdFilesPhase;
    failure: TranslationKey | null;
    activity: FileActivity;
    /** 裝置（隧道）名稱。/ The device (tunnel) name. */
    deviceName: string;
    /** 目前的資料夾。/ The current folder. */
    path: string | null;
}

const OP_ICON: Record<FileOpKind, LucideIcon> = { download: Download, upload: Upload, rename: PencilLine, delete: Trash2 };
const OP_NOW: Record<FileOpKind, TranslationKey> = {
    download: "desktop.files.flow.now.download",
    upload: "desktop.files.flow.now.upload",
    rename: "desktop.files.flow.now.rename",
    delete: "desktop.files.flow.now.delete",
};
const OP_LINE: Record<FileOpKind, TranslationKey> = {
    download: "desktop.files.flow.op.download",
    upload: "desktop.files.flow.op.upload",
    rename: "desktop.files.flow.op.rename",
    delete: "desktop.files.flow.op.delete",
};
const OP_LABEL: Record<FileOpKind, TranslationKey> = {
    download: "desktop.streams.op.download",
    upload: "desktop.streams.op.upload",
    rename: "desktop.streams.op.rename",
    delete: "desktop.streams.op.delete",
};
const STATE_LABEL: Record<FileOpState, TranslationKey> = {
    idle: "desktop.streams.opState.idle",
    running: "desktop.streams.opState.running",
    done: "desktop.streams.opState.done",
    failed: "desktop.streams.opState.failed",
};
const STATE_TONE: Record<FileOpState, "neutral" | "primary" | "success" | "danger"> = { idle: "neutral", running: "primary", done: "success", failed: "danger" };

export function RustDeskFilesFlow({ ctx }: { ctx: RdFilesFlowContext }) {
    const { t } = useI18n();
    const op = currentOp(ctx.activity);
    const s = rdFileSpots(ctx.phase, op, ctx.failure);
    const nowKey: TranslationKey = ctx.phase === "failed" ? "desktop.files.flow.now.failed"
        : ctx.phase !== "ready" ? "desktop.files.flow.now.connecting"
            : op ? OP_NOW[op] : "desktop.files.flow.now.idle";
    return (
        <div className="space-y-5">
            <FlowNow failed={ctx.phase === "failed"}>
                {t(nowKey)}
                {ctx.phase === "failed" && ctx.failure && <span className="mt-0.5 block text-xs text-muted-foreground">{t(ctx.failure)}</span>}
            </FlowNow>

            <FlowPath>
                <FlowNode icon={Laptop} title={t("flow.you")} sub={t("desktop.files.flow.youSub")} state={s.browser} />
                <FlowLink label={t("flow.linkWeb")} state={s.web} />
                <FlowNode brand title="Telepy" sub={t("desktop.files.flow.telepySub")} state={s.relay} />
                <FlowLink label={t("flow.linkTunnel")} state={s.tunnel} />
                <FlowNode icon={Monitor} title={ctx.deviceName} sub={t("desktop.files.flow.rustdeskSub")} state={s.rustdesk} />
                <FlowLink label={t("desktop.files.flow.linkDisk")} state={s.local} />
                <FlowNode icon={HardDrive} title={t("desktop.files.flow.disk")} sub={ctx.path ? <span className="font-mono break-all">{ctx.path}</span> : t("desktop.files.flow.diskSub")} state={s.disk} />
            </FlowPath>

            <ul className="grid gap-2 sm:grid-cols-2" aria-label={t("desktop.files.flow.opsTitle")}>
                {FILE_OP_KINDS.map((k) => {
                    const state = ctx.activity[k];
                    const Icon = state === "running" ? Loader2 : OP_ICON[k];
                    return (
                        <li key={k} className="flex items-start gap-2.5 rounded-md border border-border bg-surface px-3 py-2" data-op={k} data-state={state}>
                            <Icon size={15} className={state === "running" ? "mt-0.5 shrink-0 animate-spin text-primary" : "mt-0.5 shrink-0 text-muted-foreground"} aria-hidden />
                            <div className="min-w-0 flex-1 space-y-0.5">
                                <div className="flex flex-wrap items-center justify-between gap-x-2">
                                    <span className="text-sm text-foreground">{t(OP_LABEL[k])}</span>
                                    <Chip tone={STATE_TONE[state]}>{t(STATE_LABEL[state])}</Chip>
                                </div>
                                <p className="text-xs leading-snug text-muted-foreground">{t(OP_LINE[k])}</p>
                            </div>
                        </li>
                    );
                })}
            </ul>

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{t("desktop.files.flow.noteSecondCore")}</li>
                <li>{t("desktop.files.flow.noteRelay")}</li>
                <li>{t("desktop.files.flow.noteLogged")}</li>
                <li>{t("desktop.files.flow.noteAccount")}</li>
            </ul>
        </div>
    );
}

export function RustDeskFilesFlowDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: RdFilesFlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("desktop.files.flow.title")}
            description={t("desktop.files.flow.description")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <RustDeskFilesFlow ctx={ctx} />
        </Modal>
    );
}
