"use client";

/**
 * 「存取」分頁的說明圖：兩條分開的線，講清楚使用者在意的那個差別。
 *  A「這個人可以用哪些工具？」= 預設 → 所有人 → 群組 → 這個人（最終端）→ 結果，選一個人和一個功能就即時顯示是哪一層決定的；
 *  B「他能連到哪些隧道？」= 隧道分享（VIEW / EDIT / ADMIN）+ 允許的帳號，標「不變，每條隧道各自設定」。
 * 兩道門都要過：功能先、隧道權限後。直線與直角，積木是 components/flow/PathFlow。
 * The Access tab's explainer: two separate lanes. A "Which tools may this person use?" = default → everyone → groups →
 * this person (final) → result, live for the picked person and feature; B "Which tunnels may they reach?" = tunnel
 * sharing + allowed accounts, marked unchanged. Both gates apply, the feature first.
 */
import React, { useMemo, useState } from "react";
import { Ban, Check, Globe, KeyRound, Server, Settings2, Share2, User, Users, Wrench } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { FlowLink, FlowNode, FlowNow, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import { FEATURES, laneFor, resolveFeature, type AccessPolicy, type LaneCell } from "@/lib/features";
import type { SpotState } from "@/lib/flow";
import type { TranslationKey } from "@/locales/en";

/** 節點標題可以換行（節點窄的時候不要被截成「…」）。/ Node titles wrap instead of being cut to "…" in narrow nodes. */
const wrap = (text: string) => <span className="block whitespace-normal break-words">{text}</span>;

/** 一格 → 節點狀態：決定的那格 = 允許綠 / 拒絕紅；其他 = 待命灰。/ A cell → the node state. */
function nodeState(c: LaneCell): SpotState {
    if (c.state !== "decides") return "waiting";
    return c.value ? "ok" : "failed";
}

export function AccessInfoDialog({ isOpen, onClose, policy, userId, feature }: { isOpen: boolean; onClose: () => void; policy: AccessPolicy; userId: number | null; feature: string | null }) {
    const { t } = useI18n();
    const people = policy.users;
    const [pickedUser, setPickedUser] = useState<number | null>(null);
    const [pickedFeature, setPickedFeature] = useState<string | null>(null);
    // 預設：分頁上選的人 / 功能；沒有就第一個不是管理員的人、終端機。/ Defaults: the tab's selection, else a non-admin and the terminal.
    const uid = pickedUser ?? userId ?? people.find((u) => !u.is_superuser)?.id ?? people[0]?.id ?? null;
    const fid = pickedFeature ?? feature ?? "terminal";
    const person = people.find((u) => u.id === uid) ?? null;
    const lane = useMemo(() => (person ? laneFor(resolveFeature(policy, { kind: "user", id: person.id }, fid)) : null), [policy, person, fid]);
    const fname = t(`access.f.${FEATURES.find((f) => f.id === fid)?.key ?? "terminal"}` as TranslationKey);

    const cellText = (c: LaneCell) => {
        if (c.value === null) return t("access.info.notSet");
        const v = c.value ? t("access.allow") : t("access.deny");
        return c.state === "decides" ? t("access.info.decides", { value: v }) : t("access.info.overridden", { value: v });
    };
    const decider = lane
        ? lane.superuser
            ? t("access.src.superuser")
            : lane.user.state === "decides"
              ? t("access.src.user")
              : lane.groups.find((g) => g.state === "decides")
                ? t("access.src.group", { name: lane.groups.find((g) => g.state === "decides")!.name })
                : lane.everyone.state === "decides"
                  ? t("access.src.everyone")
                  : t("access.src.default")
        : "";

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("access.info.title")}
            description={t("access.info.description")}
            icon={<Settings2 />}
            size="4xl"
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-7">
                {/* A：功能權限（這裡設定）。/ Lane A: feature permissions (set here). */}
                <section className="space-y-3">
                    <SectionHeading icon={<Wrench />} title={t("access.info.laneA")} description={t("access.info.laneAHint")} />
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Field label={t("access.info.person")}>
                            <NativeSelect value={uid ?? ""} onChange={(e) => setPickedUser(Number(e.target.value))}>
                                {people.map((u) => (
                                    <option key={u.id} value={u.id}>
                                        {u.username}{u.is_superuser ? ` (${t("access.adminChip")})` : ""}
                                    </option>
                                ))}
                            </NativeSelect>
                        </Field>
                        <Field label={t("access.info.feature")}>
                            <NativeSelect value={fid} onChange={(e) => setPickedFeature(e.target.value)}>
                                {FEATURES.map((f) => (
                                    <option key={f.id} value={f.id}>{t(`access.f.${f.key}` as TranslationKey)}</option>
                                ))}
                            </NativeSelect>
                        </Field>
                    </div>
                    {person && lane && (
                        <>
                            <FlowNow failed={!lane.allowed}>
                                {lane.superuser
                                    ? t("access.info.adminNow", { user: person.username })
                                    : t("access.info.now", { user: person.username, feature: fname, result: lane.allowed ? t("access.result.on") : t("access.result.off"), from: decider })}
                            </FlowNow>
                            <FlowPath stretch>
                                <FlowNode icon={Settings2} title={wrap(t("access.info.node.default"))} sub={t("access.info.node.defaultSub")} state={nodeState(lane.default)} stateText={cellText(lane.default)} />
                                <FlowLink label={t("access.info.then")} />
                                <FlowNode icon={Globe} title={wrap(t("access.everyone"))} state={nodeState(lane.everyone)} stateText={cellText(lane.everyone)} />
                                <FlowLink label={t("access.info.then")} />
                                <FlowNode
                                    icon={Users}
                                    title={wrap(t("access.info.node.groups"))}
                                    wide
                                    state={lane.groups.some((g) => g.state === "decides") ? nodeState(lane.groups.find((g) => g.state === "decides")!) : "waiting"}
                                    stateText={lane.groups.length === 0 ? t("access.info.noGroups") : lane.groups.some((g) => g.state === "decides") ? t("access.info.decidesShort") : t("access.info.notSet")}
                                    sub={
                                        lane.groups.length > 0 ? (
                                            <span className="mt-1 flex flex-wrap justify-center gap-1">
                                                {lane.groups.map((g) => (
                                                    <Chip key={g.groupId} tone={g.value === null ? "neutral" : g.value ? "success" : "danger"} title={cellText(g)}>
                                                        {g.value === null ? null : g.value ? <Check aria-hidden /> : <Ban aria-hidden />}
                                                        {g.name}
                                                    </Chip>
                                                ))}
                                            </span>
                                        ) : undefined
                                    }
                                />
                                <FlowLink label={t("access.info.then")} />
                                <FlowNode
                                    icon={lane.allowed ? User : Ban}
                                    title={wrap(person.username)}
                                    sub={lane.superuser ? t("access.adminChip") : t("access.info.ownSetting", { value: cellText(lane.user) })}
                                    state={lane.allowed ? "ok" : "failed"}
                                    stateText={t("access.info.result", { value: lane.allowed ? t("access.result.on") : t("access.result.off") })}
                                />
                            </FlowPath>
                            <p className="text-xs leading-relaxed text-muted-foreground">{t("access.info.groupRule")}</p>
                            <p className="text-xs leading-relaxed text-muted-foreground">{t("access.info.groupsNote")}</p>
                        </>
                    )}
                    {!person && <Callout tone="info">{t("access.info.noPeople")}</Callout>}
                </section>

                {/* B：隧道分享（每條隧道各自設定，這裡不變）。/ Lane B: tunnel sharing (per tunnel, unchanged here). */}
                <section className="space-y-3 border-t border-border pt-6">
                    <SectionHeading icon={<Share2 />} title={t("access.info.laneB")} description={t("access.info.laneBHint")} action={<Chip>{t("access.info.unchanged")}</Chip>} />
                    <FlowPath stretch>
                        <FlowNode icon={User} title={wrap(person?.username ?? t("access.info.b.person"))} sub={t("access.info.b.personSub")} stateText={t("access.info.perTunnel")} />
                        <FlowLink label={t("access.info.b.linkShare")} />
                        <FlowNode icon={Share2} title={wrap(t("access.info.b.share"))} sub={t("access.info.b.shareSub")} stateText={t("access.info.perTunnel")} />
                        <FlowLink label={t("access.info.b.linkAccounts")} />
                        <FlowNode icon={KeyRound} title={wrap(t("access.info.b.accounts"))} sub={t("access.info.b.accountsSub")} stateText={t("access.info.perTunnel")} />
                        <FlowLink label={t("access.info.b.linkLogin")} />
                        <FlowNode icon={Server} title={wrap(t("access.info.b.device"))} sub={t("access.info.b.deviceSub")} stateText={t("access.info.perTunnel")} />
                    </FlowPath>
                </section>

                <Callout tone="tip" title={t("access.info.bothTitle")}>
                    {t("access.info.bothGates", { feature: fname, user: person?.username ?? t("access.info.b.person") })}
                </Callout>
            </div>
        </Modal>
    );
}
