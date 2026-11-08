"use client";

/**
 * 組織群組頁的說明圖：選一個群組，兩條線即時亮起來——
 *  A 誰管它 ─ 這個組織群組 ─ 功能規則（功能權限）；
 *  B 這個組織群組 ─ 分享給它的通道（要「可以分享」）─ 每位成員；
 * 下面再一條個人群組的線（你 ─ 你的個人群組 ─ 你管的通道 ─ 成員）和兩種群組的比較表。直線、PathFlow。
 * The Organization groups explainer: pick a group and two lanes light up — A who manages it ─ the group ─ feature
 * rules; B the group ─ tunnels shared with it (needs "Can be shared") ─ each member — plus the personal groups lane
 * and a comparison table. Straight lines on PathFlow.
 */
import React, { useState } from "react";
import { Building2, Server, Share2, SlidersHorizontal, User, Users, UsersRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Section } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import type { AccessPolicy } from "@/lib/features";
import { orgSharing, ruleCounts } from "@/lib/peopleGroups";
import type { TranslationKey } from "@/locales/en";

const COMPARE: { row: TranslationKey; org: TranslationKey; personal: TranslationKey }[] = [
    { row: "orgGroups.info.cmp.who", org: "orgGroups.info.cmp.whoOrg", personal: "orgGroups.info.cmp.whoPersonal" },
    { row: "orgGroups.info.cmp.seen", org: "orgGroups.info.cmp.seenOrg", personal: "orgGroups.info.cmp.seenPersonal" },
    { row: "orgGroups.info.cmp.features", org: "orgGroups.info.cmp.featuresOrg", personal: "orgGroups.info.cmp.featuresPersonal" },
    { row: "orgGroups.info.cmp.sharing", org: "orgGroups.info.cmp.sharingOrg", personal: "orgGroups.info.cmp.sharingPersonal" },
    { row: "orgGroups.info.cmp.sso", org: "orgGroups.info.cmp.ssoOrg", personal: "orgGroups.info.cmp.ssoPersonal" },
];

export function OrgGroupsInfoDialog({ isOpen, onClose, policy, groupId }: { isOpen: boolean; onClose: () => void; policy: AccessPolicy; groupId: number | null }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<number | null>(null);
    const group = policy.groups.find((g) => g.id === (picked ?? groupId)) ?? policy.groups[0] ?? null;
    const sharing = group ? orgSharing(group) : { shareable: false, shares: [] };
    const rules = group ? ruleCounts(group.grants) : { allow: 0, deny: 0 };
    const members = group?.members.length ?? 0;
    const sso = (group?.sso_members?.length ?? 0) > 0;
    const through = sharing.shares.reduce((n, s) => n + s.through, 0);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("orgGroups.info.title")}
            description={t("orgGroups.info.description")}
            icon={<UsersRound />}
            size="5xl"
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-7">
                {policy.groups.length > 0 && (
                    <Field label={t("orgGroups.info.pick")}>
                        <NativeSelect value={group?.id ?? ""} onChange={(e) => setPicked(Number(e.target.value))}>
                            {policy.groups.map((g) => (
                                <option key={g.id} value={g.id}>{g.name}</option>
                            ))}
                        </NativeSelect>
                    </Field>
                )}

                <Section icon={<SlidersHorizontal />} title={t("orgGroups.info.laneA")} description={t("orgGroups.info.laneAHint")}>
                    <FlowPath>
                        <FlowNode icon={Building2} title={t("orgGroups.info.managers")} sub={sso ? t("orgGroups.info.managersSso") : t("orgGroups.info.managersSub")} state="ok" />
                        <FlowLink compact label={t("orgGroups.info.manage")} state="ok" />
                        <FlowNode icon={Users} title={group?.name ?? t("orgGroups.info.group")} sub={t("access.memberCount", { count: members })} state={members > 0 ? "ok" : "waiting"} />
                        <FlowLink compact label={t("orgGroups.info.rulesLink")} state={rules.allow + rules.deny > 0 ? "ok" : "waiting"} />
                        <FlowNode
                            icon={SlidersHorizontal}
                            title={t("orgGroups.rulesTitle")}
                            sub={t("orgGroups.rulesCount", { allow: rules.allow, deny: rules.deny })}
                            state={rules.allow + rules.deny > 0 ? "ok" : "waiting"}
                        />
                    </FlowPath>
                </Section>

                <Section icon={<Share2 />} title={t("orgGroups.info.laneB")} description={t("orgGroups.info.laneBHint")}>
                    <FlowPath>
                        <FlowNode icon={Users} title={group?.name ?? t("orgGroups.info.group")} sub={sharing.shareable ? t("orgGroups.shareable") : t("orgGroups.notShareable")} state={sharing.shareable ? "ok" : "failed"} />
                        <FlowLink compact label={t("orgGroups.info.sharedWith")} state={sharing.shareable ? (sharing.shares.length > 0 ? "ok" : "waiting") : "failed"} />
                        <FlowNode icon={Server} title={t("orgGroups.info.tunnels")} sub={t("orgGroups.tunnelCount", { count: sharing.shares.length })} state={sharing.shares.length > 0 ? "ok" : "waiting"} />
                        <FlowLink compact label={t("orgGroups.info.each")} state={through > 0 ? "ok" : "waiting"} />
                        <FlowNode icon={UsersRound} title={t("orgGroups.info.members")} sub={t("orgGroups.through", { count: through })} state={through > 0 ? "ok" : "waiting"} />
                    </FlowPath>
                </Section>

                <Section icon={<User />} title={t("orgGroups.info.laneC")} description={t("orgGroups.info.laneCHint")}>
                    <FlowPath>
                        <FlowNode icon={User} title={t("orgGroups.info.anyone")} sub={t("orgGroups.info.anyoneSub")} />
                        <FlowLink compact label={t("orgGroups.info.makes")} />
                        <FlowNode icon={Users} title={t("personalGroups.title")} sub={t("orgGroups.info.onlyThem")} />
                        <FlowLink compact label={t("orgGroups.info.sharedWith")} />
                        <FlowNode icon={Server} title={t("orgGroups.info.theirTunnels")} sub={t("orgGroups.info.theirTunnelsSub")} />
                        <FlowLink compact label={t("orgGroups.info.each")} />
                        <FlowNode icon={UsersRound} title={t("orgGroups.info.members")} sub={t("orgGroups.info.noFeatures")} />
                    </FlowPath>
                </Section>

                <Section title={t("orgGroups.info.compareTitle")}>
                    <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border/80">
                        <table className="w-full min-w-[32rem] text-left text-sm">
                            <thead className="bg-surface text-xs text-muted-foreground">
                                <tr>
                                    <th className="px-3 py-2 font-normal" />
                                    <th className="px-3 py-2 font-normal">{t("orgGroups.title")}</th>
                                    <th className="px-3 py-2 font-normal">{t("personalGroups.title")}</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border/70">
                                {COMPARE.map((c) => (
                                    <tr key={c.row}>
                                        <th className="px-3 py-2 align-top text-xs font-normal text-muted-foreground">{t(c.row)}</th>
                                        <td className="px-3 py-2 align-top text-foreground">{t(c.org)}</td>
                                        <td className="px-3 py-2 align-top text-foreground">{t(c.personal)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{t("access.info.groupsNote")}</p>
                </Section>
            </div>
        </Modal>
    );
}
