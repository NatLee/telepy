"use client";

/**
 * 刪除隧道:先列出會發生什麼(裝置被踢掉、誰失去存取、在用的人、區網主機),再讓使用者決定
 * 裝置上的金鑰(Telepy 裝過的、服務金鑰)與 MCP 授權怎麼處理;刪完在同一個對話框顯示清理結果。
 * Delete a tunnel: list what happens first (device dropped, who loses access, people using it, LAN
 * hosts), let the user decide about keys on the device and MCP authorizations, then show what was cleaned.
 */
import React from "react";
import { Bot, Check, CircleAlert, CircleCheck, Info, KeyRound, ListChecks, Loader2, Trash2, TriangleAlert } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useDeleteTunnel, type DeleteCheck, type DeleteCheckGrant, type DeleteOptions, type DeleteReport } from "@/hooks/useDeleteTunnel";

interface DeleteTunnelDialogProps {
    isOpen: boolean;
    tunnelId: number | null;
    name: string;
    onClose: () => void;
    /** 刪除成功(列表要重抓)。/ Deleted; the list should reload. */
    onDeleted: () => void;
}

type Tone = "neutral" | "warning" | "success" | "danger";

const TONE_ICON: Record<Tone, React.ReactNode> = {
    neutral: <Info size={15} className="text-muted-foreground" />,
    warning: <TriangleAlert size={15} className="text-warning" />,
    success: <CircleCheck size={15} className="text-success" />,
    danger: <CircleAlert size={15} className="text-destructive" />,
};

/** 一行影響 / 結果:圖示 + 文字(+ 細節)。/ One impact or result line. */
function Line({ tone = "neutral", children, detail }: { tone?: Tone; children: React.ReactNode; detail?: React.ReactNode }) {
    return (
        <li className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm">
            <span className="mt-0.5 shrink-0" aria-hidden>{TONE_ICON[tone]}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-foreground">{children}</span>
                {detail && <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>}
            </span>
        </li>
    );
}

function Lines({ children }: { children: React.ReactNode }) {
    return <ul className="divide-y divide-border rounded-lg border border-border">{children}</ul>;
}

/** 勾選項:整張卡片可點,停用時說明原因。/ A checkbox option card; explains why when disabled. */
function Option({
    checked,
    disabled,
    onChange,
    title,
    description,
    children,
}: {
    checked: boolean;
    disabled?: boolean;
    onChange: (v: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
}) {
    return (
        <label
            className={cn(
                "flex items-start gap-3 rounded-lg border border-border px-3.5 py-3 transition-colors",
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-muted/40 has-[:checked]:border-destructive/40 has-[:checked]:bg-destructive/5",
            )}
        >
            <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-destructive" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{title}</span>
                {description && <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>}
                {children}
            </span>
        </label>
    );
}

function grantLabel(g: DeleteCheckGrant, t: ReturnType<typeof useI18n>["t"]) {
    return g.mine ? g.client_name : t("deleteTunnel.grantOf", { app: g.client_name, user: g.user.username });
}

export function DeleteTunnelDialog({ isOpen, tunnelId, name, onClose, onDeleted }: DeleteTunnelDialogProps) {
    const { t, tn } = useI18n();
    const { check, checkError, loading, options, setOption, deleting, error, report, submit } = useDeleteTunnel(tunnelId, isOpen, onDeleted);
    const strong = <strong>{name}</strong>;

    const touchesDevice = !!check?.online && ((options.removeDeviceKeys && check.device_keys.length > 0) || options.removeServiceKey);

    return (
        <Modal
            isOpen={isOpen}
            onClose={deleting ? () => {} : onClose}
            title={report ? t("deleteTunnel.doneTitle") : t("tunnels.deleteTitle")}
            description={report ? tn("deleteTunnel.doneDescription", { name: strong }) : tn("deleteTunnel.description", { name: strong })}
            icon={report ? <Check /> : <Trash2 />}
            tone={report ? "default" : "danger"}
            size="2xl"
            isLoading={loading}
            footer={
                report ? (
                    <Button type="button" onClick={onClose}>
                        {t("common.close")}
                    </Button>
                ) : (
                    <>
                        <Button type="button" variant="outline" onClick={onClose} disabled={deleting}>
                            {t("common.cancel")}
                        </Button>
                        <Button type="button" variant="destructive" onClick={submit} disabled={!check || deleting}>
                            {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
                            {deleting ? (touchesDevice ? t("deleteTunnel.cleaningDevice") : t("deleteTunnel.deleting")) : t("deleteTunnel.confirm")}
                        </Button>
                    </>
                )
            }
        >
            {report ? (
                <ReportView report={report} tunnelId={tunnelId} />
            ) : checkError ? (
                <Callout tone="danger">{checkError}</Callout>
            ) : check ? (
                <CheckView check={check} options={options} setOption={setOption} />
            ) : (
                <div className="min-h-40" aria-hidden />
            )}
            {!report && error && <Callout tone="danger" className="mt-4">{error}</Callout>}
        </Modal>
    );
}

function CheckView({ check, options, setOption }: { check: DeleteCheck; options: DeleteOptions; setOption: <K extends keyof DeleteOptions>(key: K, value: DeleteOptions[K]) => void }) {
    const { t, tn } = useI18n();
    const code = (text: string) => <code>{text}</code>;
    const only = check.grants.filter((g) => g.coverage === "only");
    const shared = check.grants.filter((g) => g.coverage === "shared");
    const all = check.grants.filter((g) => g.coverage === "all");
    const keyCount = check.device_keys.length;
    const nothingMcp = check.grants.length === 0 && check.ai_sessions.length === 0;
    return (
        <div className="space-y-6">
            {/* 會發生什麼 / What happens */}
            <Section icon={<ListChecks />} title={t("deleteTunnel.impactTitle")}>
                <Lines>
                    <Line tone="warning" detail={tn("deleteTunnel.deviceRetries", { script: code(`~/.ssh/telepy-uninstall-${check.tunnel.id}.sh`) })}>
                        {check.online ? t("deleteTunnel.deviceOnline") : t("deleteTunnel.deviceOffline")}
                    </Line>
                    {check.in_use > 0 && <Line tone="warning">{t("deleteTunnel.inUse", { count: check.in_use })}</Line>}
                    {check.sharees.length > 0 && (
                        <Line
                            detail={
                                <span className="flex flex-wrap gap-1">
                                    {check.sharees.map((s) => (
                                        <Chip key={s.id}>
                                            {s.username} · {s.permission.toUpperCase()}
                                        </Chip>
                                    ))}
                                </span>
                            }
                        >
                            {t("deleteTunnel.sharees", { count: check.sharees.length })}
                        </Line>
                    )}
                    {check.accounts.length > 0 && (
                        <Line
                            detail={
                                <span className="flex flex-wrap gap-1">
                                    {check.accounts.map((a) => (
                                        <Chip key={a} mono>{a}</Chip>
                                    ))}
                                </span>
                            }
                        >
                            {t("deleteTunnel.accounts", { count: check.accounts.length })}
                        </Line>
                    )}
                    {check.lan_hosts > 0 && <Line>{t("deleteTunnel.lanHosts", { count: check.lan_hosts })}</Line>}
                    <Line>{t("deleteTunnel.historyKept")}</Line>
                </Lines>
            </Section>

            {/* 裝置上的金鑰 / Keys on the device */}
            <Section icon={<KeyRound />} title={t("deleteTunnel.keysTitle")} description={t("deleteTunnel.keysDescription")}>
                {!check.online && (keyCount > 0 || check.accounts.length > 0) && <Callout tone="warning">{t("deleteTunnel.keysOffline")}</Callout>}
                {keyCount > 0 ? (
                    <Option
                        checked={check.online && options.removeDeviceKeys}
                        disabled={!check.online}
                        onChange={(v) => setOption("removeDeviceKeys", v)}
                        title={t("deleteTunnel.removeKeys", { count: keyCount })}
                        description={check.online ? t("deleteTunnel.removeKeysHint") : undefined}
                    >
                        <ul className="mt-2 space-y-1">
                            {check.device_keys.map((k) => (
                                <li key={k.fingerprint} className="text-xs text-muted-foreground">
                                    <span className="text-foreground">{k.name ?? t("deleteTunnel.keyUnnamed")}</span>
                                    {k.owner && ` · ${k.owner}`}
                                    {!k.in_list && ` · ${t("deleteTunnel.keyPendingRemoval")}`}
                                    <span className="block break-all font-mono">{k.fingerprint}</span>
                                    <span className="block">{t("deleteTunnel.keyIn", { accounts: k.accounts.join(", ") })}</span>
                                </li>
                            ))}
                        </ul>
                    </Option>
                ) : (
                    <p className="text-sm text-muted-foreground">{t("deleteTunnel.noKeys")}</p>
                )}
                {check.accounts.length > 0 && (
                    <Option
                        checked={check.online && options.removeServiceKey}
                        disabled={!check.online}
                        onChange={(v) => setOption("removeServiceKey", v)}
                        title={t("deleteTunnel.removeServiceKey", { accounts: check.accounts.join(", ") })}
                        description={t("deleteTunnel.removeServiceKeyHint")}
                    />
                )}
            </Section>

            {/* MCP 授權與 AI session / MCP authorizations and AI sessions */}
            <Section icon={<Bot />} title={t("deleteTunnel.mcpTitle")} description={t("deleteTunnel.mcpDescription")}>
                {nothingMcp ? (
                    <p className="text-sm text-muted-foreground">{t("deleteTunnel.noMcp")}</p>
                ) : (
                    <>
                        {only.length > 0 && (
                            <Option
                                checked={options.revokeGrants}
                                onChange={(v) => setOption("revokeGrants", v)}
                                title={t("deleteTunnel.revokeOnly", { count: only.length })}
                                description={t("deleteTunnel.revokeOnlyHint")}
                            >
                                <span className="mt-2 flex flex-wrap gap-1">
                                    {only.map((g) => (
                                        <Chip key={g.id}>{grantLabel(g, t)}</Chip>
                                    ))}
                                </span>
                            </Option>
                        )}
                        {(shared.length > 0 || all.length > 0 || check.ai_sessions.length > 0) && (
                            <Lines>
                                {check.ai_sessions.length > 0 && (
                                    <Line tone="warning" detail={check.ai_sessions.map((s) => `${s.client_name} · ${s.user.username} · ${s.username}`).join(" / ")}>
                                        {t("deleteTunnel.aiSessions", { count: check.ai_sessions.length })}
                                    </Line>
                                )}
                                {shared.map((g) => (
                                    <Line key={g.id}>{t("deleteTunnel.grantShared", { app: grantLabel(g, t), count: g.other_tunnels })}</Line>
                                ))}
                                {all.map((g) => (
                                    <Line key={g.id}>{t("deleteTunnel.grantAll", { app: grantLabel(g, t) })}</Line>
                                ))}
                            </Lines>
                        )}
                    </>
                )}
            </Section>
        </div>
    );
}

function ReportView({ report, tunnelId }: { report: DeleteReport; tunnelId: number | null }) {
    const { t, tn } = useI18n();
    const removed = report.accounts.reduce((n, a) => n + a.removed, 0);
    return (
        <div className="space-y-4">
            <Lines>
                <Line tone="success">{t("deleteTunnel.doneDeleted")}</Line>
                {report.device_disconnected && <Line tone="success">{t("deleteTunnel.doneDisconnected")}</Line>}
                {report.accounts.map((a) =>
                    a.error ? (
                        <Line key={a.account} tone="danger" detail={a.error}>
                            {tn("deleteTunnel.doneAccountFailed", { account: <code>{a.account}</code> })}
                        </Line>
                    ) : (
                        <Line key={a.account} tone="success">
                            {tn(a.service_key_removed ? "deleteTunnel.doneAccountWithService" : "deleteTunnel.doneAccount", { account: <code>{a.account}</code>, count: a.removed })}
                        </Line>
                    ),
                )}
                {report.accounts.length === 0 && removed === 0 && report.keys_left === 0 && <Line>{t("deleteTunnel.doneNoKeys")}</Line>}
                {report.keys_left > 0 && (
                    <Line tone="warning" detail={report.online ? undefined : t("deleteTunnel.doneWasOffline")}>
                        {t("deleteTunnel.doneKeysLeft", { count: report.keys_left })}
                    </Line>
                )}
                {report.grants_revoked > 0 && <Line tone="success">{t("deleteTunnel.doneRevoked", { count: report.grants_revoked })}</Line>}
                {report.grants_detached > 0 && <Line tone="success">{t("deleteTunnel.doneDetached", { count: report.grants_detached })}</Line>}
                {report.ai_sessions_closed > 0 && <Line tone="success">{t("deleteTunnel.doneSessions", { count: report.ai_sessions_closed })}</Line>}
            </Lines>
            <Callout tone="info">{tn("deleteTunnel.deviceRetries", { script: <code>{`~/.ssh/telepy-uninstall-${tunnelId ?? ""}.sh`}</code> })}</Callout>
        </div>
    );
}
