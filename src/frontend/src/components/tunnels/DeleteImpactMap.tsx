"use client";

/**
 * 刪除隧道的影響圖:左邊是「誰碰得到它」(分享對象、正在用的人、AI app),中間是隧道,右邊是「裝置上」
 * (各登入帳號裡的金鑰與服務金鑰)。兩條連線上的剪刀 = 刪除後這些連線都斷掉;每個項目旁的標籤說明它的下場,
 * 並跟著下方的選項即時改變(紅 = 移除 / 撤銷,黃 = 有變化或留在裝置上要手動處理,灰 = 不受影響)。
 * 桌面三欄橫排,手機直排(連線變成直線)。
 * Delete impact map: who reaches the tunnel (sharees, people using it, AI apps) ─✂─ the tunnel ─✂─ what is on
 * the device (keys and the service key per login account). Every item carries its outcome and follows the
 * options below live (red = removed / revoked, amber = changed or left on the device, grey = unaffected).
 * Three columns on desktop, stacked on phones.
 */
import React from "react";
import { Bot, HardDrive, KeyRound, Network, RefreshCw, Scissors, ShieldCheck, UserRound, Users } from "lucide-react";
import { Chip } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { DeleteCheck, DeleteCheckGrant, DeleteOptions, GrantChoice } from "@/hooks/useDeleteTunnel";

type Tone = "danger" | "warning" | "neutral";

function Outcome({ tone, children }: { tone: Tone; children: React.ReactNode }) {
    return (
        <Chip tone={tone} className="shrink-0">
            {children}
        </Chip>
    );
}

/** 一列:圖示 + 名稱(+ 小字)+ 下場。/ One row: icon, name (+ detail), outcome. */
function Row({ icon, name, detail, outcome }: { icon?: React.ReactNode; name: React.ReactNode; detail?: React.ReactNode; outcome?: React.ReactNode }) {
    return (
        <li className="flex items-start gap-2 py-1.5 text-sm">
            {icon && <span className="mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-3.5" aria-hidden>{icon}</span>}
            <span className="min-w-0 flex-1">
                <span className="block break-words text-foreground">{name}</span>
                {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
            </span>
            {outcome}
        </li>
    );
}

function Group({ icon, title, children }: { icon: React.ReactNode; title: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
                {icon}
                {title}
            </p>
            <ul className="divide-y divide-border/70">{children}</ul>
        </div>
    );
}

function Card({ title, icon, children, className }: { title: React.ReactNode; icon: React.ReactNode; children: React.ReactNode; className?: string }) {
    return (
        <section className={cn("min-w-0 space-y-3 rounded-lg border border-border bg-card p-3.5", className)}>
            <h4 className="flex items-center gap-2 text-sm text-foreground [&_svg]:size-4 [&_svg]:text-muted-foreground">
                {icon}
                {title}
            </h4>
            {children}
        </section>
    );
}

/** 斷開的連線:桌面是橫線、手機是直線,中間一把剪刀。/ A cut link: horizontal on desktop, vertical on phones. */
function Cut({ label }: { label: string }) {
    return (
        <div className="relative flex items-center justify-center self-stretch max-sm:h-10 sm:w-12" aria-hidden title={label}>
            <span className="absolute border-destructive/50 max-sm:inset-y-0 max-sm:left-1/2 max-sm:border-l max-sm:border-dashed sm:inset-x-0 sm:top-1/2 sm:border-t sm:border-dashed" />
            <span className="relative grid size-7 place-items-center rounded-full border border-destructive/30 bg-card text-destructive">
                <Scissors size={13} />
            </span>
        </div>
    );
}

export function DeleteImpactMap({
    check,
    options,
    choiceFor,
}: {
    check: DeleteCheck;
    options: DeleteOptions;
    choiceFor: (g: DeleteCheckGrant) => GrantChoice;
}) {
    const { t } = useI18n();

    const grantOutcome = (g: DeleteCheckGrant): { tone: Tone; label: string } => {
        if (choiceFor(g) === "revoke") return { tone: "danger", label: t("deleteTunnel.outRevoked") };
        if (g.coverage === "only") return { tone: "warning", label: t("deleteTunnel.outNoTunnels") };
        if (g.coverage === "shared") return { tone: "warning", label: t("deleteTunnel.outLosesThis") };
        return { tone: "neutral", label: t("deleteTunnel.outKeepsOthers") };
    };
    const coverageText = (g: DeleteCheckGrant) =>
        g.coverage === "only" ? t("deleteTunnel.coverOnly") : g.coverage === "shared" ? t("deleteTunnel.coverShared", { count: g.other_tunnels }) : t("deleteTunnel.coverAll");

    // 裝置上的金鑰的下場:離線 → 留著、要手動移除;在線 → 依選項。/ Key outcome: offline stays (by hand), online follows the option.
    const keyOutcome = (remove: boolean): { tone: Tone; label: string } =>
        !check.online ? { tone: "warning", label: t("deleteTunnel.outStaysByHand") } : remove ? { tone: "danger", label: t("deleteTunnel.outRemoved") } : { tone: "neutral", label: t("deleteTunnel.outStays") };
    const userKey = keyOutcome(options.removeDeviceKeys);
    const serviceKey = keyOutcome(options.removeServiceKey);

    const nobody = check.sharees.length === 0 && check.in_use === 0;
    const noApps = check.grants.length === 0 && check.ai_sessions.length === 0;

    return (
        <div className="space-y-3">
            <div className="flex flex-col items-stretch sm:grid sm:grid-cols-[minmax(0,1fr)_auto_auto_auto_minmax(0,1fr)] sm:items-center">
                {/* 誰碰得到它 / Who reaches it */}
                <Card icon={<Users />} title={t("deleteTunnel.mapWho")}>
                    <Group icon={<Users />} title={t("deleteTunnel.mapPeople")}>
                        {nobody && <Row name={<span className="text-muted-foreground">{t("deleteTunnel.mapNotShared")}</span>} />}
                        {check.sharees.map((s) => (
                            <Row
                                key={s.id}
                                name={s.username}
                                detail={s.permission.toUpperCase()}
                                outcome={<Outcome tone="danger">{t("deleteTunnel.outLosesAccess")}</Outcome>}
                            />
                        ))}
                        {check.in_use > 0 && (
                            <Row name={t("deleteTunnel.mapInUse", { count: check.in_use })} outcome={<Outcome tone="warning">{t("deleteTunnel.outSessionsEnd")}</Outcome>} />
                        )}
                    </Group>
                    <Group icon={<Bot />} title={t("deleteTunnel.mapApps")}>
                        {noApps && <Row name={<span className="text-muted-foreground">{t("deleteTunnel.noMcp")}</span>} />}
                        {check.grants.map((g) => {
                            const o = grantOutcome(g);
                            return (
                                <Row
                                    key={g.id}
                                    name={g.mine ? g.client_name : t("deleteTunnel.grantOf", { app: g.client_name, user: g.user.username })}
                                    detail={coverageText(g)}
                                    outcome={<Outcome tone={o.tone}>{o.label}</Outcome>}
                                />
                            );
                        })}
                        {check.ai_sessions.length > 0 && (
                            <Row name={t("deleteTunnel.mapAiSessions", { count: check.ai_sessions.length })} outcome={<Outcome tone="danger">{t("deleteTunnel.outClosed")}</Outcome>} />
                        )}
                    </Group>
                </Card>

                <Cut label={t("deleteTunnel.legendCut")} />

                {/* 隧道本身 / The tunnel */}
                <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-destructive/50 bg-destructive/5 px-4 py-3 text-center sm:min-w-32">
                    <span className="grid size-9 place-items-center rounded-md border border-border bg-card text-foreground/70" aria-hidden>
                        <Network size={18} />
                    </span>
                    <span className="max-w-40 truncate text-sm text-foreground line-through decoration-destructive/60">{check.tunnel.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">:{check.tunnel.reverse_port}</span>
                    <Outcome tone="danger">{t("deleteTunnel.outDeleted")}</Outcome>
                </div>

                <Cut label={t("deleteTunnel.legendCut")} />

                {/* 裝置上 / On the device */}
                <Card icon={<HardDrive />} title={t("deleteTunnel.mapDevice")}>
                    <Row
                        name={
                            <span className="inline-flex items-center gap-1.5">
                                <span className={cn("size-2 rounded-full", check.online ? "bg-success" : "bg-muted-foreground/40")} aria-hidden />
                                {check.online ? t("deleteTunnel.mapOnline") : t("deleteTunnel.mapOffline")}
                            </span>
                        }
                        outcome={<Outcome tone={check.online ? "danger" : "neutral"}>{check.online ? t("deleteTunnel.outDisconnected") : t("deleteTunnel.outRefused")}</Outcome>}
                    />
                    {/* 跑隧道的服務(systemd / launchd / 迴圈 / Docker / 排程…)。/ What keeps the device connecting. */}
                    <Row
                        icon={<RefreshCw />}
                        name={t("deleteTunnel.mapService")}
                        outcome={
                            check.online && options.removeService ? (
                                <Outcome tone="danger">{t("deleteTunnel.outRemoved")}</Outcome>
                            ) : (
                                <Outcome tone="warning">{t("deleteTunnel.outKeepsRetrying")}</Outcome>
                            )
                        }
                    />
                    {check.accounts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">{t("deleteTunnel.mapNoAccounts")}</p>
                    ) : (
                        check.accounts.map((account) => {
                            const keys = check.device_keys.filter((k) => k.accounts.includes(account));
                            return (
                                <Group key={account} icon={<UserRound />} title={<span className="font-mono text-foreground">{account}</span>}>
                                    {keys.map((k) => (
                                        <Row
                                            key={k.fingerprint}
                                            icon={<KeyRound />}
                                            name={k.name ?? t("deleteTunnel.keyUnnamed")}
                                            detail={k.owner ?? undefined}
                                            outcome={<Outcome tone={userKey.tone}>{userKey.label}</Outcome>}
                                        />
                                    ))}
                                    <Row icon={<ShieldCheck />} name={t("deleteTunnel.mapServiceKey")} outcome={<Outcome tone={serviceKey.tone}>{serviceKey.label}</Outcome>} />
                                </Group>
                            );
                        })
                    )}
                    {check.lan_hosts > 0 && <Row name={t("deleteTunnel.mapLanHosts", { count: check.lan_hosts })} outcome={<Outcome tone="danger">{t("deleteTunnel.outDeleted")}</Outcome>} />}
                </Card>
            </div>

            {/* 圖例 / Legend */}
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                    <Scissors size={12} className="text-destructive" aria-hidden />
                    {t("deleteTunnel.legendCut")}
                </span>
                <span className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-destructive/60" aria-hidden />
                    {t("deleteTunnel.legendRemoved")}
                </span>
                <span className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-warning/70" aria-hidden />
                    {t("deleteTunnel.legendChanged")}
                </span>
                <span className="inline-flex items-center gap-1">
                    <span className="size-2 rounded-sm bg-muted-foreground/40" aria-hidden />
                    {t("deleteTunnel.legendKept")}
                </span>
            </p>
        </div>
    );
}
