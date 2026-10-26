"use client";

/**
 * 檔案管理的小對話框：取名（新資料夾 / 新檔案 / 改名）、刪除確認（先數裡面有多少再問）、搬移 / 複製到…、
 * 權限（rwx 勾選 ⇄ 八進位）、詳細資訊（stat）。
 * The file manager's small dialogs: name (new folder / file, rename), delete confirmation (counts first), move / copy
 * to…, permissions (rwx ⇄ octal) and details (stat).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Copy, FilePlus2, FolderInput, FolderPlus, Info, KeyRound, Loader2, Pencil, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Callout } from "@/components/ui/callout";
import { Chip, Property, PropertyList } from "@/components/ui/section";
import { useI18n } from "@/lib/i18n";
import { bitsToMode, formatBytes, modeBits, modeOctal, parseMode, PERM_WHO, validName, type PermBits, type PermWho } from "@/lib/fileManager";
import type { FileStat, OpResult, Tally } from "@/hooks/useFileOps";

// ---------------------------------------------------------------- name

export type NameKind = "mkdir" | "touch" | "rename";

const NAME_COPY: Record<NameKind, { title: "files.new.folder" | "files.new.file" | "files.rename.title"; icon: React.ReactNode; action: "files.new.create" | "files.rename.action" }> = {
    mkdir: { title: "files.new.folder", icon: <FolderPlus />, action: "files.new.create" },
    touch: { title: "files.new.file", icon: <FilePlus2 />, action: "files.new.create" },
    rename: { title: "files.rename.title", icon: <Pencil />, action: "files.rename.action" },
};

export function NameDialog({ kind, initial, taken, onClose, onSubmit }: { kind: NameKind | null; initial: string; taken: string[]; onClose: () => void; onSubmit: (name: string) => Promise<boolean> }) {
    const { t } = useI18n();
    const [name, setName] = useState(initial);
    const [busy, setBusy] = useState(false);
    // 換了對象就重設（render 時調整，不用 effect）。/ Reset when the target changes (adjusted during render).
    const key = `${kind}:${initial}`;
    const [seen, setSeen] = useState(key);
    if (seen !== key) {
        setSeen(key);
        setName(initial);
        setBusy(false);
    }
    const trimmed = name.trim();
    const error = !trimmed
        ? null
        : !validName(trimmed)
            ? t("files.err.invalid_name")
            : trimmed !== initial && taken.includes(trimmed)
                ? t("files.err.exists")
                : null;
    const can = !!trimmed && !error && !(kind === "rename" && trimmed === initial) && !busy;
    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!can) return;
        setBusy(true);
        const ok = await onSubmit(trimmed);
        setBusy(false);
        if (ok) onClose();
    };
    const copy = kind ? NAME_COPY[kind] : NAME_COPY.mkdir;
    return (
        <Modal
            isOpen={kind !== null}
            onClose={onClose}
            title={t(copy.title)}
            icon={copy.icon}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button onClick={() => void submit()} disabled={!can}>
                        {busy && <Loader2 size={15} className="animate-spin" />} {t(copy.action)}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit}>
                <Field label={t("files.name")} error={error} hint={kind === "touch" ? t("files.new.fileHint") : undefined}>
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        autoFocus
                        className="font-mono"
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        onFocus={(e) => {
                            // 改名時先選檔名、不含副檔名（和桌面檔案管理員一樣）。/ Select the stem first, like desktop file managers.
                            const dot = e.target.value.lastIndexOf(".");
                            if (kind === "rename" && dot > 0) e.target.setSelectionRange(0, dot);
                            else e.target.select();
                        }}
                    />
                </Field>
            </form>
        </Modal>
    );
}

// ---------------------------------------------------------------- delete

export function DeleteDialog({ names, onClose, count, onConfirm }: { names: string[] | null; onClose: () => void; count: (names: string[]) => Promise<OpResult<Tally>>; onConfirm: (names: string[]) => Promise<boolean> }) {
    const { t } = useI18n();
    const [tally, setTally] = useState<Tally | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [seen, setSeen] = useState(names);
    if (seen !== names) {
        setSeen(names);
        setTally(null);
        setError(null);
        setBusy(false);
    }
    useEffect(() => {
        if (!names?.length) return;
        let cancelled = false;
        void count(names).then((r) => {
            if (cancelled) return;
            if (r.ok && r.data) setTally(r.data);
            else setError(r.message);
        });
        return () => {
            cancelled = true;
        };
    }, [names, count]);
    const open = !!names?.length;
    const shown = names?.slice(0, 5) ?? [];
    const more = (names?.length ?? 0) - shown.length;
    return (
        <Modal
            isOpen={open}
            onClose={onClose}
            title={names?.length === 1 ? t("files.delete.titleOne", { name: names[0] }) : t("files.delete.title", { count: names?.length ?? 0 })}
            icon={<Trash2 />}
            tone="danger"
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button
                        variant="destructive"
                        disabled={!tally || busy}
                        onClick={async () => {
                            if (!names) return;
                            setBusy(true);
                            const ok = await onConfirm(names);
                            setBusy(false);
                            if (ok) onClose();
                        }}
                    >
                        {busy && <Loader2 size={15} className="animate-spin" />} {t("common.delete")}
                    </Button>
                </>
            }
        >
            <div className="space-y-3 text-sm">
                <ul className="space-y-1">
                    {shown.map((n) => (
                        <li key={n} className="truncate font-mono text-foreground" title={n}>{n}</li>
                    ))}
                    {more > 0 && <li className="text-muted-foreground">{t("files.delete.andMore", { count: more })}</li>}
                </ul>
                {error ? (
                    <Callout tone="danger">{error}</Callout>
                ) : !tally ? (
                    <p className="flex items-center gap-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" /> {t("files.delete.counting")}</p>
                ) : (
                    <Callout tone="danger" title={tally.truncated ? t("files.delete.summaryMore", { count: tally.entries.toLocaleString() }) : t("files.delete.summary", { count: tally.entries.toLocaleString() })}>
                        {t("files.delete.breakdown", { files: tally.files, dirs: tally.dirs, size: formatBytes(tally.bytes) })}
                        {tally.links > 0 && <> · {t("files.delete.links", { links: tally.links })}</>}
                        <span className="mt-1 block">{t("files.delete.noUndo")}</span>
                    </Callout>
                )}
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------- move / copy to

export function DestinationDialog({ mode, names, initial, onClose, onSubmit }: { mode: "move" | "copy" | null; names: string[]; initial: string; onClose: () => void; onSubmit: (dest: string) => Promise<boolean> }) {
    const { t } = useI18n();
    const [dest, setDest] = useState(initial);
    const [busy, setBusy] = useState(false);
    const key = `${mode}:${initial}`;
    const [seen, setSeen] = useState(key);
    if (seen !== key) {
        setSeen(key);
        setDest(initial);
        setBusy(false);
    }
    const submit = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!dest.trim() || busy) return;
        setBusy(true);
        const ok = await onSubmit(dest.trim());
        setBusy(false);
        if (ok) onClose();
    };
    const copy = mode === "copy";
    return (
        <Modal
            isOpen={mode !== null}
            onClose={onClose}
            title={t(copy ? "files.copy.title" : "files.move.title", { count: names.length })}
            icon={copy ? <Copy /> : <FolderInput />}
            size="lg"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button onClick={() => void submit()} disabled={!dest.trim() || busy}>
                        {busy && <Loader2 size={15} className="animate-spin" />} {t(copy ? "files.copy.action" : "files.move.action")}
                    </Button>
                </>
            }
        >
            <form onSubmit={submit} className="space-y-3">
                <Field label={t("files.move.destination")} hint={t("files.move.hint")}>
                    <Input value={dest} onChange={(e) => setDest(e.target.value)} autoFocus className="font-mono" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
                </Field>
                {copy && <Callout tone="info">{t("files.copy.how")}</Callout>}
                <p className="truncate text-xs text-muted-foreground" title={names.join(", ")}>{names.join(", ")}</p>
            </form>
        </Modal>
    );
}

// ---------------------------------------------------------------- permissions

const WHO_LABEL: Record<PermWho, "files.perm.user" | "files.perm.group" | "files.perm.other"> = { user: "files.perm.user", group: "files.perm.group", other: "files.perm.other" };
const BIT_LABEL: { bit: keyof PermBits; key: "files.perm.read" | "files.perm.write" | "files.perm.exec" }[] = [
    { bit: "read", key: "files.perm.read" },
    { bit: "write", key: "files.perm.write" },
    { bit: "exec", key: "files.perm.exec" },
];

export function ChmodDialog({ names, initialMode, hasFolder, onClose, onSubmit }: { names: string[] | null; initialMode: number | null; hasFolder: boolean; onClose: () => void; onSubmit: (mode: string, recursive: boolean) => Promise<boolean> }) {
    const { t } = useI18n();
    const [octal, setOctal] = useState(modeOctal(initialMode ?? 0o644));
    const [recursive, setRecursive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [seen, setSeen] = useState(names);
    if (seen !== names) {
        setSeen(names);
        setOctal(modeOctal(initialMode ?? 0o644));
        setRecursive(false);
        setBusy(false);
    }
    const mode = parseMode(octal);
    const bits = useMemo(() => modeBits(mode ?? 0), [mode]);
    const toggle = (who: PermWho, bit: keyof PermBits) => {
        const next = { ...bits, [who]: { ...bits[who], [bit]: !bits[who][bit] } };
        setOctal(modeOctal(bitsToMode(next, mode ?? 0)));
    };
    return (
        <Modal
            isOpen={!!names?.length}
            onClose={onClose}
            title={t("files.perm.title")}
            description={names && names.length === 1 ? names[0] : t("files.selected", { count: names?.length ?? 0 })}
            icon={<KeyRound />}
            size="md"
            footer={
                <>
                    <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
                    <Button
                        disabled={mode === null || busy}
                        onClick={async () => {
                            setBusy(true);
                            const ok = await onSubmit(octal, recursive);
                            setBusy(false);
                            if (ok) onClose();
                        }}
                    >
                        {busy && <Loader2 size={15} className="animate-spin" />} {t("common.save")}
                    </Button>
                </>
            }
        >
            <div className="space-y-4">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-xs text-muted-foreground">
                            <th className="py-1 text-left font-normal" />
                            {BIT_LABEL.map((b) => <th key={b.bit} className="py-1 font-normal">{t(b.key)}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {PERM_WHO.map((who) => (
                            <tr key={who} className="border-t border-border">
                                <td className="py-2 text-foreground">{t(WHO_LABEL[who])}</td>
                                {BIT_LABEL.map((b) => (
                                    <td key={b.bit} className="py-2 text-center">
                                        <input
                                            type="checkbox"
                                            className="size-4 accent-(--primary)"
                                            checked={bits[who][b.bit]}
                                            onChange={() => toggle(who, b.bit)}
                                            aria-label={`${t(WHO_LABEL[who])} ${t(b.key)}`}
                                        />
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                <Field label={t("files.perm.octal")} error={mode === null ? t("files.err.invalid_mode") : undefined}>
                    <Input value={octal} onChange={(e) => setOctal(e.target.value)} className="w-32 font-mono" inputMode="numeric" maxLength={5} />
                </Field>
                {hasFolder && (
                    <Switch checked={recursive} onCheckedChange={setRecursive} size="sm">
                        <span className="text-sm">{t("files.perm.recursive")}</span>
                    </Switch>
                )}
                <p className="text-xs text-muted-foreground">{t("files.perm.note")}</p>
            </div>
        </Modal>
    );
}

// ---------------------------------------------------------------- details

export function DetailsDialog({ name, account, load, onClose }: { name: string | null; account: string; load: (name: string) => Promise<OpResult<FileStat>>; onClose: () => void }) {
    const { t, locale } = useI18n();
    const [stat, setStat] = useState<FileStat | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [seen, setSeen] = useState(name);
    if (seen !== name) {
        setSeen(name);
        setStat(null);
        setError(null);
    }
    useEffect(() => {
        if (!name) return;
        let cancelled = false;
        void load(name).then((r) => {
            if (cancelled) return;
            if (r.ok && r.data) setStat(r.data);
            else setError(r.message);
        });
        return () => {
            cancelled = true;
        };
    }, [name, load]);
    const typeKey = stat?.type === "directory" ? "files.type.directory" : stat?.type === "symlink" ? "files.type.symlink" : "files.type.file";
    return (
        <Modal isOpen={!!name} onClose={onClose} title={name ?? ""} description={t("files.details.description", { account })} icon={<Info />} size="lg" isLoading={!!name && !stat && !error} footer={<Button onClick={onClose}>{t("common.close")}</Button>}>
            {error ? (
                <Callout tone="danger">{error}</Callout>
            ) : stat ? (
                <PropertyList>
                    <Property label={t("files.details.path")} mono>{stat.path}</Property>
                    <Property label={t("files.details.type")}>{t(typeKey)}</Property>
                    {stat.type === "symlink" && (
                        <Property label={t("files.details.target")} mono>
                            {stat.link_target ?? "?"} {stat.target_type === "missing" && <Chip tone="warning">{t("files.details.broken")}</Chip>}
                        </Property>
                    )}
                    <Property label={t("files.details.size")}>{formatBytes(stat.size)} <span className="text-muted-foreground">({stat.size.toLocaleString(locale)} B)</span></Property>
                    <Property label={t("files.details.permissions")} mono>{stat.mode} · {stat.permissions}</Property>
                    <Property label={t("files.details.owner")} mono>{t("files.details.ids", { uid: stat.uid ?? "?", gid: stat.gid ?? "?" })}</Property>
                    <Property label={t("files.details.modified")}>{stat.mtime ? new Date(stat.mtime).toLocaleString(locale) : "—"}</Property>
                </PropertyList>
            ) : null}
        </Modal>
    );
}
