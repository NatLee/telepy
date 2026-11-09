"use client";

/**
 * 角色頁與群組頁的說明圖。兩頁各畫自己那條線，再畫被擋住的那條，讓「角色決定功能、群組決定分享」一眼看出來：
 *  角色：誰維護 ─ 這個角色 ─ 功能規則；這個角色 ─✗─ 分享視窗（角色從不出現在分享）。
 *  群組：誰維護 ─ 這個群組 ─ 分享給它的通道 ─ 每位成員；這個群組 ─✗─ 功能規則（群組從不改變功能）。
 * 下面是角色 / 管理員維護的群組 / 個人群組三欄對照表。直線、PathFlow。
 * The Roles and Groups explainers. Each page draws its own lane and then the blocked one, so "roles decide features,
 * groups decide sharing" shows at a glance: Roles: who keeps it ─ the role ─ feature rules; the role ─✗─ share dialogs.
 * Groups: who keeps it ─ the group ─ tunnels shared with it ─ each member; the group ─✗─ feature rules. Then a
 * three-column comparison (role / admin-kept group / personal group). Straight lines on PathFlow.
 */
import React, { useState } from "react";
import { BadgeCheck, Building2, Server, Share2, SlidersHorizontal, User, Users, UsersRound } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Section } from "@/components/ui/section";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { useI18n } from "@/lib/i18n";
import type { AccessPolicy } from "@/lib/features";
import { parseShareGroups, ruleCounts, throughTotal } from "@/lib/peopleGroups";
import type { TranslationKey } from "@/locales/en";

const COMPARE: { row: TranslationKey; role: TranslationKey; group: TranslationKey; personal: TranslationKey }[] = [
    { row: "roles.cmp.job", role: "roles.cmp.jobRole", group: "roles.cmp.jobGroup", personal: "roles.cmp.jobPersonal" },
    { row: "roles.cmp.who", role: "roles.cmp.whoRole", group: "roles.cmp.whoGroup", personal: "roles.cmp.whoPersonal" },
    { row: "roles.cmp.seen", role: "roles.cmp.seenRole", group: "roles.cmp.seenGroup", personal: "roles.cmp.seenPersonal" },
    { row: "roles.cmp.features", role: "roles.cmp.yes", group: "roles.cmp.never", personal: "roles.cmp.never" },
    { row: "roles.cmp.sharing", role: "roles.cmp.never", group: "roles.cmp.sharingGroup", personal: "roles.cmp.sharingPersonal" },
    { row: "roles.cmp.sso", role: "roles.cmp.ssoYes", group: "roles.cmp.ssoYes", personal: "roles.cmp.ssoNo" },
];

function Compare() {
    const { t } = useI18n();
    return (
        <Section title={t("roles.cmp.title")}>
            <div className="overflow-x-auto rounded-lg ring-1 ring-inset ring-border/80">
                <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-surface text-xs text-muted-foreground">
                        <tr>
                            <th className="px-3 py-2 font-normal" />
                            <th className="px-3 py-2 font-normal">{t("roles.title")}</th>
                            <th className="px-3 py-2 font-normal">{t("adminGroups.title")}</th>
                            <th className="px-3 py-2 font-normal">{t("personalGroups.title")}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                        {COMPARE.map((c) => (
                            <tr key={c.row}>
                                <th className="px-3 py-2 align-top text-xs font-normal text-muted-foreground">{t(c.row)}</th>
                                <td className="px-3 py-2 align-top text-foreground">{t(c.role)}</td>
                                <td className="px-3 py-2 align-top text-foreground">{t(c.group)}</td>
                                <td className="px-3 py-2 align-top text-foreground">{t(c.personal)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("roles.cmp.note")}</p>
        </Section>
    );
}

function Picker<T extends { id: number; name: string }>({ label, items, value, onChange }: { label: string; items: T[]; value: number | undefined; onChange: (id: number) => void }) {
    if (items.length === 0) return null;
    return (
        <Field label={label}>
            <NativeSelect value={value ?? ""} onChange={(e) => onChange(Number(e.target.value))}>
                {items.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                ))}
            </NativeSelect>
        </Field>
    );
}

export function RolesInfoDialog({ isOpen, onClose, policy, roleId }: { isOpen: boolean; onClose: () => void; policy: AccessPolicy; roleId: number | null }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<number | null>(null);
    const role = policy.groups.find((g) => g.id === (picked ?? roleId)) ?? policy.groups[0] ?? null;
    const rules = role ? ruleCounts(role.grants) : { allow: 0, deny: 0 };
    const members = role?.members.length ?? 0;
    const sso = (role?.sso_members?.length ?? 0) > 0;
    const ruled = rules.allow + rules.deny > 0;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("roles.info.title")}
            description={t("roles.info.description")}
            icon={<BadgeCheck />}
            size="5xl"
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-7">
                <Picker label={t("roles.info.pick")} items={policy.groups} value={role?.id} onChange={setPicked} />

                <Section icon={<SlidersHorizontal />} title={t("roles.info.laneA")} description={t("roles.info.laneAHint")}>
                    <FlowPath>
                        <FlowNode icon={Building2} title={t("roles.info.keepers")} sub={sso ? t("roles.info.keepersSso") : t("roles.info.keepersSub")} state="ok" />
                        <FlowLink compact label={t("roles.info.keep")} state="ok" />
                        <FlowNode icon={BadgeCheck} title={role?.name ?? t("roles.info.role")} sub={t("access.memberCount", { count: members })} state={members > 0 ? "ok" : "waiting"} />
                        <FlowLink compact label={t("roles.info.carries")} state={ruled ? "ok" : "waiting"} />
                        <FlowNode icon={SlidersHorizontal} title={t("roles.rulesTitle")} sub={t("roles.rulesCount", { allow: rules.allow, deny: rules.deny })} state={ruled ? "ok" : "waiting"} />
                    </FlowPath>
                </Section>

                <Section icon={<Share2 />} title={t("roles.info.laneB")} description={t("roles.info.laneBHint")}>
                    <FlowPath>
                        <FlowNode icon={BadgeCheck} title={role?.name ?? t("roles.info.role")} sub={t("roles.title")} state="waiting" />
                        <FlowLink compact label={t("roles.info.notOffered")} state="failed" />
                        <FlowNode icon={Share2} title={t("roles.info.shareDialogs")} sub={t("roles.info.shareDialogsSub")} state="failed" stateText={t("roles.info.never")} />
                    </FlowPath>
                </Section>

                <Compare />
            </div>
        </Modal>
    );
}

export function AdminGroupsInfoDialog({ isOpen, onClose, policy, groupId }: { isOpen: boolean; onClose: () => void; policy: AccessPolicy; groupId: number | null }) {
    const { t } = useI18n();
    const groups = parseShareGroups(policy);
    const [picked, setPicked] = useState<number | null>(null);
    const group = groups.find((g) => g.id === (picked ?? groupId)) ?? groups[0] ?? null;
    const members = group?.members.length ?? 0;
    const shares = group?.shares.length ?? 0;
    const through = group ? throughTotal(group) : 0;

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("adminGroups.info.title")}
            description={t("adminGroups.info.description")}
            icon={<UsersRound />}
            size="5xl"
            footer={<Button variant="outline" onClick={onClose}>{t("common.close")}</Button>}
        >
            <div className="space-y-7">
                <Picker label={t("adminGroups.info.pick")} items={groups} value={group?.id} onChange={setPicked} />

                <Section icon={<Share2 />} title={t("adminGroups.info.laneA")} description={t("adminGroups.info.laneAHint")}>
                    <FlowPath>
                        <FlowNode icon={Building2} title={t("roles.info.keepers")} sub={group?.synced ? t("adminGroups.info.keepersSynced") : t("roles.info.keepersSub")} state="ok" />
                        <FlowLink compact label={t("roles.info.keep")} state="ok" />
                        <FlowNode icon={Users} title={group?.name ?? t("adminGroups.info.group")} sub={t("access.memberCount", { count: members })} state={members > 0 ? "ok" : "waiting"} />
                        <FlowLink compact label={t("adminGroups.info.sharedWith")} state={shares > 0 ? "ok" : "waiting"} />
                        <FlowNode icon={Server} title={t("adminGroups.info.tunnels")} sub={t("adminGroups.tunnelCount", { count: shares })} state={shares > 0 ? "ok" : "waiting"} />
                        <FlowLink compact label={t("adminGroups.info.each")} state={through > 0 ? "ok" : "waiting"} />
                        <FlowNode icon={UsersRound} title={t("adminGroups.info.members")} sub={t("adminGroups.through", { count: through })} state={through > 0 ? "ok" : "waiting"} />
                    </FlowPath>
                </Section>

                <Section icon={<SlidersHorizontal />} title={t("adminGroups.info.laneB")} description={t("adminGroups.info.laneBHint")}>
                    <FlowPath>
                        <FlowNode icon={Users} title={group?.name ?? t("adminGroups.info.group")} sub={t("adminGroups.title")} state="waiting" />
                        <FlowLink compact label={t("adminGroups.info.noRules")} state="failed" />
                        <FlowNode icon={SlidersHorizontal} title={t("roles.rulesTitle")} sub={t("adminGroups.info.rolesDo")} state="failed" stateText={t("roles.info.never")} />
                    </FlowPath>
                </Section>

                <Section icon={<User />} title={t("adminGroups.info.laneC")} description={t("adminGroups.info.laneCHint")}>
                    <FlowPath>
                        <FlowNode icon={User} title={t("adminGroups.info.anyone")} sub={t("adminGroups.info.anyoneSub")} />
                        <FlowLink compact label={t("adminGroups.info.makes")} />
                        <FlowNode icon={Users} title={t("personalGroups.title")} sub={t("adminGroups.info.onlyThem")} />
                        <FlowLink compact label={t("adminGroups.info.sharedWith")} />
                        <FlowNode icon={Server} title={t("adminGroups.info.theirTunnels")} sub={t("adminGroups.info.theirTunnelsSub")} />
                    </FlowPath>
                </Section>

                <Compare />
            </div>
        </Modal>
    );
}
