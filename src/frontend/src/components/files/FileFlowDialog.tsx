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
import { Info, Laptop, Router, Server, UserRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { authLabel } from "@/lib/lanFiles";
import { fileSpotStates, flowNow, lanSpotStates, type Busy, type FileLink, type FileSpot, type SpotState } from "@/lib/fileManager";

/** 區網主機那一跳（`lan::files`）。/ The LAN host hop. */
export interface LanFlowContext {
    /** 那台主機上的帳號。/ The account on the LAN host. */
    login: string;
    address: string;
    port: number;
    /** 經過的裝置帳號（跳板）。/ The device account it goes through. */
    account: string;
    /** 怎麼登入的（後端的說法，原文顯示）。/ How it logged in (the backend's words). */
    auth: string;
    /** 那台主機出示的 host key。/ The host key it showed. */
    fingerprint: string;
}

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
    lan?: LanFlowContext;
}

/** 區網主機的檔案：多一跳（裝置的 sshd 開往那台）。/ A LAN host's files: one more hop. */
function LanFileFlow({ ctx, lan }: { ctx: FileFlowContext; lan: LanFlowContext }) {
    const { t, tn } = useI18n();
    const s = lanSpotStates(ctx.link, ctx.busy);
    const now = flowNow(ctx.link, ctx.busy);
    const failed = ctx.link !== "open" && ctx.link !== "connecting";
    const where = lan.port === 22 ? lan.address : `${lan.address}:${lan.port}`;
    const label = authLabel(lan.auth);
    const authText = label ? t(label.key, label.vars) : lan.auth;
    return (
        <div className="space-y-5">
            <FlowNow failed={failed}>{t(now.key, now.vars)}</FlowNow>

            <FlowPath>
                <FlowNode icon={Laptop} title={t("files.flow.you")} sub={t("files.flow.youSub")} state={s.browser} />
                <FlowLink label={t("files.flow.linkWeb")} state={s.web} />
                <FlowNode brand title="Telepy" sub={t("files.lanFlow.telepySub")} state={s.telepy} />
                <FlowLink label={t("files.lanFlow.linkTunnel")} state={s.tunnel} />
                <FlowNode icon={Router} title={<span className="font-mono">{`${lan.account}@${ctx.deviceName}`}</span>} sub={t("files.lanFlow.deviceSub")} state={s.device} />
                <FlowLink label={t("files.lanFlow.linkHop")} state={s.hop} />
                <FlowNode icon={Server} title={<span className="font-mono">{`${lan.login}@${where}`}</span>} sub={t("files.lanFlow.hostSub")} state={s.host} />
            </FlowPath>

            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {t("files.flow.here")}
                <Chip mono>{`${lan.login}@${lan.address}`}</Chip>
                <code className="min-w-0 rounded-sm bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground break-all">{ctx.path}</code>
            </div>

            {ctx.link === "lanGone" && <Callout tone="warning">{t("files.lanFlow.goneNote")}</Callout>}
            {ctx.link === "offline" && <Callout tone="warning">{t("files.flow.offlineNote")}</Callout>}

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{tn("files.lanFlow.noteLogin", { login: <code className="font-mono text-foreground">{lan.login}</code>, auth: authText })}</li>
                <li>{tn("files.lanFlow.noteHop", { account: <code className="font-mono text-foreground">{lan.account}</code>, device: ctx.deviceName })}</li>
                <li>{tn("files.lanFlow.noteHostKey", { fingerprint: <code className="font-mono text-foreground break-all">{lan.fingerprint || "—"}</code> })}</li>
                <li>{t("files.lanFlow.noteIdle")}</li>
                <li>{t("files.lanFlow.noteUploads")}</li>
                <li>{t("files.flow.noteLogged")}</li>
            </ul>
        </div>
    );
}

export function FileFlow({ ctx }: { ctx: FileFlowContext }) {
    const { t, tn } = useI18n();
    if (ctx.lan) return <LanFileFlow ctx={ctx} lan={ctx.lan} />;
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
