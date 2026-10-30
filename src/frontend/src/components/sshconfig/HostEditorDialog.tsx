"use client";

/**
 * 一台主機的表單（也用來新增）：名稱、HostName / User / Port / ProxyJump、IdentityFile（自己的幾行 + 繼承的唯讀）、其他選項、
 * 加一個選項。欄位空著 = 用繼承的（灰字提示是誰給的）；打了值 = 寫進它自己的區塊、放在 ssh 先讀到的地方
 * （lib/sshConfigEdit.applyHostDraft）。下面即時列出「會讓哪個名稱的哪個設定怎麼變」，刪除也先看會剩下什麼。
 * One host's form (also for adding): name, HostName / User / Port / ProxyJump, IdentityFile (its own lines +
 * inherited ones read-only), other options, and adding one. An empty field = inherited (the grey hint says from
 * where); a value = written into its own block where ssh reads it first (lib/sshConfigEdit.applyHostDraft). Below,
 * live, which setting of which name changes; deleting first shows what is left.
 */
import React, { useMemo, useState } from "react";
import { Layers, Plus, Server, Trash2, Undo2, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Section } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import type { TranslationKey } from "@/locales/en";
import { applyHostDraft, effectChanges, hostTable, inheritedRow, removeHost, spell, type Cell, type EditError, type HostDraft, type HostRow } from "@/lib/sshConfigEdit";
import { slotOf, stacks } from "@/lib/sshConfigTidy";
import { EffectList } from "./EffectList";

type T = ReturnType<typeof useI18n>["t"];

/** 編輯錯誤的說明。/ An edit error as a sentence. */
export function editErrorText(e: EditError, t: T): string {
    switch (e.code) {
        case "global":
            return t("tidy.err.global", { line: e.line, key: e.key });
        case "bad_value":
            return t("tidy.err.badValue", { key: e.key });
        case "no_effect":
            return t("tidy.err.noEffect", { key: e.key });
        default:
            return t(`tidy.err.${e.code === "bad_name" ? "badName" : e.code === "not_found" ? "notFound" : e.code}` as TranslationKey);
    }
}

const MAIN = ["HostName", "User", "Port", "ProxyJump"] as const;
const PLACEHOLDER: Record<string, TranslationKey> = { hostname: "tidy.edit.phHostName", user: "tidy.edit.phUser", port: "tidy.edit.phPort", proxyjump: "tidy.edit.phProxyJump" };

/** 這個值從哪裡來（一行字）。/ Where a value comes from, as one line. */
function sourceText(c: Cell | undefined, t: T): string {
    if (!c) return t("tidy.edit.fromDefault");
    if (c.own) return t("tidy.edit.fromOwn", { line: c.n });
    if (!c.header) return t("tidy.edit.fromGlobal", { line: c.n });
    return t("tidy.edit.fromShared", { line: c.n, header: c.header });
}

interface Props {
    text: string;
    /** 要改的主機；null = 新增。/ The host to edit; null = add one. */
    host: string | null;
    onClose: () => void;
    onApply: (next: string) => void;
}

export function HostEditorDialog({ text, host, onClose, onApply }: Props) {
    const { t } = useI18n();
    const row: HostRow | null = useMemo(() => (host ? (hostTable(text).rows.find((r) => r.name === host) ?? null) : null), [text, host]);
    const inherited = useMemo(() => (host ? inheritedRow(text, host) : null), [text, host]);
    // 欄位的起始值 = 它自己區塊裡的值（沒有就空，代表繼承）。/ A field starts with the host's own value (empty = inherited).
    const initial = useMemo(() => {
        const vals: Record<string, string> = {};
        for (const [slot, c] of Object.entries(row?.cells ?? {})) if (c.own) vals[slot] = c.edit;
        // 累加的選項（IdentityFile、LocalForward…）：自己的那幾行。/ Stacked options: the host's own lines.
        const lists: Record<string, string[]> = { identityfile: [] };
        for (const [slot, cells] of Object.entries(row?.stacks ?? {})) lists[slot] = cells.filter((c) => c.own).map((c) => c.edit);
        return { vals, lists };
    }, [row]);
    const [name, setName] = useState(host ?? "");
    const [vals, setVals] = useState<Record<string, string>>(initial.vals);
    const [keys, setKeys] = useState<Record<string, string>>({});
    const [lists, setLists] = useState<Record<string, string[]>>(initial.lists);
    const [newKey, setNewKey] = useState("");
    const [newValue, setNewValue] = useState("");
    const [deleting, setDeleting] = useState(false);

    const otherSlots = Object.keys(row?.cells ?? {}).filter((s) => !MAIN.some((m) => slotOf(m) === s));
    const extraSlots = Object.keys(vals).filter((s) => !MAIN.some((m) => slotOf(m) === s) && !otherSlots.includes(s));
    const keyOf = (slot: string) => keys[slot] ?? row?.cells[slot]?.key ?? spell(slot);

    const draft: HostDraft = useMemo(() => {
        const set: Record<string, string> = {};
        const clear: string[] = [];
        for (const slot of new Set([...Object.keys(vals), ...Object.keys(initial.vals)])) {
            const now = (vals[slot] ?? "").trim();
            const was = initial.vals[slot] ?? "";
            if (now === was) continue;
            if (now === "") clear.push(keyOf(slot));
            else set[keyOf(slot)] = now;
        }
        const changedLists: Record<string, string[]> = {};
        for (const [slot, list] of Object.entries(lists)) {
            const cleaned = list.map((v) => v.trim()).filter(Boolean);
            if (cleaned.join("\n") !== (initial.lists[slot] ?? []).join("\n")) changedLists[keyOf(slot)] = cleaned;
        }
        return { name: name.trim(), set, clear, lists: changedLists };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vals, lists, name, initial, keys]);

    const dirty = host === null ? draft.name !== "" : draft.name !== host || Object.keys(draft.set).length > 0 || draft.clear.length > 0 || Object.keys(draft.lists).length > 0;
    const result = useMemo(() => (dirty ? applyHostDraft(text, host, draft) : null), [dirty, text, host, draft]);
    const renamed = useMemo(() => (host && draft.name && draft.name !== host ? { from: host, to: draft.name } : undefined), [host, draft.name]);
    const changes = useMemo(() => (result?.text !== undefined ? effectChanges(text, result.text, renamed) : []), [text, result, renamed]);
    const removal = useMemo(() => (deleting && host ? removeHost(text, host) : null), [deleting, text, host]);
    const removalChanges = useMemo(() => (removal?.text !== undefined ? effectChanges(text, removal.text) : []), [text, removal]);

    const field = (key: string) => {
        const slot = slotOf(key);
        const own = row?.cells[slot]?.own ? row.cells[slot] : undefined;
        const from = inherited?.cells[slot];
        const v = vals[slot] ?? "";
        return (
            <Field
                key={slot}
                label={<span className="font-mono">{keyOf(slot)}</span>}
                hint={v.trim() === "" ? sourceText(from, t) + (from ? ` · ${from.value}` : "") : own && v === own.edit ? sourceText(own, t) : t("tidy.edit.willSet", { header: `Host ${draft.name || host || "…"}` })}
                addon={
                    v !== "" ? (
                        <button type="button" onClick={() => setVals((x) => ({ ...x, [slot]: "" }))} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                            <Undo2 size={12} /> {t("tidy.edit.inherit")}
                        </button>
                    ) : undefined
                }
            >
                <Input
                    value={v}
                    placeholder={from ? from.value : PLACEHOLDER[slot] ? t(PLACEHOLDER[slot]) : ""}
                    onChange={(e) => setVals((x) => ({ ...x, [slot]: e.target.value }))}
                    className="font-mono"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                />
            </Field>
        );
    };

    const save = () => {
        if (result?.text !== undefined) onApply(result.text);
    };

    return (
        <Modal
            isOpen
            onClose={onClose}
            size="3xl"
            icon={<Server />}
            title={host ? t("tidy.edit.title", { name: host }) : t("tidy.edit.addTitle")}
            description={t("tidy.edit.description")}
            footer={
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                    <div>
                        {host && !deleting && (
                            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDeleting(true)}>
                                <Trash2 size={15} /> {t("tidy.edit.delete")}
                            </Button>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                        {deleting ? (
                            <Button variant="destructive" disabled={removal?.text === undefined} onClick={() => removal?.text !== undefined && onApply(removal.text)}>
                                <Trash2 size={15} /> {t("tidy.edit.deleteConfirm", { name: host ?? "" })}
                            </Button>
                        ) : (
                            <Button disabled={!dirty || result?.text === undefined} onClick={save}>{host ? t("common.save") : t("tidy.edit.add")}</Button>
                        )}
                    </div>
                </div>
            }
        >
            {deleting ? (
                <div className="space-y-3">
                    <Callout tone="warning" title={t("tidy.edit.deleteTitle", { name: host ?? "" })}>{t("tidy.edit.deleteBody")}</Callout>
                    {removal?.error ? <Callout tone="danger">{editErrorText(removal.error, t)}</Callout> : <EffectList changes={removalChanges} />}
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(false)}>{t("tidy.edit.keep")}</Button>
                </div>
            ) : (
                <div className="space-y-6">
                    {row?.telepy && <Callout tone="info">{t("tidy.edit.telepy")}</Callout>}
                    <Field label={t("tidy.edit.name")} hint={host ? t("tidy.edit.nameHint") : t("tidy.edit.newNameHint")}>
                        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={row?.telepy} className="font-mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" autoFocus={host === null} />
                    </Field>
                    <div className="grid gap-4 sm:grid-cols-2">{MAIN.map((k) => field(k))}</div>

                    {Object.keys(lists).map((slot) => {
                        const own = lists[slot];
                        const from = (inherited?.stacks[slot] ?? []).filter((c) => !c.own);
                        const set = (next: string[]) => setLists((x) => ({ ...x, [slot]: next }));
                        return (
                            <Section key={slot} title={<span className="font-mono">{keyOf(slot)}</span>} description={t("tidy.edit.stackHint")}>
                                <div className="space-y-2">
                                    {own.map((v, i) => (
                                        <div key={i} className="flex gap-2">
                                            <Input value={v} onChange={(e) => set(own.map((y, j) => (j === i ? e.target.value : y)))} className="font-mono" spellCheck={false} aria-label={`${keyOf(slot)} ${i + 1}`} />
                                            <Button variant="ghost" size="icon" onClick={() => set(own.filter((_, j) => j !== i))} aria-label={t("tidy.edit.removeLine")}>
                                                <X size={15} />
                                            </Button>
                                        </div>
                                    ))}
                                    <Button variant="outline" size="sm" onClick={() => set([...own, ""])}>
                                        <Plus size={15} /> {t("tidy.edit.addLine", { key: keyOf(slot) })}
                                    </Button>
                                    {from.length > 0 && (
                                        <ul className="space-y-0.5 text-[0.8125rem]">
                                            {from.map((c) => (
                                                <li key={`${c.n}`} className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground">
                                                    <Layers size={12} className="translate-y-0.5" aria-hidden />
                                                    <code className="font-mono text-foreground">{c.value}</code>
                                                    <span className="text-xs">{sourceText(c, t)}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            </Section>
                        );
                    })}

                    {(otherSlots.length > 0 || extraSlots.length > 0) && (
                        <Section title={t("tidy.edit.more")}>
                            <div className="grid gap-4 sm:grid-cols-2">{[...otherSlots, ...extraSlots].map((s) => field(keyOf(s)))}</div>
                        </Section>
                    )}

                    <Section title={t("tidy.edit.addOption")}>
                        <div className="flex flex-col gap-2 sm:flex-row">
                            <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="ForwardAgent" className="font-mono sm:w-56" spellCheck={false} aria-label={t("tidy.edit.optionName")} />
                            <Input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="yes" className="font-mono" spellCheck={false} aria-label={t("tidy.edit.optionValue")} />
                            <Button
                                variant="outline"
                                disabled={!/^[A-Za-z][A-Za-z0-9]*$/.test(newKey.trim()) || !newValue.trim() || ["host", "match", "include"].includes(newKey.trim().toLowerCase())}
                                onClick={() => {
                                    const slot = slotOf(newKey.trim());
                                    setKeys((k) => ({ ...k, [slot]: k[slot] ?? newKey.trim() }));
                                    if (stacks(slot)) setLists((x) => ({ ...x, [slot]: [...(x[slot] ?? []), newValue.trim()] }));
                                    else {
                                        setKeys((k) => ({ ...k, [slot]: newKey.trim() }));
                                        setVals((x) => ({ ...x, [slot]: newValue.trim() }));
                                    }
                                    setNewKey("");
                                    setNewValue("");
                                }}
                            >
                                <Plus size={15} /> {t("tidy.edit.addOptionButton")}
                            </Button>
                        </div>
                    </Section>

                    <Section title={t("tidy.edit.whatChanges")}>
                        {result?.error ? <Callout tone="warning">{editErrorText(result.error, t)}</Callout> : dirty ? <EffectList changes={changes} renamed={renamed} /> : <p className="text-sm text-muted-foreground">{t("tidy.edit.nothingYet")}</p>}
                    </Section>
                </div>
            )}
        </Modal>
    );
}
