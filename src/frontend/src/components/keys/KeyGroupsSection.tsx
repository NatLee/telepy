/**
 * 金鑰頁的「金鑰群組」段落：每組一張卡（裡面的金鑰、授予給哪裡、幾把 → 幾台），新增 / 編輯 / 刪除 / 授予，
 * 以及 info 按鈕打開的「金鑰群組怎麼運作」——三句話加上即時的 `KeyGroupFlow`（還沒有群組時用例子）。
 * The keys page's "Key groups" section: one card per group (its keys, where it is given, keys → devices), with
 * create / edit / delete / grant, and the info button's "How key groups work": three lines plus the live
 * `KeyGroupFlow` (an example until there is a group).
 */
import React, { useMemo, useState } from "react";
import { CircleHelp, KeyRound, Layers, MoreHorizontal, Plus, Send, SquarePen, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Chip } from "@/components/ui/section";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/Toast";
import { KeyGroupEditor } from "@/components/keys/KeyGroupEditor";
import { KeyGroupGrantDialog } from "@/components/keys/KeyGroupGrantDialog";
import { GrantAccounts, GrantTarget, KeyGroupFlow } from "@/components/keys/KeyGroupFlow";
import { useI18n } from "@/lib/i18n";
import { keyGroupReach } from "@/lib/groups";
import type { useKeyGroups } from "@/hooks/useKeyGroups";
import type { KeyGroup, KeyGroupGrant, TunnelGroup } from "@/types/groups";
import type { KeyDevice, UserKey } from "@/types/keys";

type KeyGroupsApi = ReturnType<typeof useKeyGroups>;

function KeyGroupCard({
    group,
    keys,
    tunnelGroups,
    devices,
    onEdit,
    onDelete,
    onGrant,
    onRevoke,
}: {
    group: KeyGroup;
    keys: UserKey[];
    tunnelGroups: TunnelGroup[];
    devices: KeyDevice[];
    onEdit: () => void;
    onDelete: () => void;
    onGrant: () => void;
    onRevoke: (g: KeyGroupGrant) => void;
}) {
    const { t } = useI18n();
    const members = keys.filter((k) => group.key_ids.includes(k.id));
    const reached = keyGroupReach(group, tunnelGroups).filter((r) => devices.some((d) => d.tunnel_id === r.tunnelId)).length;
    return (
        <article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-card">
            <header className="flex items-center gap-2">
                <Layers size={16} className="shrink-0 text-muted-foreground" aria-hidden />
                <h3 className="min-w-0 flex-1 truncate text-base text-foreground" title={group.name}>{group.name}</h3>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t("groups.menuAria", { name: group.name })} className="data-[state=open]:bg-accent">
                            <MoreHorizontal />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={onEdit}>
                            <SquarePen /> {t("groups.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={onDelete}>
                            <Trash2 /> {t("groups.delete")}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </header>
            <div className="flex flex-wrap gap-1.5">
                {members.length === 0 ? (
                    <span className="text-sm text-muted-foreground">{t("groups.key.noKeys")}</span>
                ) : (
                    members.map((k) => (
                        <Chip key={k.id} className="max-w-full" title={k.fingerprint ?? ""}>
                            <KeyRound aria-hidden /> <span className="truncate">{k.host_friendly_name}</span>
                        </Chip>
                    ))
                )}
            </div>
            <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t("groups.key.goesTo")}</p>
                {group.grants.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("groups.key.nowhere")}</p>
                ) : (
                    <ul className="flex flex-col gap-1">
                        {group.grants.map((g) => {
                            const target = g.tunnel_group?.name ?? g.tunnel?.name ?? "";
                            return (
                                <li key={g.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-surface px-2 py-1.5 ring-1 ring-inset ring-border">
                                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                                        <GrantTarget grant={g} tunnelGroups={tunnelGroups} />
                                        <GrantAccounts accounts={g.accounts} />
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        className="shrink-0 text-muted-foreground hover:text-destructive"
                                        onClick={() => onRevoke(g)}
                                        aria-label={t("groups.grant.remove", { group: group.name, target })}
                                        title={t("groups.grant.remove", { group: group.name, target })}
                                    >
                                        <X />
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
            <footer className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <span className="text-xs text-muted-foreground">{t("groups.key.summary", { keys: members.length, devices: reached })}</span>
                <Button variant="outline" size="sm" className="ml-auto" onClick={onGrant}>
                    <Send /> {t("groups.grant.add")}
                </Button>
            </footer>
        </article>
    );
}

/** 還沒有群組時 info 圖用的例子。/ The example the info diagram shows before there is a group. */
function exampleData(t: (k: "groups.example.group" | "groups.example.tunnelGroup") => string) {
    const tg: TunnelGroup = { id: -10, name: t("groups.example.tunnelGroup"), position: 0, tunnel_ids: [-1, -2], created_at: "" };
    const keys = [
        { id: -1, host_friendly_name: "MacBook", key_type: "ED25519", fingerprint: null },
        { id: -2, host_friendly_name: "ThinkPad", key_type: "ED25519", fingerprint: null },
    ] as UserKey[];
    const target = (status: string) => [{ username: "deploy", status, error: null }];
    const devices = [
        { tunnel_id: -1, host_friendly_name: "web-1", online: true, role: "owner", accounts: ["deploy", "ubuntu"], account_list: [], keys: [{ user_key_id: -1, accounts: null, targets: target("installed") }, { user_key_id: -2, accounts: null, targets: target("installed") }] },
        { tunnel_id: -2, host_friendly_name: "web-2", online: false, role: "owner", accounts: ["deploy"], account_list: [], keys: [] },
    ] as KeyDevice[];
    const group: KeyGroup = { id: -5, name: t("groups.example.group"), key_ids: [-1, -2], grants: [{ id: -7, tunnel: null, tunnel_group: { id: -10, name: tg.name }, accounts: ["deploy"], created_at: "" }], created_at: "" };
    return { tg, keys, devices, group };
}

function KeyGroupsInfo({ open, onClose, groups, keys, tunnelGroups, devices }: { open: boolean; onClose: () => void; groups: KeyGroup[]; keys: UserKey[]; tunnelGroups: TunnelGroup[]; devices: KeyDevice[] }) {
    const { t } = useI18n();
    const [picked, setPicked] = useState<number | null>(null);
    const example = useMemo(() => exampleData(t), [t]);
    // 預設先看已經授予出去的那組（圖上才有東西）。/ Default to a group that is given somewhere (so the picture shows something).
    const group = groups.find((g) => g.id === picked) ?? groups.find((g) => g.grants.length > 0) ?? groups[0];
    return (
        <Modal isOpen={open} onClose={onClose} title={t("groups.info.title")} description={t("groups.info.description")} icon={<CircleHelp />} size="4xl">
            <div className="space-y-5">
                <ul className="grid items-start gap-2 sm:grid-cols-3">
                    {[
                        { icon: KeyRound, text: t("groups.info.step1") },
                        { icon: Send, text: t("groups.info.step2") },
                        { icon: Layers, text: t("groups.info.step3") },
                    ].map(({ icon: Icon, text }) => (
                        <li key={text} className="flex gap-2 rounded-xl bg-surface p-3 text-sm leading-relaxed text-foreground ring-1 ring-border">
                            <Icon size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
                            <span>{text}</span>
                        </li>
                    ))}
                </ul>
                {group ? (
                    <section className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm text-foreground">{t("groups.info.yours")}</span>
                            {groups.length > 1 && (
                                <NativeSelect value={group.id} onChange={(e) => setPicked(Number(e.target.value))} aria-label={t("groups.info.pick")} className="w-56">
                                    {groups.map((g) => (
                                        <option key={g.id} value={g.id}>{g.name}</option>
                                    ))}
                                </NativeSelect>
                            )}
                        </div>
                        <KeyGroupFlow group={group} keys={keys} tunnelGroups={tunnelGroups} devices={devices} />
                    </section>
                ) : (
                    <section className="space-y-2">
                        <p className="text-sm text-muted-foreground">{t("groups.example.caption")}</p>
                        <KeyGroupFlow group={example.group} keys={example.keys} tunnelGroups={[example.tg]} devices={example.devices} />
                    </section>
                )}
            </div>
        </Modal>
    );
}

export function KeyGroupsSection({ api, keys, tunnelGroups, devices }: { api: KeyGroupsApi; keys: UserKey[]; tunnelGroups: TunnelGroup[]; devices: KeyDevice[] }) {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const [editor, setEditor] = useState<{ group: KeyGroup | null } | null>(null);
    const [granting, setGranting] = useState<KeyGroup | null>(null);
    const [deleting, setDeleting] = useState<KeyGroup | null>(null);
    const [info, setInfo] = useState(false);

    const save = async (name: string, ids: number[]): Promise<string | null> => {
        const g = editor?.group;
        if (!g) {
            const r = await api.create(name, ids);
            return r.ok ? null : (r.nameError ?? "");
        }
        if (name !== g.name) {
            const r = await api.rename(g.id, name);
            if (!r.ok) return r.nameError ?? "";
        }
        const same = ids.length === g.key_ids.length && ids.every((id) => g.key_ids.includes(id));
        if (!same && !(await api.setKeys(g.id, ids)).ok) return "";
        return null;
    };

    const deletingReach = deleting ? keyGroupReach(deleting, tunnelGroups).length : 0;

    return (
        <section aria-labelledby="keys-groups">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div id="keys-groups">
                    <h2 className="flex items-center gap-2 text-lg text-foreground">
                        {t("groups.key.title")}
                        {api.loaded && <span className="rounded-full bg-muted px-2 py-px font-mono text-xs text-muted-foreground">{api.groups.length}</span>}
                        <Button variant="ghost" size="icon-sm" onClick={() => setInfo(true)} aria-label={t("groups.key.howAria")} title={t("groups.key.howAria")} className="text-muted-foreground hover:text-primary">
                            <CircleHelp />
                        </Button>
                    </h2>
                    <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{t("groups.key.description")}</p>
                </div>
                <Button variant="outline" onClick={() => setEditor({ group: null })}>
                    <Plus /> {t("groups.new")}
                </Button>
            </div>
            {api.loaded && api.groups.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-input bg-card px-6 py-8 text-center">
                    <Layers size={28} className="text-muted-foreground/60" aria-hidden />
                    <p className="max-w-md text-sm text-muted-foreground">{t("groups.key.empty")}</p>
                    <Button size="sm" variant="outline" onClick={() => setInfo(true)}>
                        <CircleHelp /> {t("groups.key.howAria")}
                    </Button>
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                    {api.groups.map((g) => (
                        <KeyGroupCard
                            key={g.id}
                            group={g}
                            keys={keys}
                            tunnelGroups={tunnelGroups}
                            devices={devices}
                            onEdit={() => setEditor({ group: g })}
                            onDelete={() => setDeleting(g)}
                            onGrant={() => setGranting(g)}
                            onRevoke={async (gr) => {
                                const target = gr.tunnel_group?.name ?? gr.tunnel?.name ?? "";
                                if ((await api.revoke(g.id, gr.id)).ok) showSuccess(t("groups.grant.removed", { group: g.name, target }));
                            }}
                        />
                    ))}
                </div>
            )}

            {editor && <KeyGroupEditor group={editor.group} groups={api.groups} keys={keys} onClose={() => setEditor(null)} onSubmit={save} />}
            {granting && (
                <KeyGroupGrantDialog
                    group={api.groups.find((g) => g.id === granting.id) ?? granting}
                    keys={keys}
                    tunnelGroups={tunnelGroups}
                    devices={devices}
                    onClose={() => setGranting(null)}
                    onSubmit={async (target, accounts) => {
                        const r = await api.grant(granting.id, target, accounts);
                        if (r.ok) {
                            const name = "tunnel_group_id" in target ? tunnelGroups.find((g) => g.id === target.tunnel_group_id)?.name : devices.find((d) => d.tunnel_id === target.tunnel_id)?.host_friendly_name;
                            showSuccess(t("groups.grant.given", { group: granting.name, target: name ?? "" }));
                        }
                        return r.ok;
                    }}
                />
            )}
            <ConfirmDialog
                isOpen={!!deleting}
                onClose={() => setDeleting(null)}
                onConfirm={async () => {
                    if (deleting) await api.remove(deleting.id);
                    setDeleting(null);
                }}
                title={t("groups.key.deleteTitle")}
                message={deleting ? t("groups.key.deleteMessage", { name: deleting.name, count: deletingReach }) : ""}
                confirmText={t("common.delete")}
                isDestructive
            />
            <KeyGroupsInfo open={info} onClose={() => setInfo(false)} groups={api.groups} keys={keys} tunnelGroups={tunnelGroups} devices={devices} />
        </section>
    );
}
