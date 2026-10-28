"use client";

/**
 * 「指令不寫進 shell 歷史檔」怎麼做到的：你（打字、工具箱、MCP app）─ Telepy ─ 裝置上的 shell ─ 歷史檔。
 * 上方切換「照常寫 / 不寫」看最後一段怎麼變；下面是 shell 開起來時 Telepy 做的三件事、每種 shell 打的那一行，
 * 以及背景檢查本來就不進歷史、裝置強制保留時不繞過、哪些情況管不到。
 * How keeping commands out of the shell history works: you ─ Telepy ─ the device's shell ─ its history file, with a
 * switch between the two modes; below, what Telepy does when a shell opens, the line per shell and the limits.
 */
import React, { useState } from "react";
import { FileClock, Keyboard, SquareTerminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { MODE_LABEL, SETUP_COMMANDS, type HistoryMode } from "@/lib/shellHistory";

export function ShellHistoryInfoDialog({ isOpen, onClose, mode }: { isOpen: boolean; onClose: () => void; mode: HistoryMode }) {
    const { t } = useI18n();
    // 上方的切換只是預覽；關掉就回到實際的選擇。/ The toggle only previews; closing returns to the real choice.
    const [preview, setPreview] = useState<HistoryMode | null>(null);
    const shown = preview ?? mode;
    const off = shown === "skip";
    const close = () => {
        setPreview(null);
        onClose();
    };
    return (
        <Modal
            isOpen={isOpen}
            onClose={close}
            size="4xl"
            title={t("shellHistory.flow.title")}
            description={t("shellHistory.flow.description")}
            toolbar={
                <Segmented
                    size="sm"
                    aria-label={t("shellHistory.title")}
                    value={shown}
                    onChange={setPreview}
                    options={(["keep", "skip"] as const).map((m) => ({ value: m, label: t(MODE_LABEL[m]) }))}
                />
            }
            footer={<Button onClick={close}>{t("common.close")}</Button>}
        >
            <div className="space-y-6">
                <FlowPath>
                    <FlowNode icon={Keyboard} title={t("shellHistory.flow.you")} sub={t("shellHistory.flow.youSub")} state="ok" stateText={t("shellHistory.flow.typing")} />
                    <FlowLink label={t("shellHistory.flow.linkKeys")} state="ok" />
                    <FlowNode brand title="Telepy" sub={off ? t("shellHistory.flow.telepyOff") : t("shellHistory.flow.telepyKeep")} state="ok" stateText={off ? t("shellHistory.flow.setsUp") : t("shellHistory.flow.passes")} />
                    <FlowLink label={t("shellHistory.flow.linkSsh")} state="ok" />
                    <FlowNode icon={SquareTerminal} title={t("shellHistory.flow.shell")} sub={t("shellHistory.flow.shellSub")} state="ok" stateText={t("shellHistory.flow.runs")} />
                    <FlowLink label={off ? t("shellHistory.flow.linkNotWritten") : t("shellHistory.flow.linkSaved")} state={off ? "waiting" : "ok"} />
                    <FlowNode
                        icon={FileClock}
                        title={t("shellHistory.flow.file")}
                        sub={t("shellHistory.flow.fileSub")}
                        state={off ? "waiting" : "ok"}
                        stateText={off ? t("shellHistory.flow.fileUntouched") : t("shellHistory.flow.fileGets")}
                    />
                </FlowPath>

                <section className="space-y-2">
                    <SectionHeading title={t("shellHistory.flow.stepsTitle")} />
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-foreground marker:text-muted-foreground">
                        <li>{t("shellHistory.flow.step1")}</li>
                        <li>{t("shellHistory.flow.step2")}</li>
                        <li>{t("shellHistory.flow.step3")}</li>
                    </ol>
                    <dl className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
                        {SETUP_COMMANDS.map((c) => (
                            <div key={c.shells} className="grid grid-cols-[minmax(5rem,7rem)_1fr] items-baseline gap-3 py-2 text-sm">
                                <dt className="text-muted-foreground">{c.shells}</dt>
                                <dd className="min-w-0 font-mono break-all text-foreground">{c.command}</dd>
                            </div>
                        ))}
                    </dl>
                </section>

                <section className="space-y-2">
                    <SectionHeading title={t("shellHistory.flow.goodTitle")} />
                    <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground marker:text-muted-foreground">
                        <li>{t("shellHistory.flow.background")}</li>
                        <li>{t("shellHistory.flow.enforced")}</li>
                        <li>{t("shellHistory.flow.records")}</li>
                    </ul>
                    <Callout tone="warning" title={t("shellHistory.flow.limitsTitle")}>
                        {t("shellHistory.flow.limits")}
                    </Callout>
                </section>
            </div>
        </Modal>
    );
}
