"use client";

/**
 * 「誰說了算」：一條規則經過的四層——規則本身（全站：強制 / 允許覆寫；個人：誰寫的）→ 隧道的擁有者與 Admin（在這裡關掉了嗎）
 * → 你（提醒有沒有靜音）→ 結果。方塊用直線相連（桌面橫、手機直），每格標「鎖定 / 覆寫 / 沿用」，決定結果的那一格外框亮起。
 * 狀態來自純函式 `ruleLayers`。
 * "Who decides": the four layers a rule passes — the rule itself (site-wide: locked or overridable; personal: whose)
 * → the tunnel's owner and Admins (turned off here?) → you (reminder muted?) → the result. Boxes joined by straight
 * lines (a row from sm, a column on phones), each tagged "locked / overrides / follows"; the deciding box is outlined.
 * States come from the pure `ruleLayers`.
 */
import React from "react";
import { CircleCheck, Globe, Lock, Server, UserRound, type LucideIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip } from "@/components/ui/section";
import { ruleLayers, type RuleLayers as Layers } from "@/lib/commandRules";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";
import type { CommandRule } from "@/types/commandRules";
import { ActionChip } from "./RuleList";

type Tag = "locked" | "overrides" | "follows" | null;

function Box({ icon: Icon, title, active, children }: { icon: LucideIcon; title: string; active: boolean; children: React.ReactNode }) {
    return (
        <li className={cn("flex min-w-0 flex-1 basis-0 flex-col gap-2 rounded-xl border bg-card p-3", active ? "border-primary" : "border-border")}>
            <span className="flex items-center gap-2">
                <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", active ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")} aria-hidden>
                    <Icon size={16} />
                </span>
                <span className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{title}</span>
            </span>
            <div className="space-y-1.5 border-t border-border pt-2 text-xs">{children}</div>
        </li>
    );
}

/** 兩格之間的直線（桌面橫、手機直）。/ The straight connector (horizontal from sm, vertical on phones). */
function Line() {
    return (
        <li className="flex items-center justify-center sm:w-8 sm:shrink-0" aria-hidden>
            <svg className="h-6 w-3 text-muted-foreground sm:hidden" viewBox="0 0 6 100" preserveAspectRatio="none">
                <line x1={3} y1={0} x2={3} y2={100} stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </svg>
            <svg className="hidden h-3 w-full text-muted-foreground sm:block" viewBox="0 0 100 6" preserveAspectRatio="none">
                <line x1={0} y1={3} x2={100} y2={3} stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
                <polygon points="90,0 100,3 90,6" fill="currentColor" />
            </svg>
        </li>
    );
}

/** 一層的狀態：一句話加一個標籤。/ A layer's state: one line plus a tag. */
function State({ text, tag, muted }: { text: string; tag: Tag; muted?: boolean }) {
    const { t } = useI18n();
    return (
        <p className="flex flex-wrap items-center gap-1.5">
            <span className={cn("[overflow-wrap:anywhere]", muted ? "text-muted-foreground" : "text-foreground")}>{text}</span>
            {tag === "locked" && (
                <Chip>
                    <Lock /> {t("commands.layers.locked")}
                </Chip>
            )}
            {tag === "overrides" && <Chip tone="primary">{t("commands.layers.overrides")}</Chip>}
            {tag === "follows" && <Chip>{t("commands.layers.follows")}</Chip>}
        </p>
    );
}

const RESULT_KEY: Record<Layers["result"], TranslationKey> = {
    applies: "commands.layers.res.applies",
    off: "commands.layers.res.off",
    muted: "commands.layers.res.muted",
    notHere: "commands.layers.res.notHere",
    offOnMine: "commands.layers.res.offOnMine",
};

export function RuleLayersView({ rule, tunnelId, tunnelName, managesSome }: { rule: CommandRule; tunnelId: number | null; tunnelName: string | null; managesSome: boolean }) {
    const { t } = useI18n();
    const l = ruleLayers(rule, { tunnelId, managesSome });
    // 決定結果的那一層。/ The layer that decided the result.
    const decided: "source" | "tunnel" | "me" | "result" =
        l.result === "off" || l.result === "offOnMine" ? "tunnel" : l.result === "muted" ? "me" : l.result === "notHere" ? "result" : "source";

    const sourceTitle = l.source.kind === "site" ? t("commands.layers.site") : l.source.mine ? t("commands.layers.personalMine") : t("commands.layers.personal", { name: l.source.owner ?? "?" });
    const tunnelState = (() => {
        switch (l.tunnel.state) {
            case "na":
                return <State text={t(rule.scope === "site" ? "commands.layers.naAllow" : "commands.layers.naPersonal")} tag={null} muted />;
            case "locked":
                return <State text={t("commands.layers.lockedSite")} tag="locked" />;
            case "off":
                return <State text={t("commands.layers.offBy", { names: l.tunnel.by.join(", ") })} tag="overrides" />;
            case "follows":
                return <State text={t("commands.layers.notOff")} tag="follows" />;
            case "mineAll":
                return <State text={t("commands.layers.mineAll")} tag="overrides" />;
            case "mineSome":
                return <State text={t("commands.layers.mineSome", { count: l.tunnel.count })} tag="overrides" />;
            case "mineNone":
                return l.tunnel.canChange ? <State text={t("commands.layers.notOff")} tag="follows" /> : <State text={t("commands.layers.noTunnels")} tag={null} muted />;
        }
    })();
    const meState = (() => {
        switch (l.me.state) {
            case "na":
                return <State text={t("commands.layers.naMe")} tag={null} muted />;
            case "locked":
                return <State text={t("commands.mode.enforced")} tag="locked" />;
            case "muted":
                return <State text={t("commands.override.muted")} tag="overrides" />;
            case "follows":
                return <State text={t("commands.layers.notMuted")} tag="follows" />;
        }
    })();

    return (
        <div className="space-y-3">
            <ol className="flex flex-col sm:flex-row sm:items-stretch">
                <Box icon={l.source.kind === "site" ? Globe : UserRound} title={sourceTitle} active={decided === "source"}>
                    <p className="flex flex-wrap items-center gap-1.5">
                        <ActionChip action={rule.action} />
                        <code className="font-mono text-foreground [overflow-wrap:anywhere]">{rule.pattern}</code>
                    </p>
                    {l.source.kind === "site" ? (
                        <State text={t(l.source.locked ? "commands.layers.lockedSite" : "commands.layers.overridableSite")} tag={l.source.locked ? "locked" : null} />
                    ) : (
                        <State text={t("commands.layers.naPersonal")} tag={null} muted />
                    )}
                </Box>
                <Line />
                <Box icon={Server} title={tunnelId !== null ? `${t("commands.layers.tunnel")}${tunnelName ? ` · ${tunnelName}` : ""}` : t("commands.layers.tunnelMine")} active={decided === "tunnel"}>
                    {tunnelState}
                </Box>
                <Line />
                <Box icon={UserRound} title={t("commands.layers.me")} active={decided === "me"}>
                    {meState}
                </Box>
                <Line />
                <Box icon={CircleCheck} title={t("commands.layers.result")} active={decided === "result"}>
                    <p className={cn("text-sm", l.result === "applies" ? "text-foreground" : "text-muted-foreground")}>{t(RESULT_KEY[l.result])}</p>
                </Box>
            </ol>
            {tunnelId === null && rule.scope === "site" && rule.mode === "default" && rule.action !== "allow" && <p className="text-xs text-muted-foreground">{t("commands.layers.pickTunnel")}</p>}
        </div>
    );
}

/** 每條規則旁「誰說了算？」打開的對話框。/ The dialog behind each rule's "Who decides?" button. */
export function RuleLayersDialog({ rule, onClose, ...rest }: { rule: CommandRule | null; onClose: () => void; tunnelId: number | null; tunnelName: string | null; managesSome: boolean }) {
    const { t } = useI18n();
    return (
        <Modal isOpen={rule !== null} onClose={onClose} size="4xl" title={t("commands.layers.title")} description={t("commands.layers.description")} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
            {rule && (
                <div className="space-y-4">
                    <RuleLayersView rule={rule} {...rest} />
                    <Callout tone="info">{t("commands.flow.rule5")}</Callout>
                </div>
            )}
        </Modal>
    );
}
