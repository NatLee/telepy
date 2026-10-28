"use client";

/**
 * CLI 頁的資訊按鈕：CLI 怎麼到你的裝置——兩條路，用直線畫、跟著現況亮：
 *   大部分指令：你的終端機（telepy）─HTTPS + 你的登入─ Telepy（scope、指令規則、稽核）─隧道─ 裝置
 *   ssh / scp / sftp：你的終端機（OpenSSH）─你的個人 SSH 金鑰─ Telepy 的閘道 ─隧道─ 裝置的 sshd
 * 狀態來自 `lib/cliGuide.cliLanes`（有測試）：CLI 登入過沒、有沒有個人金鑰。
 * The CLI page's info button: how the CLI reaches your devices — two lanes in straight lines, lit by the current
 * state (`cliLanes`, tested): whether the CLI has signed in, and whether you have a personal SSH key.
 */
import React from "react";
import Link from "next/link";
import { HardDrive, KeyRound, SquareTerminal, Terminal } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { cliLanes, type CliLane } from "@/lib/cliGuide";
import type { LucideIcon } from "lucide-react";

function Lane({ title, commands, lane, icon, you, youSub, link, linkText, telepySub, deviceSub }: {
    title: string;
    commands: string;
    lane: CliLane;
    icon: LucideIcon;
    you: string;
    youSub: string;
    link: string;
    linkText?: string;
    telepySub: string;
    deviceSub: string;
}) {
    const { t } = useI18n();
    return (
        <section aria-label={title} className="space-y-2 rounded-xl border border-border p-3">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm text-foreground">{title}</span>
                <code className="font-mono text-xs text-muted-foreground">{commands}</code>
            </div>
            <FlowPath>
                <FlowNode icon={icon} title={you} sub={youSub} state={lane.you} />
                {/* note 是給往返時間的等寬數字；狀態用一般字放在標籤第二行。/ `note` is for round-trip figures; the state is a second label line. */}
                <FlowLink
                    label={
                        <>
                            {link}
                            {linkText && <span className="block">{linkText}</span>}
                        </>
                    }
                    state={lane.credential}
                />
                <FlowNode brand title="Telepy" sub={telepySub} state={lane.telepy} />
                <FlowLink label={t("cli.flow.tunnel")} state={lane.tunnel} />
                <FlowNode icon={HardDrive} title={t("cli.flow.device")} sub={deviceSub} state={lane.device} />
            </FlowPath>
        </section>
    );
}

export function CliFlowDialog({ isOpen, onClose, signedIn, keyCount }: { isOpen: boolean; onClose: () => void; signedIn: boolean; keyCount: number | null }) {
    const { t } = useI18n();
    const lanes = cliLanes(signedIn, keyCount);
    return (
        <Modal isOpen={isOpen} onClose={onClose} size="5xl" icon={<Terminal />} title={t("cli.flow.title")} description={t("cli.flow.description")}>
            <div className="space-y-4">
                <Lane
                    title={t("cli.flow.restLane")}
                    commands="ls · exec · cp · sessions · run · browse · lan"
                    lane={lanes.rest}
                    icon={Terminal}
                    you={t("cli.flow.you")}
                    youSub="telepy"
                    link={t("cli.flow.restLink")}
                    linkText={signedIn ? t("cli.flow.signedIn") : t("cli.flow.notSignedIn")}
                    telepySub={t("cli.flow.restTelepy")}
                    deviceSub={t("cli.flow.restDevice")}
                />
                <Lane
                    title={t("cli.flow.sshLane")}
                    commands="ssh · scp · sftp"
                    lane={lanes.ssh}
                    icon={SquareTerminal}
                    you={t("cli.flow.you")}
                    youSub="OpenSSH"
                    link={t("cli.flow.sshLink")}
                    linkText={keyCount === null ? undefined : keyCount === 0 ? t("cli.flow.noKey") : t("cli.flow.keys", { count: keyCount })}
                    telepySub={t("cli.flow.sshTelepy")}
                    deviceSub={t("cli.flow.sshDevice")}
                />
                {keyCount === 0 && (
                    <p className="flex flex-wrap items-center gap-2 text-sm text-warning">
                        <KeyRound size={15} aria-hidden />
                        {t("cli.try.noKey")}
                        <Link href="/tunnels/keys" className="text-foreground underline underline-offset-4" onClick={onClose}>
                            {t("cli.try.addKey")}
                        </Link>
                    </p>
                )}
                <ul className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground marker:text-border">
                    <li>{t("cli.flow.p1")}</li>
                    <li>{t("cli.flow.p2")}</li>
                    <li>{t("cli.flow.p3")}</li>
                    <li>{t("cli.flow.p4")}</li>
                </ul>
            </div>
        </Modal>
    );
}
