"use client";

/**
 * 工具箱的 info 視覺說明：片段（範圍）→ 變數填好 → 像你自己打的一樣打進 shell → Telepy 的指令規則檢查 → 在裝置上跑，
 * 每一站依最近一次執行標成 待命 / 進行中 / 通了 / 卡在這（`lib/snippets.toolboxSpotStates`）；下面是三種範圍誰能改、
 * 誰能用的小表，以及「片段不是存在裝置上的腳本」。
 * The toolbox's info visual: snippet (scope) → variables filled → typed into the shell as if you typed it → Telepy's
 * command rules → runs on the device, each spot following the latest run; then who edits / uses each scope and a
 * note that snippets are not scripts stored on the device.
 */
import React from "react";
import { Bookmark, Braces, Info, Keyboard, Server } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { runNowKey, toolboxSpotStates, type RunStage, type SnippetScope } from "@/lib/snippets";
import type { TranslationKey } from "@/locales/en";

export interface ToolboxFlowContext {
    stage: RunStage;
    /** 最近一次跑的片段。/ The snippet of the latest run. */
    snippetName: string | null;
    scope: SnippetScope | null;
    /** 問了幾個變數。/ How many variables it asked for. */
    variableCount: number;
    /** 登入的帳號（區網主機時 = 那台的帳號）。/ The login account (on a LAN host, that machine's). */
    account: string;
    tunnelName: string;
}

export const SCOPE_LABEL: Record<SnippetScope, TranslationKey> = {
    user: "toolbox.scope.user",
    tunnel: "toolbox.scope.tunnel",
    site: "toolbox.scope.site",
};

const RULES: { scope: SnippetScope; edit: TranslationKey; use: TranslationKey }[] = [
    { scope: "user", edit: "toolbox.flow.editUser", use: "toolbox.flow.useUser" },
    { scope: "tunnel", edit: "toolbox.flow.editTunnel", use: "toolbox.flow.useTunnel" },
    { scope: "site", edit: "toolbox.flow.editSite", use: "toolbox.flow.useSite" },
];

export function ToolboxFlow({ ctx }: { ctx: ToolboxFlowContext }) {
    const { t } = useI18n();
    const s = toolboxSpotStates(ctx.stage);
    const failed = ctx.stage === "blocked";
    return (
        <div className="space-y-5">
            <FlowNow failed={failed}>
                {ctx.snippetName && ctx.stage !== "idle" && <span className="mr-1.5 text-muted-foreground">{ctx.snippetName}:</span>}
                {t(runNowKey(ctx.stage))}
            </FlowNow>

            <FlowPath>
                <FlowNode
                    icon={Bookmark}
                    title={t("toolbox.flow.snippet")}
                    sub={ctx.scope ? t(SCOPE_LABEL[ctx.scope]) : t("toolbox.flow.snippetSub")}
                    state={s.snippet}
                />
                <FlowLink label={t("toolbox.flow.linkFill")} state={s.fill} className="@3xl:w-20" />
                <FlowNode
                    icon={Braces}
                    title={t("toolbox.flow.variables")}
                    sub={ctx.stage !== "idle" && ctx.variableCount === 0 ? t("toolbox.flow.variablesNone") : t("toolbox.flow.variablesSub")}
                    state={s.variables}
                />
                <FlowLink label={t("toolbox.flow.linkType")} state={s.type} className="@3xl:w-20" />
                <FlowNode icon={Keyboard} title={t("toolbox.flow.shell")} sub={t("toolbox.flow.shellSub")} state={s.shell} />
                <FlowLink label={t("toolbox.flow.linkCheck")} state={s.check} className="@3xl:w-20" />
                <FlowNode brand title="Telepy" sub={t("toolbox.flow.rulesSub")} state={s.rules} stateText={ctx.stage === "held" ? t("toolbox.flow.rulesHeld") : undefined} />
                <FlowLink label={t("toolbox.flow.linkSsh")} state={s.ssh} className="@3xl:w-20" />
                <FlowNode icon={Server} title={ctx.tunnelName} sub={t("toolbox.flow.deviceSub", { account: ctx.account })} state={s.device} />
            </FlowPath>

            <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-left text-sm">
                    <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground">
                            <th className="py-1.5 pr-3 font-normal">{t("toolbox.flow.colScope")}</th>
                            <th className="py-1.5 pr-3 font-normal">{t("toolbox.flow.colEdit")}</th>
                            <th className="py-1.5 font-normal">{t("toolbox.flow.colUse")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {RULES.map((r) => (
                            <tr key={r.scope} className="border-b border-border/60 last:border-0">
                                <td className="py-1.5 pr-3"><Chip tone={ctx.scope === r.scope ? "primary" : "neutral"}>{t(SCOPE_LABEL[r.scope])}</Chip></td>
                                <td className="py-1.5 pr-3 text-muted-foreground">{t(r.edit)}</td>
                                <td className="py-1.5 text-muted-foreground">{t(r.use)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <ul className="space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
                <li>{t("toolbox.flow.noteNotScript")}</li>
                <li>{t("toolbox.flow.noteRules")}</li>
                <li>{t("toolbox.flow.noteLines")}</li>
                <li>{t("toolbox.flow.noteSecrets")}</li>
            </ul>
        </div>
    );
}

export function ToolboxInfoDialog({ isOpen, onClose, ctx }: { isOpen: boolean; onClose: () => void; ctx: ToolboxFlowContext }) {
    const { t } = useI18n();
    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("toolbox.flow.title")}
            description={t("toolbox.flow.description")}
            icon={<Info />}
            size="4xl"
            footer={<Button onClick={onClose}>{t("common.close")}</Button>}
        >
            <ToolboxFlow ctx={ctx} />
        </Modal>
    );
}
