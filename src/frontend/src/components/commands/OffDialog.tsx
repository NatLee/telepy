"use client";

/**
 * 在我管的隧道上關掉一條允許覆寫的全站規則：我所有的隧道（之後新增的也算）或勾選幾條；已經關掉的可以重新打開。
 * Turn an overridable site rule off on tunnels I own or administer: all of them (later ones too) or picked ones; one
 * already turned off can be turned back on.
 */
import React, { useState } from "react";
import { PowerOff } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import type { CommandRule, TunnelChoice } from "@/types/commandRules";
import { ActionChip } from "./RuleList";

interface Props {
    rule: CommandRule | null;
    onClose: () => void;
    /** 我是 owner / Admin 的隧道。/ Tunnels I own or administer. */
    tunnels: TunnelChoice[];
    onSave: (rule: CommandRule, target: { all_tunnels: boolean; tunnel_ids: number[] } | null) => Promise<boolean>;
}

export function OffDialog(props: Props) {
    return props.rule ? <OffForm key={props.rule.id} {...props} rule={props.rule} /> : null;
}

function OffForm({ rule, onClose, tunnels, onSave }: Props & { rule: CommandRule }) {
    const { t } = useI18n();
    const current = rule.my_override?.off ?? null;
    const [all, setAll] = useState(current ? current.all_tunnels : true);
    const [ids, setIds] = useState<number[]>(current && !current.all_tunnels ? current.tunnels.map((x) => x.id) : []);
    const [busy, setBusy] = useState(false);
    const toggle = (id: number) => setIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    const save = async (target: { all_tunnels: boolean; tunnel_ids: number[] } | null) => {
        setBusy(true);
        const ok = await onSave(rule, target);
        setBusy(false);
        if (ok) onClose();
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="md"
            icon={<PowerOff />}
            title={t("commands.override.dialogTitle")}
            description={t("commands.override.dialogDescription")}
            footer={
                <>
                    {current && (
                        <Button variant="ghost" className="mr-auto" onClick={() => void save(null)} disabled={busy}>
                            {t("commands.override.turnBackOn")}
                        </Button>
                    )}
                    <Button variant="outline" onClick={onClose} disabled={busy}>
                        {t("common.cancel")}
                    </Button>
                    <Button onClick={() => void save({ all_tunnels: all, tunnel_ids: all ? [] : ids })} disabled={busy || (!all && ids.length === 0)}>
                        {t("common.save")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <p className="flex flex-wrap items-center gap-1.5">
                    <ActionChip action={rule.action} />
                    <code className="font-mono text-sm text-foreground [overflow-wrap:anywhere]">{rule.pattern}</code>
                </p>
                <Field label={t("commands.form.scope")} hint={all ? t("commands.override.allMineHint") : t("commands.form.someHint")}>
                    <Segmented
                        size="sm"
                        value={all ? "all" : "some"}
                        onChange={(v) => setAll(v === "all")}
                        options={[
                            { value: "all", label: t("commands.override.allMine") },
                            { value: "some", label: t("commands.form.someTunnels") },
                        ]}
                        aria-label={t("commands.form.scope")}
                    />
                </Field>
                {!all && (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                        {tunnels.map((x) => (
                            <li key={x.id}>
                                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/40">
                                    <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={ids.includes(x.id)} onChange={() => toggle(x.id)} />
                                    <span className="min-w-0 flex-1 text-sm text-foreground [overflow-wrap:anywhere]">{x.name}</span>
                                </label>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </Modal>
    );
}
